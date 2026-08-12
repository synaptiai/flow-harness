import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttachedPrimeOciOperator } from "../../../src/infrastructure/oci/attached-prime-oci-operator.js";
import { DurablePrimeWorkspacePublisher } from "../../../src/infrastructure/oci/durable-prime-workspace-publisher.js";
import type {
  PrimeOciOperationEvidence,
  PrimeOciOperationInput,
} from "../../../src/infrastructure/oci/local-prime-oci-harness-runtime.js";
import {
  createLocalPrimeOciFixtureSource,
  StagedPrimeOciResultSink,
} from "../../../src/infrastructure/oci/local-prime-workspace-transfer.js";
import { validatePrimeOciReadiness } from "../../../src/infrastructure/oci/prime-oci-readiness.js";
import {
  type NativePrimeHarnessDescriptor,
  NativePrimeHarnessRegistry,
} from "../../../src/infrastructure/prime/native-prime-harness-registry.js";
import { NativePrimeHostInferenceBroker } from "../../../src/infrastructure/prime/native-prime-host-inference-broker.js";
import {
  createPrimeContainerManifestSha256,
  type PrimeContainerManifestEntry,
} from "../../../src/infrastructure/prime/prime-container-protocol.js";
import type { PrimeExternalHarnessIdentity } from "../evaluation/prime-external-harness-identity.js";
import { startVerifiedPrimeContainer } from "./prime-container-runtime.js";

export interface VerifiedPrimeSessionInput {
  readonly instruction: string;
  readonly maxExecutionMs?: number;
  readonly responses: readonly Record<string, unknown>[];
  readonly onInferenceRequest?: (input: {
    readonly body: string;
    readonly containerId: string;
    readonly containerName: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly onContainerStarted?: (input: {
    readonly containerId: string;
    readonly containerName: string;
  }) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly testDependencies?: {
    readonly onWorkspaceCreated?: (path: string) => void;
    readonly removeWorkspace?: (path: string) => Promise<void>;
    readonly resolveDescriptor?: () => Promise<NativePrimeHarnessDescriptor>;
    readonly startContainer?: typeof startVerifiedPrimeContainer;
  };
}

export interface VerifiedPrimeSessionResult {
  readonly workspace: string;
  readonly hostRequests: readonly string[];
  readonly checkpoints: readonly string[];
  readonly evidence: PrimeOciOperationEvidence;
  dispose(): Promise<void>;
}

export async function runVerifiedPrimeSession(
  input: VerifiedPrimeSessionInput,
): Promise<VerifiedPrimeSessionResult> {
  const descriptor = await (input.testDependencies?.resolveDescriptor ?? readVerifiedDescriptor)();
  const identity = descriptor.identity;
  const workspace = await mkdtemp(join(tmpdir(), "flow-prime-verified-session-"));
  const removeWorkspace =
    input.testDependencies?.removeWorkspace ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  let released = false;
  let failed = false;
  let primaryError: unknown;
  let result: VerifiedPrimeSessionResult | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let transport: Awaited<ReturnType<typeof startVerifiedPrimeContainer>> | undefined;
  try {
    input.testDependencies?.onWorkspaceCreated?.(workspace);
    const instructionPath = join(workspace, "TASK.md");
    await writeFile(instructionPath, input.instruction, "utf8");
    const instructionMetadata = await lstat(instructionPath);
    const entry: PrimeContainerManifestEntry = {
      path: "TASK.md",
      type: "file",
      mode: instructionMetadata.mode & 0o777,
      size: Buffer.byteLength(input.instruction),
      sha256: sha256(input.instruction),
    };
    const snapshotDigest = createPrimeContainerManifestSha256([entry]);
    const maxExecutionMs = input.maxExecutionMs ?? 90_000;
    const request = operationRequest(
      identity,
      workspace,
      snapshotDigest,
      input.instruction,
      maxExecutionMs,
    );
    const fixture = await createLocalPrimeOciFixtureSource({
      root: workspace,
      instructionPath: "TASK.md",
      expectedSnapshotDigest: snapshotDigest,
    });
    const publisher = new DurablePrimeWorkspacePublisher();
    const resultSink = new StagedPrimeOciResultSink({
      targetRoot: workspace,
      publish: (publication) => publisher.publish(publication),
    });
    const hostRequests: string[] = [];
    const checkpoints: string[] = [];
    const responses = [...input.responses];
    transport = await (input.testDependencies?.startContainer ?? startVerifiedPrimeContainer)(
      identity,
      {
        assertCurrent: () => descriptor.assertCurrent(),
        imageDevice: descriptor.localRuntime.imageDevice,
        seccompProfile: descriptor.localRuntime.seccompProfile,
      },
    );
    const verifiedTransport = transport;
    await input.onContainerStarted?.({
      containerId: verifiedTransport.containerId,
      containerName: verifiedTransport.containerName,
    });
    const broker = new NativePrimeHostInferenceBroker({
      delegate: {
        infer: async ({ body }: { readonly body: string }, signal?: AbortSignal) => {
          hostRequests.push(body);
          await input.onInferenceRequest?.({
            body,
            containerId: verifiedTransport.containerId,
            containerName: verifiedTransport.containerName,
            ...(signal === undefined ? {} : { signal }),
          });
          const response = responses.shift();
          if (response === undefined) {
            throw new Error("verified Prime session requested an unexpected model turn");
          }
          return JSON.stringify(response);
        },
      },
    });
    const controller = new AbortController();
    timeout = setTimeout(
      () => controller.abort(new Error(`verified Prime session exceeded ${maxExecutionMs}ms`)),
      maxExecutionMs,
    );
    timeout.unref?.();
    const operationSignal =
      input.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, input.signal]);
    const evidence = await new AttachedPrimeOciOperator({
      fixture,
      resultSink,
      inferenceBroker: broker,
      validateReadiness: (payload, operation) => {
        validatePrimeOciReadiness(payload, {
          identity: operation.descriptor.identity,
          identityDigest: operation.descriptor.identityDigest,
          containerId: operation.containerId,
          trialId: operation.request.evaluation.trial.trialId,
          imageDevice: operation.descriptor.localRuntime.imageDevice,
        });
      },
    }).operate({
      request,
      descriptor,
      containerId: verifiedTransport.containerId,
      transport: verifiedTransport,
      checkpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
      signal: operationSignal,
    });
    await verifiedTransport.release();
    released = true;
    if (responses.length !== 0) {
      throw new Error("verified Prime session did not consume every model response");
    }
    result = Object.freeze({
      workspace,
      hostRequests: Object.freeze(hostRequests),
      checkpoints: Object.freeze(checkpoints),
      evidence,
      dispose: async () => removeWorkspace(workspace),
    });
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
  const cleanupErrors = (
    await Promise.all([
      failed ? settleCleanup(() => removeWorkspace(workspace), 1) : Promise.resolve([]),
      released || transport === undefined
        ? Promise.resolve([])
        : settleCleanup(() => transport.forceRemove(), 2),
    ])
  ).flat();
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(failed ? [primaryError] : []), ...cleanupErrors],
      "verified Prime session cleanup failed",
    );
  }
  if (failed) {
    throw primaryError;
  }
  if (result === undefined) {
    throw new Error("verified Prime session ended without a result");
  }
  return result;
}

async function settleCleanup(cleanup: () => Promise<void>, attempts: number): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await cleanup();
      return [];
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function primeAssistantToolCall(id: string, code: string, turn: number) {
  return primeAssistantMessage(
    [{ type: "toolCall", id, name: "ipython", arguments: { code } }],
    "toolUse",
    turn,
  );
}

export function primeAssistantText(text: string, turn: number) {
  return primeAssistantMessage([{ type: "text", text }], "stop", turn);
}

function primeAssistantMessage(
  content: readonly Record<string, unknown>[],
  stopReason: "stop" | "toolUse",
  turn: number,
) {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    responseId: `prime-runtime-response-${String(turn)}`,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: turn,
  };
}

async function readVerifiedDescriptor(): Promise<NativePrimeHarnessDescriptor> {
  const path = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (path === undefined) {
    throw new Error("verified Prime session requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  return new NativePrimeHarnessRegistry({ attestationPath: path }).resolve({
    id: "prime",
    adapter: "prime-agent-native-v1",
    harness: { config: "prime-agent-rlm-evaluation-v1" },
  });
}

function operationRequest(
  identity: PrimeExternalHarnessIdentity,
  workspace: string,
  snapshotDigest: string,
  instruction: string,
  maxExecutionMs: number,
): PrimeOciOperationInput["request"] {
  const trialId = `trial-${"b".repeat(48)}`;
  return {
    identity,
    evaluation: {
      planDigest: "a".repeat(64),
      trial: {
        trialId,
        position: 1,
        taskId: "verified-runtime",
        profileId: "prime",
        seed: 7,
        repetition: 1,
      },
      workspace: {
        workspaceId: `workspace-${trialId}`,
        cwd: workspace,
        backend: "reflink-copy-v1",
        snapshotDigest,
      },
      instruction: { path: "TASK.md", sha256: sha256(instruction) },
      controls: {
        model: { provider: "test-provider", id: "test-model", thinking: "off" },
        budget: {
          maxNodeStarts: 8,
          maxModelTokens: 4_096,
          maxCostUsdMicros: 100_000,
          maxExecutionMs,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
    },
    isolation: { projectRoot: workspace, protectedPaths: [] },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
