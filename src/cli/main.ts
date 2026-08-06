#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { NodeExecutorRouter } from "../application/node-executor-router.js";
import type { NodeExecutor, RunEventStore } from "../application/ports.js";
import { runWorkflow } from "../application/run-workflow.js";
import { reduceRunEvents } from "../domain/run/events.js";
import { compileWorkflowText, WorkflowCompilationError } from "../domain/workflow/compiler.js";
import { JsonlRunStore, RunStoreError } from "../infrastructure/fs/jsonl-run-store.js";
import { PiAgentExecutor } from "../infrastructure/pi/pi-agent-executor.js";
import { CommandNodeExecutor } from "../infrastructure/process/command-node-executor.js";

const HELP = `Flow — Provider-neutral harness for evidence-driven software workflows

Usage:
  flow validate <workflow.yaml>
  flow run <workflow.yaml> [--run-id <id>] [--runs-dir <path>] [--cwd <path>]
  flow inspect <run-id> [--runs-dir <path>]
  flow --help
`;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliDependencies {
  readonly cwd: string;
  readonly executor: NodeExecutor;
  readonly createStore: (rootDirectory: string) => RunEventStore;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly signal?: AbortSignal;
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

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
      case "validate":
        return await validateCommand(args.slice(1), io, dependencyOverrides);
      case "run":
        return await runCommand(args.slice(1), io, dependencyOverrides);
      case "inspect":
        return await inspectCommand(args.slice(1), io, dependencyOverrides);
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
    if (error instanceof RunStoreError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }

    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
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

  io.stdout(`Workflow "${workflow.id}" is valid (${workflow.nodes.length} nodes).`);
  return 0;
}

async function runCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    "run-id": { type: "string" },
    "runs-dir": { type: "string" },
    cwd: { type: "string" },
  });
  const workflowArgument = requireSinglePositional(positionals, "run requires one workflow path");
  const dependencies = dependenciesFrom(overrides);
  const workflowPath = resolve(dependencies.cwd, workflowArgument);

  // Compilation intentionally precedes construction of the run store or invocation of an executor.
  const workflow = await compileWorkflowFile(workflowPath, dependencies.readTextFile);
  const runsDirectory = resolve(dependencies.cwd, values["runs-dir"] ?? ".flow/runs");
  const executionCwd = resolve(dependencies.cwd, values.cwd ?? ".");
  const state = await runWorkflow(workflow, {
    cwd: executionCwd,
    store: dependencies.createStore(runsDirectory),
    executor: dependencies.executor,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(values["run-id"] === undefined ? {} : { runId: values["run-id"] }),
  });

  io.stdout(JSON.stringify(state, null, 2));
  return state.status === "succeeded" ? 0 : 1;
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
  const dependencies = dependenciesFrom(overrides);
  const runsDirectory = resolve(dependencies.cwd, values["runs-dir"] ?? ".flow/runs");
  const events = await dependencies.createStore(runsDirectory).read(runId);
  const state = reduceRunEvents(events);

  io.stdout(JSON.stringify(state, null, 2));
  return 0;
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

function requireSinglePositional(positionals: readonly string[], message: string): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new CliUsageError(message);
  }
  return positionals[0];
}

async function compileWorkflowFile(
  workflowPath: string,
  readTextFile: (path: string) => Promise<string>,
) {
  const source = await readTextFile(workflowPath);
  return compileWorkflowText(source, workflowPath);
}

function dependenciesFrom(overrides: Partial<CliDependencies>): CliDependencies {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    executor:
      overrides.executor ??
      new NodeExecutorRouter(new CommandNodeExecutor(), new PiAgentExecutor()),
    createStore: overrides.createStore ?? ((rootDirectory) => new JsonlRunStore(rootDirectory)),
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, "utf8")),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
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
    process.exitCode = requestedExitCode ?? exitCode;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGTERM", handleTermination);
  }
}
