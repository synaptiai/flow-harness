import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type { CommandSandbox } from "../../application/command-sandbox.js";
import {
  calculateFrozenIssueVerificationCommandDigest,
  type FrozenIssueVerificationCommand,
} from "../../application/frozen-issue-command.js";
import type { NodeExecutionOutcome } from "../../application/ports.js";
import { normalizeAgentCommandRequest } from "../../domain/agent-command.js";
import { MAX_AGENT_COMMAND_OUTPUT_BYTES } from "../../domain/command-envelope.js";
import type { CommandEvidence, SandboxEvidence } from "../../domain/run/events.js";
import { CommandNodeExecutor } from "../process/command-node-executor.js";
import { createProductionCommandSandbox } from "../runtime/production-node-executor.js";
import { FLOW_SANDBOX_POLICY_DIGEST } from "../sandbox/srt-command-sandbox.js";

export interface LinuxObserverCommandRequest {
  readonly command: FrozenIssueVerificationCommand;
  readonly cwd: string;
  readonly protectedPaths: readonly string[];
  readonly runtimeSupportPaths: readonly string[];
  readonly maxOutputBytes: number;
  readonly preparationSettlementMs: number;
  readonly identity: {
    readonly runId: string;
    readonly workflowId: string;
    readonly nodeId: string;
    readonly attempt: number;
  };
  readonly signal?: AbortSignal;
}

const pinnedSandbox = Object.freeze({
  backend: "anthropic-sandbox-runtime",
  backendVersion: "0.0.70",
  profile: "workspace-write-network-deny-v1",
  policyDigest: FLOW_SANDBOX_POLICY_DIGEST,
} as const);

type UnsupportedReason =
  | "invalid_request"
  | "unsupported_platform"
  | "cancelled"
  | "preparation_timeout"
  | "execution_error"
  | "sandbox_unqualified"
  | "sandbox_release_unconfirmed"
  | "command_not_completed"
  | "invalid_command_evidence";

export type LinuxObserverCommandObservation =
  | {
      readonly kind: "completed";
      readonly outcome: NodeExecutionOutcome;
      readonly commandDigest: string;
      readonly custody: typeof pinnedSandbox & {
        readonly processContainment: "linux-pid-namespace";
        readonly exitStatusEncoding: "shell";
        readonly release: "succeeded";
      };
    }
  | {
      readonly kind: "unsupported";
      readonly reason: UnsupportedReason;
      readonly outcome: NodeExecutionOutcome | null;
    };

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const canonicalPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      Buffer.byteLength(path, "utf8") <= 4096 &&
      !path.includes("\0") &&
      isAbsolute(path) &&
      resolve(path) === path,
  );
const paths = z
  .array(canonicalPath)
  .max(256)
  .refine((items) => new Set(items).size === items.length);
const requestSchema = z
  .object({
    command: z
      .object({ executable: z.string(), args: z.array(z.string()), timeoutMs: z.number() })
      .strict(),
    cwd: canonicalPath,
    protectedPaths: paths,
    runtimeSupportPaths: paths,
    maxOutputBytes: z.number().int().min(1).max(MAX_AGENT_COMMAND_OUTPUT_BYTES),
    preparationSettlementMs: z.number().int().min(1).max(65_000),
    identity: z
      .object({
        runId: identifier,
        workflowId: identifier,
        nodeId: identifier,
        attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

/**
 * Internal trusted-host command custody, not a behavioral verification receipt.
 * Empty scopes are deliberate: fixture correctness, overlap, disclosure policy,
 * durable reservation and repair authority belong to the calling observer.
 * Raw executor outcomes are never rewritten, including normal nonzero failures.
 * Completion proves outer command capture/release, not that the inner application
 * launched or exited normally. Bubblewrap can encode a signal as 128 + signal;
 * setup failures and application failures can also share the same numeric exit.
 * https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L409-L455
 */
export async function executeLinuxObserverCommand(
  request: LinuxObserverCommandRequest,
): Promise<LinuxObserverCommandObservation> {
  let frozen: LinuxObserverCommandRequest;
  try {
    // Parse, detach and freeze every value before the first asynchronous path lookup.
    const parsed = requestSchema.parse(request);
    const command = normalizeAgentCommandRequest({ version: 1, ...parsed.command });
    frozen = Object.freeze({
      cwd: parsed.cwd,
      maxOutputBytes: parsed.maxOutputBytes,
      preparationSettlementMs: parsed.preparationSettlementMs,
      command: Object.freeze({
        executable: command.executable,
        args: Object.freeze([...command.args]),
        timeoutMs: command.timeoutMs,
      }),
      protectedPaths: Object.freeze([...parsed.protectedPaths]),
      runtimeSupportPaths: Object.freeze([...parsed.runtimeSupportPaths]),
      identity: Object.freeze({ ...parsed.identity }),
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal }),
    });
  } catch {
    return unsupported("invalid_request");
  }
  if (frozen.signal?.aborted) return unsupported("cancelled");
  const pathAdmission = await admitPaths(frozen);
  if (pathAdmission !== "ready") return unsupported(pathAdmission);
  if (frozen.signal?.aborted) return unsupported("cancelled");
  if (process.platform !== "linux" || process.arch !== "x64")
    return unsupported("unsupported_platform");

  let preparations = 0;
  let admissions = 0;
  let releases = 0;
  let releaseSucceeded = false;
  let admittedEvidence: typeof pinnedSandbox | undefined;
  let outcome: NodeExecutionOutcome | null = null;
  try {
    const production = createProductionCommandSandbox("native", frozen.cwd);
    const sandbox: CommandSandbox = {
      async prepare(input) {
        preparations += 1;
        const prepared = await production.prepare({
          ...input,
          runtimeSupportPaths: frozen.runtimeSupportPaths,
        });
        admissions += 1;
        const release = async () => {
          releases += 1;
          releaseSucceeded = false;
          await prepared.release();
          releaseSucceeded = true;
        };
        if (
          prepared.processContainment !== "linux-pid-namespace" ||
          !isPinnedSandbox(prepared.evidence)
        ) {
          await release();
          throw new Error("Unqualified observer command sandbox");
        }
        admittedEvidence = Object.freeze({ ...prepared.evidence });
        return { ...prepared, release };
      },
    };
    const executor = new CommandNodeExecutor({
      sandbox,
      maxOutputBytes: frozen.maxOutputBytes,
      preparationSettlementMs: frozen.preparationSettlementMs,
    });
    outcome = await executor.execute(
      {
        id: frozen.identity.nodeId,
        type: "command",
        dependsOn: [],
        command: frozen.command,
      },
      {
        ...frozen.identity,
        cwd: frozen.cwd,
        projectRoot: frozen.cwd,
        protectedPaths: frozen.protectedPaths,
        ...(frozen.signal === undefined ? {} : { signal: frozen.signal }),
      },
    );
  } catch {
    return unsupported("execution_error", outcome);
  }
  // An admitted but unqualified preparation still owns resources: failed release
  // must dominate its qualification label, even if the executor reports no effects.
  if (admissions > 0 && (releases !== 1 || !releaseSucceeded))
    return unsupported("sandbox_release_unconfirmed", outcome);
  if (preparations !== 1 || admissions !== 1 || admittedEvidence === undefined) {
    return unsupported("sandbox_unqualified", outcome);
  }
  if (releases !== 1 || !releaseSucceeded)
    return unsupported("sandbox_release_unconfirmed", outcome);
  if (frozen.signal?.aborted) return unsupported("cancelled", outcome);
  if (outcome.status === "failed" && outcome.error.code !== "command_failed") {
    return unsupported("command_not_completed", outcome);
  }
  if (!usableEvidence(outcome, frozen)) return unsupported("invalid_command_evidence", outcome);
  return Object.freeze({
    kind: "completed",
    outcome,
    commandDigest: calculateFrozenIssueVerificationCommandDigest(frozen.command),
    custody: Object.freeze({
      ...admittedEvidence,
      processContainment: "linux-pid-namespace",
      exitStatusEncoding: "shell",
      release: "succeeded",
    }),
  });
}

async function admitPaths(
  request: LinuxObserverCommandRequest,
): Promise<"ready" | "invalid_request" | "cancelled" | "preparation_timeout"> {
  type Result = "ready" | "invalid_request" | "cancelled" | "preparation_timeout";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<Result>((complete) => {
    timer = setTimeout(() => {
      stopped = true;
      complete("preparation_timeout");
    }, request.preparationSettlementMs);
    onAbort = () => {
      stopped = true;
      complete("cancelled");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
  });
  const observed = (async (): Promise<Result> => {
    for (const path of [request.cwd, ...request.protectedPaths, ...request.runtimeSupportPaths]) {
      if (stopped) return "cancelled";
      if ((await realpath(path)) !== path) return "invalid_request";
      if (stopped) return "cancelled";
      const metadata = await lstat(path);
      if (
        (!metadata.isDirectory() && !metadata.isFile()) ||
        (path === request.cwd && !metadata.isDirectory())
      )
        return "invalid_request";
    }
    return "ready";
  })().catch((): Result => "invalid_request");
  try {
    return await Promise.race([interrupted, observed]);
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) request.signal?.removeEventListener("abort", onAbort);
  }
}

function unsupported(
  reason: UnsupportedReason,
  outcome: NodeExecutionOutcome | null = null,
): LinuxObserverCommandObservation {
  return Object.freeze({ kind: "unsupported", reason, outcome });
}

function isPinnedSandbox(evidence: SandboxEvidence | undefined): evidence is typeof pinnedSandbox {
  return (
    typeof evidence === "object" &&
    evidence !== null &&
    evidence.backend === pinnedSandbox.backend &&
    evidence.backendVersion === pinnedSandbox.backendVersion &&
    evidence.profile === pinnedSandbox.profile &&
    evidence.policyDigest === pinnedSandbox.policyDigest
  );
}

function usableEvidence(
  outcome: NodeExecutionOutcome,
  request: LinuxObserverCommandRequest,
): boolean {
  const evidence = outcome.evidence;
  if (
    evidence?.kind !== "command" ||
    !isPinnedSandbox(evidence.sandbox) ||
    evidence.executable !== request.command.executable ||
    JSON.stringify(evidence.args) !== JSON.stringify(request.command.args) ||
    evidence.signal !== null ||
    evidence.timedOut !== false ||
    evidence.aborted !== false ||
    evidence.stdoutTruncated !== false ||
    evidence.stderrTruncated !== false ||
    evidence.stdinHash !== undefined ||
    !Number.isFinite(evidence.durationMs) ||
    evidence.durationMs < 0 ||
    !["confirmed", "not-required"].includes(evidence.terminationStatus ?? "") ||
    !Number.isSafeInteger(evidence.exitCode) ||
    evidence.exitCode === null ||
    evidence.exitCode < 0 ||
    evidence.exitCode > 255 ||
    (outcome.status === "succeeded" ? evidence.exitCode !== 0 : evidence.exitCode === 0)
  )
    return false;
  return (
    validOutput(evidence, "stdout", request.maxOutputBytes) &&
    validOutput(evidence, "stderr", request.maxOutputBytes)
  );
}

function validOutput(
  evidence: CommandEvidence,
  stream: "stdout" | "stderr",
  maxBytes: number,
): boolean {
  const content = evidence[stream];
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > maxBytes) return false;
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return (
    evidence[`${stream}Hash`] === digest &&
    (evidence[`${stream}RetainedHash`] === undefined ||
      evidence[`${stream}RetainedHash`] === digest) &&
    (evidence[`${stream}RetainedBytes`] === undefined ||
      evidence[`${stream}RetainedBytes`] === Buffer.byteLength(content, "utf8")) &&
    evidence[`${stream}Artifact`] === undefined
  );
}
