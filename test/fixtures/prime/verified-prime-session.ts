import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePrimeOciImageIdentity } from "../../../src/domain/evaluation/external-harness.js";
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
import type { NativePrimeHarnessDescriptor } from "../../../src/infrastructure/prime/native-prime-harness-registry.js";
import { NativePrimeHostInferenceBroker } from "../../../src/infrastructure/prime/native-prime-host-inference-broker.js";
import {
  createPrimeContainerManifestSha256,
  type PrimeContainerManifestEntry,
} from "../../../src/infrastructure/prime/prime-container-protocol.js";
import {
  type PrimeExternalHarnessIdentity,
  primeExternalHarnessIdentity,
} from "../evaluation/prime-external-harness-identity.js";
import { startVerifiedPrimeContainer } from "./prime-container-runtime.js";

export interface VerifiedPrimeSessionInput {
  readonly instruction: string;
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
  const image = readVerifiedImage();
  const workspace = await mkdtemp(join(tmpdir(), "flow-prime-verified-session-"));
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
  const identity = Object.freeze({ ...primeExternalHarnessIdentity(), image });
  const descriptor = descriptorFor(identity);
  const request = operationRequest(identity, workspace, snapshotDigest, input.instruction);
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
  const transport = await startVerifiedPrimeContainer(image.id);
  await input.onContainerStarted?.({
    containerId: transport.containerId,
    containerName: transport.containerName,
  });
  const broker = new NativePrimeHostInferenceBroker({
    delegate: {
      infer: async ({ body }: { readonly body: string }, signal?: AbortSignal) => {
        hostRequests.push(body);
        await input.onInferenceRequest?.({
          body,
          containerId: transport.containerId,
          containerName: transport.containerName,
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
  const timeout = setTimeout(
    () => controller.abort(new Error("verified Prime session exceeded 90 seconds")),
    90_000,
  );
  timeout.unref?.();
  const operationSignal =
    input.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, input.signal]);
  let released = false;
  try {
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
        });
      },
    }).operate({
      request,
      descriptor,
      containerId: transport.containerId,
      transport,
      checkpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
      },
      signal: operationSignal,
    });
    await transport.release();
    released = true;
    if (responses.length !== 0) {
      throw new Error("verified Prime session did not consume every model response");
    }
    return Object.freeze({
      workspace,
      hostRequests: Object.freeze(hostRequests),
      checkpoints: Object.freeze(checkpoints),
      evidence,
      dispose: async () => rm(workspace, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
    if (!released) {
      await transport.forceRemove();
    }
  }
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

function readVerifiedImage() {
  const path = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (path === undefined) {
    throw new Error("verified Prime session requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as { readonly image?: unknown };
  if (value.image === undefined) {
    throw new Error("verified Prime session received an invalid image result");
  }
  return parsePrimeOciImageIdentity(value.image);
}

function operationRequest(
  identity: PrimeExternalHarnessIdentity,
  workspace: string,
  snapshotDigest: string,
  instruction: string,
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
          maxExecutionMs: 90_000,
          maxArtifactBytes: 1_048_576,
        },
        network: "deny",
        retry: { providerRetries: 0, harnessRetries: 0 },
      },
    },
    isolation: { projectRoot: workspace, protectedPaths: [] },
  };
}

function descriptorFor(identity: PrimeExternalHarnessIdentity): NativePrimeHarnessDescriptor {
  return {
    identity,
    identityDigest: "e".repeat(64),
    localRuntime: {
      daemonId: "verified-prime-test",
      socketPath: "/var/run/docker.sock",
      socket: { device: 1, inode: 1, uid: 0, gid: 0, mode: 0o660 },
      apiVersion: identity.runtime.engine.apiVersion,
      cgroupPath: "/sys/fs/cgroup",
      corePattern: "core",
      globalLeasePath: "/var/tmp/flow-prime-test-slot.json",
      imageDevice: { path: "/dev/null", major: 1, minor: 3 },
      executables: executableIdentities(identity),
      leaseTarget: "flow-prime-global-v1",
      seccompProfile: {},
    },
    assertCurrent: async () => undefined,
  };
}

function executableIdentities(identity: PrimeExternalHarnessIdentity) {
  return {
    docker: { path: "/usr/bin/docker", sha256: identity.runtime.client.executableSha256 },
    containerd: {
      path: "/usr/bin/containerd",
      sha256: identity.runtime.engine.containerdSha256,
    },
    runc: { path: "/usr/bin/runc", sha256: identity.runtime.engine.runcSha256 },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
