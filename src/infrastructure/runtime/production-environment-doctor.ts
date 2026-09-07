import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeExecutionContext } from "../../application/ports.js";
import type { CompiledCommandNode } from "../../domain/workflow/types.js";
import { createProductionNodeExecutor } from "./production-node-executor.js";

const NATIVE_SANDBOX_PROBE_COMMAND_TIMEOUT_MS = 10_000;

interface NativeSandboxProbeExecutor {
  execute(
    node: CompiledCommandNode,
    context: NodeExecutionContext,
  ): Promise<{ readonly status: "succeeded" | "failed" }>;
}

export interface ProductionEnvironmentDoctorOptions {
  readonly createExecutor?: (root: string) => NativeSandboxProbeExecutor;
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly nodeExecutable?: string;
  readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
}

export async function inspectProjectFilesystem(
  projectRoot: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await access(projectRoot, constants.R_OK | constants.W_OK);
  signal.throwIfAborted();
  await access(join(projectRoot, ".flow"), constants.R_OK | constants.W_OK);
  signal.throwIfAborted();
}

export async function inspectProductionNativeSandbox(
  _root: string,
  signal: AbortSignal,
  options: ProductionEnvironmentDoctorOptions = {},
): Promise<void> {
  signal.throwIfAborted();
  const createTemporaryDirectory =
    options.createTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), "flow-doctor-native-")));
  const removeTemporaryDirectory =
    options.removeTemporaryDirectory ??
    ((path: string) => rm(path, { recursive: true, force: true, maxRetries: 2 }));
  let operationError: unknown;
  let operationFailed = false;
  let probeRoot: string | undefined;
  try {
    probeRoot = await createTemporaryDirectory();
    signal.throwIfAborted();
    const node: CompiledCommandNode = Object.freeze({
      id: "flow-doctor-native-sandbox",
      type: "command" as const,
      dependsOn: Object.freeze([]),
      command: Object.freeze({
        executable: options.nodeExecutable ?? process.execPath,
        args: Object.freeze(["-e", ""]),
        timeoutMs: NATIVE_SANDBOX_PROBE_COMMAND_TIMEOUT_MS,
      }),
    });
    const context: NodeExecutionContext = Object.freeze({
      runId: "flow-doctor",
      workflowId: "flow-doctor",
      attempt: 1,
      cwd: probeRoot,
      protectedPaths: Object.freeze([]),
      signal,
    });
    const outcome = await (
      options.createExecutor ??
      ((projectRoot) => createProductionNodeExecutor("native", projectRoot))
    )(probeRoot).execute(node, context);
    signal.throwIfAborted();
    if (outcome.status !== "succeeded") {
      throw new Error("native sandbox probe failed");
    }
  } catch (cause) {
    operationFailed = true;
    operationError = cause;
  }
  if (probeRoot !== undefined) {
    try {
      await removeTemporaryDirectory(probeRoot);
    } catch (cleanupError) {
      const cause = operationFailed
        ? new AggregateError([operationError, cleanupError], "native sandbox probe did not settle")
        : cleanupError;
      throw new Error("configured native sandbox is unavailable", { cause });
    }
  }
  if (operationFailed) {
    signal.throwIfAborted();
    throw new Error("configured native sandbox is unavailable", { cause: operationError });
  }
  signal.throwIfAborted();
}
