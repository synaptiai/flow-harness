import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { NodeExecutionContext } from "../../application/ports.js";
import type { CompiledCommandNode } from "../../domain/workflow/types.js";
import { createProductionNodeExecutor } from "./production-node-executor.js";

interface NativeSandboxProbeExecutor {
  execute(
    node: CompiledCommandNode,
    context: NodeExecutionContext,
  ): Promise<{ readonly status: "succeeded" | "failed" }>;
}

export interface ProductionEnvironmentDoctorOptions {
  readonly createExecutor?: (root: string) => NativeSandboxProbeExecutor;
  readonly nodeExecutable?: string;
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
  root: string,
  signal: AbortSignal,
  options: ProductionEnvironmentDoctorOptions = {},
): Promise<void> {
  signal.throwIfAborted();
  const node: CompiledCommandNode = Object.freeze({
    id: "flow-doctor-native-sandbox",
    type: "command" as const,
    dependsOn: Object.freeze([]),
    command: Object.freeze({
      executable: options.nodeExecutable ?? process.execPath,
      args: Object.freeze(["-e", ""]),
      timeoutMs: 2_000,
    }),
  });
  const context: NodeExecutionContext = Object.freeze({
    runId: "flow-doctor",
    workflowId: "flow-doctor",
    attempt: 1,
    cwd: root,
    protectedPaths: Object.freeze([]),
    signal,
  });
  try {
    const outcome = await (
      options.createExecutor ??
      ((projectRoot) => createProductionNodeExecutor("native", projectRoot))
    )(root).execute(node, context);
    signal.throwIfAborted();
    if (outcome.status !== "succeeded") {
      throw new Error("native sandbox probe failed");
    }
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error("configured native sandbox is unavailable", { cause });
  }
}
