#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { ApprovalDecisionError, decideApproval } from "../application/command-approval.js";
import type {
  NodeEffectReconciler,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../application/ports.js";
import { resumeWorkflow, RunRecoveryError, runWorkflow } from "../application/run-workflow.js";
import {
  calculateFlowPolicyDigest,
  FlowConfigError,
  type EffectiveFlowConfig,
} from "../domain/config/resolver.js";
import { reduceRunEvents, type RunStatus } from "../domain/run/events.js";
import { compileWorkflowText, WorkflowCompilationError } from "../domain/workflow/compiler.js";
import {
  FlowConfigStoreError,
  initializeFlowProject,
  type InitializeFlowProjectOptions,
  type InitializedFlowProject,
  loadEffectiveFlowConfig,
  type FlowConfigLocationOptions,
} from "../infrastructure/fs/flow-config-store.js";
import { AdmissionStoreError } from "../infrastructure/fs/jsonl-admission-store.js";
import { JsonlRunStore, RunStoreError } from "../infrastructure/fs/jsonl-run-store.js";
import {
  LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../infrastructure/fs/local-supervisor-store.js";
import { createProductionNodeEffectReconciler } from "../infrastructure/runtime/production-effect-reconciler.js";
import { createProductionNodeExecutor } from "../infrastructure/runtime/production-node-executor.js";
import { createProductionWorkspaceIsolator } from "../infrastructure/runtime/production-workspace-isolator.js";
import {
  ensureSupervisor,
  requestSupervisor,
  runSupervisorDaemon,
  type SupervisorPolicy,
} from "../supervisor/daemon.js";
import { SupervisorServiceError } from "../supervisor/service.js";
import type {
  SubmitCommand,
  SupervisorErrorCode,
  SupervisorResponse,
  SupervisorResult,
} from "../supervisor/protocol.js";
import { executeWorkerJob } from "../supervisor/worker.js";

const HELP = `Flow — Provider-neutral coding-agent harness

Usage:
  flow init [directory] [--force]
  flow config show
  flow validate <workflow.yaml>
  flow run <workflow.yaml> [--detach] [--command-id <uuid>] [--run-id <id>] [--runs-dir <path>] [--cwd <path>]
  flow resume <workflow.yaml> --run-id <id> [--detach] [--command-id <uuid>] [--runs-dir <path>] [--cwd <path>]
  flow approve <run-id> <request-id> --actor <label> [--runs-dir <path>]
  flow deny <run-id> <request-id> --actor <label> [--reason <text>] [--runs-dir <path>]
  flow cancel <run-id> --actor <label> [--reason <text>] [--command-id <uuid>] [--runs-dir <path>]
  flow events <run-id> [--after <sequence>] [--limit <count>] [--follow] [--runs-dir <path>]
  flow inspect <run-id> [--runs-dir <path>]
  flow supervisor status [--runs-dir <path>]
  flow supervisor shutdown [--runs-dir <path>]
  flow --help
`;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliDependencies {
  readonly cwd: string;
  readonly executor: NodeExecutor;
  readonly effectReconciler: NodeEffectReconciler;
  readonly createStore: (rootDirectory: string) => RecoverableRunEventStore;
  readonly createWorkspaceIsolator: (runsDirectory: string) => WorkspaceIsolator;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly initializeProject: (
    directory: string,
    options?: InitializeFlowProjectOptions,
  ) => Promise<InitializedFlowProject>;
  readonly loadConfig: (options?: FlowConfigLocationOptions) => Promise<EffectiveFlowConfig>;
  readonly signal?: AbortSignal;
}

const processIo: CliIo = {
  stdout: (text) => writeProcessOutput(process.stdout, `${text}\n`),
  stderr: (text) => writeProcessOutput(process.stderr, `${text}\n`),
};
let processWriteTail: Promise<void> = Promise.resolve();

export function writeProcessOutput(stream: NodeJS.WriteStream, text: string): void {
  const write = new Promise<void>((resolveWrite) => {
    stream.write(text, () => resolveWrite());
  });
  processWriteTail = Promise.all([processWriteTail, write]).then(() => undefined);
}

export async function flushProcessOutput(): Promise<void> {
  await processWriteTail;
}

export async function main(
  args: readonly string[],
  io: CliIo = processIo,
  dependencyOverrides: Partial<CliDependencies> = {},
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    io.stdout(HELP);
    return 0;
  }

  const command = args[0];
  try {
    switch (command) {
      case "init":
        return await initCommand(args.slice(1), io, dependencyOverrides);
      case "config":
        return await configCommand(args.slice(1), io, dependencyOverrides);
      case "validate":
        return await validateCommand(args.slice(1), io, dependencyOverrides);
      case "run":
        return await runCommand(args.slice(1), io, dependencyOverrides);
      case "resume":
        return await resumeCommand(args.slice(1), io, dependencyOverrides);
      case "approve":
        return await approvalDecisionCommand("approve", args.slice(1), io, dependencyOverrides);
      case "deny":
        return await approvalDecisionCommand("deny", args.slice(1), io, dependencyOverrides);
      case "cancel":
        return await cancelCommand(args.slice(1), io, dependencyOverrides);
      case "events":
        return await eventsCommand(args.slice(1), io, dependencyOverrides);
      case "inspect":
        return await inspectCommand(args.slice(1), io, dependencyOverrides);
      case "supervisor":
        return await supervisorCommand(args.slice(1), io, dependencyOverrides);
      case "__supervisor":
        return await internalSupervisorCommand(args.slice(1), dependencyOverrides);
      case "__worker":
        return await internalWorkerCommand(args.slice(1), dependencyOverrides);
      default:
        throw new CliUsageError(`Unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n\n${HELP}`);
      return 2;
    }
    if (error instanceof WorkflowCompilationError) {
      io.stderr(formatCompilationError(error));
      return 2;
    }
    if (error instanceof FlowConfigError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 2;
    }
    if (error instanceof FlowConfigStoreError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof RunStoreError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof LocalSupervisorStoreError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof AdmissionStoreError || error instanceof SupervisorServiceError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof SupervisorCommandError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof RunRecoveryError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof ApprovalDecisionError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }

    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function initCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const force = extractBooleanFlag(args, "--force");
  const { positionals } = parseCommandArgs(force.args, {});
  if (positionals.length > 1) {
    throw new CliUsageError("init accepts at most one directory");
  }
  const dependencies = configDependenciesFrom(overrides);
  const directory = resolve(dependencies.cwd, positionals[0] ?? ".");
  const result = await dependencies.initializeProject(
    directory,
    force.enabled ? { replace: true } : undefined,
  );
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}

async function configCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals } = parseCommandArgs(args, {});
  if (positionals.length !== 1 || positionals[0] !== "show") {
    throw new CliUsageError("config requires the show subcommand");
  }
  const dependencies = configDependenciesFrom(overrides);
  const result = await dependencies.loadConfig({ cwd: dependencies.cwd });
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}

async function approvalDecisionCommand(
  decision: "approve" | "deny",
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    actor: { type: "string" },
    "runs-dir": { type: "string" },
    ...(decision === "deny" ? { reason: { type: "string" as const } } : {}),
  });
  const [runId, requestId] = requireTwoPositionals(
    positionals,
    `${decision} requires one run id and one request id`,
  );
  const actor = requireStringOption(values.actor, `${decision} requires --actor <label>`);
  const dependencies = controlDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const state = await decideApproval({
    runId,
    requestId,
    actor,
    store: dependencies.createStore(runsDirectory),
    ...(decision === "approve"
      ? { decision }
      : {
          decision,
          ...(values.reason === undefined ? {} : { reason: values.reason }),
        }),
  });

  io.stdout(JSON.stringify(state, null, 2));
  return 0;
}

async function resumeCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const detached = extractBooleanFlag(args, "--detach");
  const { positionals, values } = parseCommandArgs(detached.args, {
    "command-id": { type: "string" },
    "run-id": { type: "string" },
    "runs-dir": { type: "string" },
    cwd: { type: "string" },
  });
  const workflowArgument = requireSinglePositional(
    positionals,
    "resume requires one workflow path",
  );
  const runId = requireStringOption(values["run-id"], "resume requires --run-id <id>");
  const dependencies = dependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const workflowPath = resolve(dependencies.cwd, workflowArgument);

  // Compilation intentionally precedes store construction and ownership acquisition.
  const workflowSource = await dependencies.readTextFile(workflowPath);
  const workflow = compileWorkflowText(workflowSource, workflowPath);
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const executionCwd = resolve(dependencies.cwd, values.cwd ?? ".");
  const commandId = detachedCommandId(values["command-id"], detached.enabled);
  if (detached.enabled) {
    return await submitDetached(
      {
        type: "submit",
        policyDigest: config.policyDigest,
        commandId: commandId ?? randomUUID(),
        mode: "resume",
        runId,
        sourceName: workflowPath,
        workflowSource,
        cwd: executionCwd,
      },
      runsDirectory,
      config,
      io,
    );
  }
  const state = await resumeWorkflow(workflow, {
    cwd: executionCwd,
    protectedPaths: [runsDirectory],
    runId,
    store: dependencies.createStore(runsDirectory),
    workspaceIsolator: dependencies.createWorkspaceIsolator(runsDirectory),
    executor: dependencies.executor,
    effectReconciler: dependencies.effectReconciler,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });

  io.stdout(JSON.stringify(state, null, 2));
  return runStateExitCode(state.status);
}

async function validateCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals } = parseCommandArgs(args, {});
  const workflowArgument = requireSinglePositional(
    positionals,
    "validate requires one workflow path",
  );
  const dependencies = dependenciesFrom(overrides);
  const workflowPath = resolve(dependencies.cwd, workflowArgument);
  const workflow = await compileWorkflowFile(workflowPath, dependencies.readTextFile);

  io.stdout(
    `Workflow "${workflow.id}" is valid (nodes: ${workflow.nodes.length}, criteria: ${workflow.goal?.criteria.length ?? 0}).`,
  );
  return 0;
}

async function runCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const detached = extractBooleanFlag(args, "--detach");
  const { positionals, values } = parseCommandArgs(detached.args, {
    "command-id": { type: "string" },
    "run-id": { type: "string" },
    "runs-dir": { type: "string" },
    cwd: { type: "string" },
  });
  const workflowArgument = requireSinglePositional(positionals, "run requires one workflow path");
  const dependencies = dependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const workflowPath = resolve(dependencies.cwd, workflowArgument);

  // Compilation intentionally precedes construction of the run store or invocation of an executor.
  const workflowSource = await dependencies.readTextFile(workflowPath);
  const workflow = compileWorkflowText(workflowSource, workflowPath);
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const executionCwd = resolve(dependencies.cwd, values.cwd ?? ".");
  const runId = values["run-id"] ?? randomUUID();
  const commandId = detachedCommandId(values["command-id"], detached.enabled);
  if (detached.enabled) {
    return await submitDetached(
      {
        type: "submit",
        policyDigest: config.policyDigest,
        commandId: commandId ?? randomUUID(),
        mode: "run",
        runId,
        sourceName: workflowPath,
        workflowSource,
        cwd: executionCwd,
      },
      runsDirectory,
      config,
      io,
    );
  }
  const state = await runWorkflow(workflow, {
    cwd: executionCwd,
    protectedPaths: [runsDirectory],
    store: dependencies.createStore(runsDirectory),
    workspaceIsolator: dependencies.createWorkspaceIsolator(runsDirectory),
    executor: dependencies.executor,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    runId,
  });

  io.stdout(JSON.stringify(state, null, 2));
  return runStateExitCode(state.status);
}

async function inspectCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    "runs-dir": { type: "string" },
  });
  const runId = requireSinglePositional(positionals, "inspect requires one run id");
  const dependencies = controlDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const events = await dependencies.createStore(runsDirectory).read(runId);
  const state = reduceRunEvents(events);

  io.stdout(JSON.stringify(state, null, 2));
  return 0;
}

async function submitDetached(
  command: SubmitCommand,
  runsDirectory: string,
  policy: SupervisorPolicy,
  io: CliIo,
): Promise<number> {
  const store = new LocalSupervisorStore(runsDirectory);
  await ensureSupervisor(store, fileURLToPath(import.meta.url), policy);
  const result = requireSupervisorSuccess(await requestSupervisor(store, command));
  if (result.type !== "accepted" && result.type !== "queued" && result.type !== "rejected") {
    throw new SupervisorCommandError(
      "protocol_invalid",
      "supervisor returned a non-submission result",
    );
  }
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}

async function cancelCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    actor: { type: "string" },
    "command-id": { type: "string" },
    reason: { type: "string" },
    "runs-dir": { type: "string" },
  });
  const runId = requireSinglePositional(positionals, "cancel requires one run id");
  const actor = requireStringOption(values.actor, "cancel requires --actor <label>");
  const commandId = parseUuidOption(values["command-id"], "--command-id") ?? randomUUID();
  const dependencies = controlDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const store = new LocalSupervisorStore(runsDirectory);
  await ensureSupervisor(store, fileURLToPath(import.meta.url), config);
  const result = requireSupervisorSuccess(
    await requestSupervisor(store, {
      type: "cancel",
      policyDigest: config.policyDigest,
      commandId,
      runId,
      actor,
      ...(values.reason === undefined ? {} : { reason: values.reason }),
    }),
  );
  if (result.type !== "cancelled") {
    throw new SupervisorCommandError(
      "protocol_invalid",
      "supervisor returned a non-cancellation result",
    );
  }
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}

async function eventsCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const follow = extractBooleanFlag(args, "--follow");
  const { positionals, values } = parseCommandArgs(follow.args, {
    after: { type: "string" },
    limit: { type: "string" },
    "runs-dir": { type: "string" },
  });
  const runId = requireSinglePositional(positionals, "events requires one run id");
  let cursor = parseNonNegativeIntegerOption(values.after, "--after", 0);
  const limit = parsePositiveIntegerOption(values.limit, "--limit", 256);
  if (limit > 256) {
    throw new CliUsageError("--limit must not exceed 256");
  }
  const dependencies = controlDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const store = new LocalSupervisorStore(runsDirectory);
  await ensureSupervisor(store, fileURLToPath(import.meta.url), config);

  for (;;) {
    const result = requireSupervisorSuccess(
      await requestSupervisor(store, {
        type: "events",
        policyDigest: config.policyDigest,
        runId,
        afterSequence: cursor,
        limit,
      }),
    );
    if (result.type !== "events") {
      throw new SupervisorCommandError(
        "protocol_invalid",
        "supervisor returned a non-event result",
      );
    }
    if (!follow.enabled) {
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }
    for (const event of result.events) {
      io.stdout(JSON.stringify(event));
    }
    cursor = result.cursor;
    if (result.terminal) {
      return 0;
    }
    await delay(100);
  }
}

async function supervisorCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    "runs-dir": { type: "string" },
  });
  const subcommand = requireSinglePositional(positionals, "supervisor requires status or shutdown");
  if (subcommand !== "status" && subcommand !== "shutdown") {
    throw new CliUsageError("supervisor requires status or shutdown");
  }
  const dependencies = controlDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const store = new LocalSupervisorStore(runsDirectory);
  if (subcommand === "status") {
    const observed = requireSupervisorSuccess(
      await ensureSupervisor(store, fileURLToPath(import.meta.url), config, {
        requirePolicyMatch: false,
      }),
    );
    if (observed.type !== "status") {
      throw new SupervisorCommandError(
        "protocol_invalid",
        "supervisor startup returned a non-status result",
      );
    }
    io.stdout(JSON.stringify(observed, null, 2));
    return 0;
  }
  let policyDigest = config.policyDigest;
  if (subcommand === "shutdown") {
    const live = requireSupervisorSuccess(await requestSupervisor(store, { type: "status" }));
    if (live.type !== "status") {
      throw new SupervisorCommandError(
        "protocol_invalid",
        "supervisor returned a non-status result before shutdown",
      );
    }
    policyDigest = live.policyDigest;
  }
  const result = requireSupervisorSuccess(
    await requestSupervisor(store, {
      type: "shutdown",
      commandId: randomUUID(),
      policyDigest,
    }),
  );
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}

async function internalSupervisorCommand(
  args: readonly string[],
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    "max-active-workers": { type: "string" },
    "max-queued-jobs": { type: "string" },
    "policy-digest": { type: "string" },
    "runs-dir": { type: "string" },
    "startup-owner-token": { type: "string" },
    "startup-token": { type: "string" },
  });
  if (positionals.length !== 0) {
    throw new CliUsageError("internal supervisor accepts no positional arguments");
  }
  const dependencies = storageDependenciesFrom(overrides);
  const runsDirectory = resolve(dependencies.cwd, values["runs-dir"] ?? ".flow/runs");
  const supervisor = {
    maxActiveWorkers: parsePositiveIntegerOption(
      requireStringOption(
        values["max-active-workers"],
        "internal supervisor requires --max-active-workers",
      ),
      "--max-active-workers",
      1,
    ),
    maxQueuedJobs: parseNonNegativeIntegerOption(
      requireStringOption(
        values["max-queued-jobs"],
        "internal supervisor requires --max-queued-jobs",
      ),
      "--max-queued-jobs",
      0,
    ),
  };
  const policyDigest = requireStringOption(
    values["policy-digest"],
    "internal supervisor requires --policy-digest",
  );
  if (!/^[a-f0-9]{64}$/.test(policyDigest)) {
    throw new CliUsageError("--policy-digest requires a SHA-256 hexadecimal digest");
  }
  if (calculateFlowPolicyDigest(supervisor) !== policyDigest) {
    throw new CliUsageError("--policy-digest does not match the supplied supervisor limits");
  }
  const startupToken = requireStringOption(
    values["startup-token"],
    "internal supervisor requires --startup-token",
  );
  const startupOwnerToken = requireStringOption(
    values["startup-owner-token"],
    "internal supervisor requires --startup-owner-token",
  );
  await runSupervisorDaemon({
    store: new LocalSupervisorStore(runsDirectory),
    cliPath: fileURLToPath(import.meta.url),
    startupOwnerToken,
    startupToken,
    policy: { policyDigest, supervisor },
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
  return 0;
}

async function internalWorkerCommand(
  args: readonly string[],
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    "runs-dir": { type: "string" },
  });
  const jobId = requireSinglePositional(positionals, "internal worker requires one job id");
  const dependencies = dependenciesFrom(overrides);
  const runsDirectory = resolve(dependencies.cwd, values["runs-dir"] ?? ".flow/runs");
  return await executeWorkerJob(jobId, {
    store: new LocalSupervisorStore(runsDirectory),
    executor: dependencies.executor,
    effectReconciler: dependencies.effectReconciler,
    createRunStore: dependencies.createStore,
    createWorkspaceIsolator: dependencies.createWorkspaceIsolator,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
}

function parseCommandArgs(
  args: readonly string[],
  options: Readonly<Record<string, { readonly type: "string" }>>,
): { positionals: string[]; values: Readonly<Record<string, string | undefined>> } {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return {
      positionals: parsed.positionals,
      values: parsed.values as Readonly<Record<string, string | undefined>>,
    };
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function extractBooleanFlag(
  args: readonly string[],
  flag: string,
): { readonly args: readonly string[]; readonly enabled: boolean } {
  const occurrences = args.filter((argument) => argument === flag).length;
  if (occurrences > 1) {
    throw new CliUsageError(`${flag} may be specified only once`);
  }
  return {
    args: args.filter((argument) => argument !== flag),
    enabled: occurrences === 1,
  };
}

function parseNonNegativeIntegerOption(
  value: string | undefined,
  option: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new CliUsageError(`${option} requires a non-negative integer`);
  }
  return parsed;
}

function parsePositiveIntegerOption(
  value: string | undefined,
  option: string,
  fallback: number,
): number {
  const parsed = parseNonNegativeIntegerOption(value, option, fallback);
  if (parsed <= 0) {
    throw new CliUsageError(`${option} requires a positive integer`);
  }
  return parsed;
}

function detachedCommandId(value: string | undefined, detached: boolean): string | undefined {
  if (value !== undefined && !detached) {
    throw new CliUsageError("--command-id requires --detach for run and resume");
  }
  return detached ? (parseUuidOption(value, "--command-id") ?? randomUUID()) : undefined;
}

function parseUuidOption(value: string | undefined, option: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliUsageError(`${option} requires a UUID`);
  }
  return value;
}

function requireSupervisorSuccess(response: SupervisorResponse): SupervisorResult {
  if (!response.ok) {
    throw new SupervisorCommandError(response.error.code, response.error.message);
  }
  return response.result;
}

function requireSinglePositional(positionals: readonly string[], message: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new CliUsageError(message);
  }
  return positionals[0];
}

function requireTwoPositionals(
  positionals: readonly string[],
  message: string,
): readonly [string, string] {
  const first = positionals[0];
  const second = positionals[1];
  if (positionals.length !== 2 || first === undefined || second === undefined) {
    throw new CliUsageError(message);
  }
  return [first, second];
}

function runStateExitCode(status: RunStatus): number {
  if (status === "succeeded") {
    return 0;
  }
  return status === "waiting_for_approval" ? 3 : 1;
}

function requireStringOption(value: string | undefined, message: string): string {
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(message);
  }
  return value;
}

async function compileWorkflowFile(
  workflowPath: string,
  readTextFile: (path: string) => Promise<string>,
) {
  const source = await readTextFile(workflowPath);
  return compileWorkflowText(source, workflowPath);
}

function dependenciesFrom(overrides: Partial<CliDependencies>): CliDependencies {
  const storageDependencies = storageDependenciesFrom(overrides);
  const configDependencies = configDependenciesFrom(overrides);
  return {
    ...storageDependencies,
    ...configDependencies,
    executor: overrides.executor ?? createProductionNodeExecutor(),
    effectReconciler: overrides.effectReconciler ?? createProductionNodeEffectReconciler(),
    createWorkspaceIsolator: overrides.createWorkspaceIsolator ?? createProductionWorkspaceIsolator,
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, "utf8")),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

function storageDependenciesFrom(
  overrides: Partial<CliDependencies>,
): Pick<CliDependencies, "cwd" | "createStore"> {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    createStore: overrides.createStore ?? ((rootDirectory) => new JsonlRunStore(rootDirectory)),
  };
}

function configDependenciesFrom(
  overrides: Partial<CliDependencies>,
): Pick<CliDependencies, "cwd" | "initializeProject" | "loadConfig"> {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    initializeProject: overrides.initializeProject ?? initializeFlowProject,
    loadConfig: overrides.loadConfig ?? loadEffectiveFlowConfig,
  };
}

function controlDependenciesFrom(
  overrides: Partial<CliDependencies>,
): Pick<CliDependencies, "cwd" | "createStore" | "loadConfig"> {
  return {
    ...storageDependenciesFrom(overrides),
    loadConfig: overrides.loadConfig ?? loadEffectiveFlowConfig,
  };
}

function resolveRunsDirectory(
  invocationDirectory: string,
  explicitRunsDirectory: string | undefined,
  config: EffectiveFlowConfig,
): string {
  if (explicitRunsDirectory !== undefined) {
    return resolve(invocationDirectory, explicitRunsDirectory);
  }
  return resolve(config.projectRoot ?? invocationDirectory, ".flow/runs");
}

function formatCompilationError(error: WorkflowCompilationError): string {
  return [
    `Workflow compilation failed for ${error.sourceName}:`,
    ...error.diagnostics.map(
      (diagnostic) => `- ${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}`,
    ),
  ].join("\n");
}

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

class SupervisorCommandError extends Error {
  override readonly name = "SupervisorCommandError";

  constructor(
    readonly code: SupervisorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isDirectEntry(entryPath: string | undefined, moduleUrl = import.meta.url): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export function resolveDirectExitCode(
  mainExitCode: number,
  requestedSignalExitCode: number | undefined,
): number {
  // A durably committed success wins a signal that arrived during the final
  // append/fsync. For every non-success outcome, preserve shell signal semantics.
  return mainExitCode === 0 ? 0 : (requestedSignalExitCode ?? mainExitCode);
}

export function armForcedExit(
  exitCode: number,
  graceMs = 1_000,
  exit: (code: number) => never = process.exit,
): NodeJS.Timeout {
  const timer = setTimeout(() => exit(exitCode), graceMs);
  timer.unref();
  return timer;
}

if (isDirectEntry(process.argv[1])) {
  const controller = new AbortController();
  let requestedExitCode: number | undefined;
  let signalCount = 0;
  const handleSignal = (signal: "SIGINT" | "SIGTERM") => {
    signalCount += 1;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    if (signalCount > 1) {
      process.exit(exitCode);
    }
    requestedExitCode = exitCode;
    controller.abort(new Error(`Flow received ${signal}`));
  };
  const handleInterrupt = () => handleSignal("SIGINT");
  const handleTermination = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleInterrupt);
  process.once("SIGTERM", handleTermination);
  try {
    const exitCode = await main(process.argv.slice(2), processIo, { signal: controller.signal });
    await flushProcessOutput();
    const resolvedExitCode = resolveDirectExitCode(exitCode, requestedExitCode);
    process.exitCode = resolvedExitCode;
    // Once durable state and user-visible output are complete, prevent any
    // provider-owned socket or timer from keeping the standalone CLI alive.
    armForcedExit(resolvedExitCode);
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }
}
