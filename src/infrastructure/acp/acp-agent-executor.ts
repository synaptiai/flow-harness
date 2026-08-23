import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { tmpdir } from "node:os";

import type { AcpAgentSandbox } from "../../application/acp-agent-sandbox.js";
import type { PreparedCommand } from "../../application/command-sandbox.js";
import type {
  AgentExecutor,
  NodeExecutionContext,
  NodeExecutionOutcome,
} from "../../application/ports.js";
import {
  type AcpAgentProviderAuthority,
  type AcpAgentRuntimeSnapshot,
  validateAcpAgentRuntimeSnapshot,
} from "../../domain/capability/acp-agent.js";
import { validateCapabilitySnapshot } from "../../domain/capability/agent-skills.js";
import type { ModelUsageObservation } from "../../domain/run/budget.js";
import {
  calculateAcpAgentSessionBindingDigest,
  type AcpAgentAuthorityViolation,
  type AcpAgentExecutionEvidence,
  type AgentEvidence,
  type NodeFailure,
} from "../../domain/run/events.js";
import { renderModelSessionResumeCapsule } from "../../domain/run/model-session.js";
import type { ModelWorkProfileContext } from "../../domain/run/work-profile.js";
import type { CompiledAgentNode } from "../../domain/workflow/types.js";
import {
  assertLocalAcpAgentRuntimeCurrent,
  LocalAcpAgentIdentityChangedError,
} from "../fs/local-acp-agent.js";
import {
  type ProcessTreeExitResult,
  waitForProcessTreeExit,
} from "../process/command-node-executor.js";
import {
  AcpAgentSessionError,
  runAcpAgentSession,
  type AcpAgentSessionResult,
} from "./acp-agent-session.js";
import { createStrictAcpStream } from "./strict-acp-stream.js";

const MAX_ACP_AGENT_OUTPUT_BYTES = 65_536;
const MAX_ACP_AGENT_PROMPT_BYTES = 1_048_576;
const MAX_ACP_AGENT_STDOUT_BYTES = 16 * 1_048_576;
const MAX_ACP_AGENT_STDERR_BYTES = 65_536;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_CONFIRMATION_MS = 2_000;

type AssertCurrent = (
  projectRoot: string,
  snapshot: AcpAgentRuntimeSnapshot,
) => Promise<void>;

export interface AcpAgentExecutorOptions {
  readonly sandbox: AcpAgentSandbox;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly assertCurrent?: AssertCurrent;
  readonly createAttemptDirectory?: () => Promise<string>;
  readonly removeAttemptDirectory?: (path: string) => Promise<void>;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmationMs?: number;
}

interface AdmittedExecution {
  readonly snapshot: AcpAgentRuntimeSnapshot;
  readonly authority: AcpAgentProviderAuthority;
  readonly executable: string;
  readonly args: readonly string[];
  readonly runtimeSupportPaths: readonly string[];
  readonly projectRoot: string;
  readonly maxOutputBytes: number;
  readonly prompt: string;
}

interface ExecutionObservation {
  sessionId?: string;
  promptStarted: boolean;
  authorityViolation?: AcpAgentAuthorityViolation;
  updateCount: number;
  stdoutLimitExceeded: boolean;
  stderrLimitExceeded: boolean;
}

export class AcpAgentExecutor implements AgentExecutor {
  readonly #sandbox: AcpAgentSandbox;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #assertCurrent: AssertCurrent;
  readonly #createAttemptDirectory: () => Promise<string>;
  readonly #removeAttemptDirectory: (path: string) => Promise<void>;
  readonly #terminationGraceMs: number;
  readonly #terminationConfirmationMs: number;

  constructor(options: AcpAgentExecutorOptions) {
    this.#sandbox = options.sandbox;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? performance.now.bind(performance);
    this.#assertCurrent = options.assertCurrent ?? assertLocalAcpAgentRuntimeCurrent;
    this.#createAttemptDirectory =
      options.createAttemptDirectory ??
      (async () => await realpath(await mkdtemp(join(tmpdir(), "flow-acp-attempt-"))));
    this.#removeAttemptDirectory =
      options.removeAttemptDirectory ??
      (async (path) => await rm(path, { recursive: true, force: true, maxRetries: 2 }));
    this.#terminationGraceMs = parseNonNegativeDuration(
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
      "termination grace",
    );
    this.#terminationConfirmationMs = parsePositiveDuration(
      options.terminationConfirmationMs ?? DEFAULT_TERMINATION_CONFIRMATION_MS,
      "termination confirmation",
    );
  }

  async execute(
    node: CompiledAgentNode,
    context: NodeExecutionContext,
  ): Promise<NodeExecutionOutcome> {
    const startedAt = this.#now();
    const admitted = admitExecution(node, context);
    if (admitted instanceof Error) {
      return failure(admitted.message, "none", null);
    }
    if (isAborted(context.signal)) {
      return failure("acp_agent_aborted", "none", null);
    }
    if (this.#platform !== "darwin" && this.#platform !== "linux") {
      return failure("acp_agent_platform_unsupported", "none", null);
    }

    let attemptDirectory: string | undefined;
    let prepared: PreparedCommand | undefined;
    let outcome: NodeExecutionOutcome | undefined;
    try {
      attemptDirectory = await this.#createAttemptDirectory();
      prepared = await this.#sandbox.prepareAcpAgent({
        executable: admitted.executable,
        args: admitted.args,
        cwd: attemptDirectory,
        projectRoot: admitted.projectRoot,
        protectedPaths: context.protectedPaths,
        runtimeSupportPaths: admitted.runtimeSupportPaths,
        providerDomain: admitted.authority.domain,
        credentialEnvironmentVariable: admitted.authority.credentialEnv,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (
        prepared.run !== undefined ||
        (this.#platform === "linux" && prepared.processContainment !== "linux-pid-namespace")
      ) {
        outcome = failure("acp_agent_sandbox_unavailable", "none", null);
      } else {
        await this.#assertCurrent(admitted.projectRoot, admitted.snapshot);
        await prepared.beforeLaunch?.();
        if (isAborted(context.signal)) {
          outcome = failure("acp_agent_aborted", "none", null);
        } else {
          outcome = await this.#runProcess(
            node,
            context,
            admitted,
            prepared,
            attemptDirectory,
            startedAt,
          );
        }
      }
    } catch (error) {
      outcome = classifyPreparationFailure(error, context.signal);
    }

    let cleanupFailed = false;
    try {
      await prepared?.release();
    } catch {
      cleanupFailed = true;
    }
    if (attemptDirectory !== undefined) {
      try {
        await this.#removeAttemptDirectory(attemptDirectory);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      const evidence = outcome?.evidence?.kind === "agent" ? outcome.evidence : null;
      return failure(
        "acp_agent_cleanup_failed",
        evidence?.acp === undefined ? "none" : "uncertain",
        evidence,
      );
    }
    return outcome ?? failure("acp_agent_sandbox_unavailable", "none", null);
  }

  async #runProcess(
    node: CompiledAgentNode,
    context: NodeExecutionContext,
    admitted: AdmittedExecution,
    prepared: PreparedCommand,
    attemptDirectory: string,
    startedAt: number,
  ): Promise<NodeExecutionOutcome> {
    const observation: ExecutionObservation = {
      promptStarted: false,
      updateCount: 0,
      stdoutLimitExceeded: false,
      stderrLimitExceeded: false,
    };
    const lifecycle = new AbortController();
    const processSignal =
      context.signal === undefined
        ? lifecycle.signal
        : AbortSignal.any([context.signal, lifecycle.signal]);
    const child = spawn(prepared.launch.executable, [...prepared.launch.args], {
      cwd: attemptDirectory,
      env: prepared.launch.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      lifecycle.abort(new Error("ACP process pipes unavailable"));
      return failure("acp_agent_spawn_failed", "none", null);
    }

    const exitPromise = waitForProcessTreeExit(
      child,
      node.agent.timeoutMs,
      this.#terminationGraceMs,
      processSignal,
      this.#platform,
      this.#terminationConfirmationMs,
      true,
    );
    const boundedStdout = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_ACP_AGENT_STDOUT_BYTES) {
          observation.stdoutLimitExceeded = true;
          lifecycle.abort(new Error("ACP standard output limit exceeded"));
          callback(new Error("ACP standard output limit exceeded"));
          return;
        }
        callback(null, chunk);
      },
    });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.pipe(boundedStdout);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_ACP_AGENT_STDERR_BYTES && !observation.stderrLimitExceeded) {
        observation.stderrLimitExceeded = true;
        lifecycle.abort(new Error("ACP standard error limit exceeded"));
      }
    });

    let sessionResult: AcpAgentSessionResult | undefined;
    let sessionError: unknown;
    try {
      sessionResult = await runAcpAgentSession(
        createStrictAcpStream({
          input: Readable.toWeb(boundedStdout) as ReadableStream<Uint8Array>,
          output: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        }),
        {
          snapshot: admitted.snapshot,
          provider: node.agent.model.provider,
          model: node.agent.model.id,
          thinking: node.agent.model.thinking,
          cwd: attemptDirectory,
          prompt: admitted.prompt,
          maxOutputBytes: admitted.maxOutputBytes,
          signal: processSignal,
          onSessionCreated: (sessionId) => {
            observation.sessionId = sessionId;
          },
          onPromptStarted: () => {
            observation.promptStarted = true;
          },
          onAuthorityViolation: (category) => {
            observation.authorityViolation ??= category;
            lifecycle.abort(new Error("ACP authority violation"));
          },
          onUpdateCount: (count) => {
            observation.updateCount = count;
          },
        },
      );
    } catch (error) {
      sessionError = error;
    } finally {
      lifecycle.abort(new Error("ACP session settled"));
    }
    const exit = await exitPromise;
    const durationMs = Math.max(0, this.#now() - startedAt);
    const evidence = buildEvidence(node, context, admitted.snapshot, prepared, observation, durationMs, sessionResult, exit);

    if (exit.terminationIncomplete) {
      return failure("acp_agent_termination_unconfirmed", "uncertain", evidence);
    }
    if (observation.authorityViolation !== undefined) {
      return failure("acp_agent_authority_violation", "uncertain", evidence);
    }
    if (exit.timedOut) {
      return failure(
        "acp_agent_timeout",
        observation.promptStarted ? "uncertain" : "none",
        evidence,
      );
    }
    if (context.signal?.aborted === true) {
      return failure(
        "acp_agent_aborted",
        observation.promptStarted ? "uncertain" : "none",
        evidence,
      );
    }
    if (observation.stdoutLimitExceeded || observation.stderrLimitExceeded) {
      return failure(
        "acp_agent_output_limit",
        observation.promptStarted ? "uncertain" : "none",
        evidence,
      );
    }
    if (exit.spawnError !== null) {
      return failure("acp_agent_spawn_failed", "none", evidence);
    }
    if (sessionResult === undefined) {
      return failure(
        classifySessionFailure(sessionError),
        observation.promptStarted ? "uncertain" : "none",
        evidence,
      );
    }
    if (exit.exitCode !== null && exit.exitCode !== 0 && !exit.aborted) {
      return failure("acp_agent_process_failed", "uncertain", evidence);
    }
    if (evidence === null) {
      return failure("acp_agent_protocol_failed", "uncertain", null);
    }
    return { status: "succeeded", evidence };
  }
}

function admitExecution(
  node: CompiledAgentNode,
  context: NodeExecutionContext,
): AdmittedExecution | Error {
  try {
    if (
      node.agent.tools.length !== 0 ||
      node.agent.skills.length !== 0 ||
      node.agent.toolPackages.length !== 0 ||
      node.agent.toolApproval !== undefined
    ) {
      throw new Error("prompt-only contract");
    }
    if (context.projectRoot === undefined || context.capabilitySnapshot === undefined) {
      throw new Error("runtime snapshot");
    }
    const capabilitySnapshot = validateCapabilitySnapshot(context.capabilitySnapshot);
    if (capabilitySnapshot.acpAgent === undefined) throw new Error("runtime snapshot");
    const snapshot = validateAcpAgentRuntimeSnapshot(capabilitySnapshot.acpAgent);
    const mapping = snapshot.modelMappings.find(
      (candidate) =>
        candidate.provider === node.agent.model.provider && candidate.model === node.agent.model.id,
    );
    const authority = snapshot.providerAuthorities.find(
      (candidate) => candidate.provider === node.agent.model.provider,
    );
    const thinking = snapshot.configuration.assignments.find(
      (assignment) => assignment.source === "thinking",
    );
    if (
      mapping === undefined ||
      authority === undefined ||
      thinking?.source !== "thinking" ||
      !thinking.mappings.some((candidate) => candidate.thinking === node.agent.model.thinking)
    ) {
      throw new Error("model contract");
    }
    const maxOutputBytes = context.agentMaxOutputBytes ?? MAX_ACP_AGENT_OUTPUT_BYTES;
    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      maxOutputBytes > MAX_ACP_AGENT_OUTPUT_BYTES
    ) {
      throw new Error("output contract");
    }
    const prompt = renderPrompt(node, context);
    if (Buffer.byteLength(prompt, "utf8") > MAX_ACP_AGENT_PROMPT_BYTES) {
      throw new Error("prompt contract");
    }
    const launch = resolveLaunch(snapshot);
    return Object.freeze({
      snapshot,
      authority,
      projectRoot: context.projectRoot,
      maxOutputBytes,
      prompt,
      ...launch,
    });
  } catch {
    return new Error("acp_agent_contract_invalid");
  }
}

function resolveLaunch(snapshot: AcpAgentRuntimeSnapshot): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly runtimeSupportPaths: readonly string[];
} {
  if (snapshot.launch.kind === "binary") {
    return Object.freeze({
      executable: snapshot.launch.executable.path,
      args: snapshot.launch.args,
      runtimeSupportPaths: Object.freeze([snapshot.launch.executable.path]),
    });
  }
  return Object.freeze({
    executable: snapshot.launch.nodeExecutable.path,
    args: Object.freeze([
      join(snapshot.launch.package.root, snapshot.launch.package.entrypoint.path),
      ...snapshot.launch.args,
    ]),
    runtimeSupportPaths: Object.freeze([
      snapshot.launch.nodeExecutable.path,
      snapshot.launch.package.root,
      snapshot.launch.package.resolutionRoot,
    ]),
  });
}

function renderPrompt(node: CompiledAgentNode, context: NodeExecutionContext): string {
  const sections = [
    "Flow ACP prompt-only authority capsule, version 1.",
    JSON.stringify({
      attribution: {
        runId: context.runId,
        workflowId: context.workflowId,
        nodeId: node.id,
        attempt: context.attempt,
      },
      authority: {
        owner: "Flow",
        tools: [],
        filesystem: false,
        terminal: false,
        elicitation: false,
        mcpServers: [],
        extensions: [],
      },
      model: node.agent.model,
    }),
    renderWorkProfile(context.modelWorkProfile),
    context.agentSystemPrompt,
    context.agentGoalWorkspace,
    context.agentSupplementalMemory,
    context.modelSession?.state.primaryPromptCommitted === true
      ? renderModelSessionResumeCapsule(context.modelSession.state).text
      : undefined,
    "Task:",
    node.agent.prompt,
  ];
  return sections.filter((section): section is string => section !== undefined).join("\n\n");
}

function renderWorkProfile(context: ModelWorkProfileContext | undefined): string | undefined {
  if (context === undefined) return undefined;
  return JSON.stringify({
    flowWorkProfile: {
      role: "pacing-guidance-only",
      profile: context.profile,
      remaining: context.remaining,
    },
  });
}

function buildEvidence(
  node: CompiledAgentNode,
  context: NodeExecutionContext,
  snapshot: AcpAgentRuntimeSnapshot,
  prepared: PreparedCommand,
  observation: ExecutionObservation,
  durationMs: number,
  result: AcpAgentSessionResult | undefined,
  exit: ProcessTreeExitResult,
): AgentEvidence | null {
  const sessionId = observation.sessionId ?? result?.sessionId;
  if (sessionId === undefined) return null;
  const sessionIdHash = sha256(sessionId);
  const usageObservation: ModelUsageObservation =
    result?.usageObservation ?? unavailableUsageObservation();
  const acp: AcpAgentExecutionEvidence = {
    version: 1,
    executor: "local-acp-process-v1",
    agentName: snapshot.name,
    agentDigest: snapshot.digest,
    protocol: snapshot.protocol,
    compatibilityProfile: snapshot.compatibilityProfile,
    containmentProfile: snapshot.containmentProfile,
    runtimeIdentity: "revalidated",
    credentialLease: "srt-host-scoped-sentinel",
    sessionIdHash,
    sessionBindingDigest: calculateAcpAgentSessionBindingDigest({
      runId: context.runId,
      workflowId: context.workflowId,
      nodeId: node.id,
      attempt: context.attempt,
      agentDigest: snapshot.digest,
      sessionIdHash,
    }),
    processContainment: prepared.processContainment,
    terminationStatus: exit.terminationIncomplete ? "unconfirmed" : "confirmed",
    sandbox: prepared.evidence,
    usageProvenance:
      result?.usageProvenance ?? { modelTokens: "not-observed", costUsd: "not-observed" },
    updateCount: result?.updateCount ?? observation.updateCount,
    ...(observation.authorityViolation === undefined
      ? {}
      : { authorityViolation: observation.authorityViolation }),
  };
  const text = result?.text ?? "";
  return Object.freeze({
    kind: "agent",
    provider: node.agent.model.provider,
    model: node.agent.model.id,
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs,
    usageObservation,
    policyDecisions: Object.freeze([]),
    effectReceipts: Object.freeze([]),
    acp: Object.freeze(acp),
  });
}

function unavailableUsageObservation(): ModelUsageObservation {
  return Object.freeze({
    modelTokens: Object.freeze({ status: "unavailable" as const }),
    costUsd: Object.freeze({ status: "unavailable" as const }),
  });
}

function classifyPreparationFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): NodeExecutionOutcome {
  if (signal?.aborted === true) return failure("acp_agent_aborted", "none", null);
  if (error instanceof LocalAcpAgentIdentityChangedError) {
    return failure("acp_agent_identity_changed", "none", null);
  }
  return failure("acp_agent_sandbox_unavailable", "none", null);
}

function classifySessionFailure(error: unknown): string {
  if (!(error instanceof AcpAgentSessionError)) return "acp_agent_protocol_failed";
  switch (error.code) {
    case "authority_violation":
      return "acp_agent_authority_violation";
    case "configuration_drift":
    case "configuration_rejected":
      return "acp_agent_configuration_failed";
    case "output_limit":
      return "acp_agent_output_limit";
    case "protocol":
    case "stop_reason":
    case "usage_invalid":
      return "acp_agent_protocol_failed";
  }
}

function failure(
  code: string,
  sideEffectStatus: NodeFailure["sideEffectStatus"],
  evidence: AgentEvidence | null,
): NodeExecutionOutcome {
  const error: NodeFailure = {
    code,
    message: failureMessage(code),
    retryable: false,
    sideEffectStatus,
  };
  return { status: "failed", error, evidence };
}

function failureMessage(code: string): string {
  switch (code) {
    case "acp_agent_aborted":
      return "ACP agent execution was cancelled";
    case "acp_agent_authority_violation":
      return "ACP agent requested authority outside the prompt-only contract";
    case "acp_agent_cleanup_failed":
      return "ACP agent private execution state could not be removed";
    case "acp_agent_configuration_failed":
      return "ACP agent rejected or changed the exact session configuration";
    case "acp_agent_contract_invalid":
      return "ACP agent execution does not match the admitted prompt-only contract";
    case "acp_agent_identity_changed":
      return "ACP agent identity changed after admission";
    case "acp_agent_output_limit":
      return "ACP agent exceeded a fixed output limit";
    case "acp_agent_platform_unsupported":
      return "ACP agent process containment is unavailable on this platform";
    case "acp_agent_process_failed":
      return "ACP agent process failed after the prompt began";
    case "acp_agent_protocol_failed":
      return "ACP agent protocol failed";
    case "acp_agent_sandbox_unavailable":
      return "ACP agent sandbox preparation failed";
    case "acp_agent_spawn_failed":
      return "ACP agent process could not start";
    case "acp_agent_termination_unconfirmed":
      return "ACP agent descendant termination could not be confirmed";
    case "acp_agent_timeout":
      return "ACP agent execution exceeded its timeout";
    default:
      return "ACP agent execution failed";
  }
}

function parseNonNegativeDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function parsePositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
