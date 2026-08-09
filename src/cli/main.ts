#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ApprovalDecisionError,
  decideApproval,
  trySubmitAgentCommandApprovalDecision,
} from "../application/command-approval.js";
import type {
  AgentCommandApprovalDecisionChannel,
  NodeEffectReconciler,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../application/ports.js";
import { RunRecoveryError, resumeWorkflow, runWorkflow } from "../application/run-workflow.js";
import {
  admitWorkflowPackages,
  compileWorkflowFromSnapshot,
} from "../application/workflow-package-admission.js";
import {
  type CapabilitySnapshot,
  combineCapabilitySnapshots,
} from "../domain/capability/agent-skills.js";
import { assertCapabilityBundleSha256 } from "../domain/capability/capability-bundles.js";
import {
  parseWorkflowPackageLocator,
  type WorkflowPackageSnapshot,
  workflowPackageSource,
} from "../domain/capability/workflow-packages.js";
import {
  collectWorkflowAgentSkillNames,
  collectWorkflowToolPackageReferences,
  collectWorkflowVerifierPackageReferences,
  WorkflowCapabilityError,
} from "../domain/capability/workflow-capabilities.js";
import {
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FlowConfigError,
} from "../domain/config/resolver.js";
import { type RunStatus, reduceRunEvents } from "../domain/run/events.js";
import {
  type WorkflowPackageReference,
  WorkflowCompilationError,
} from "../domain/workflow/compiler.js";
import type { CompiledWorkflow } from "../domain/workflow/types.js";
import {
  type FlowConfigLocationOptions,
  FlowConfigStoreError,
  type InitializedFlowProject,
  type InitializeFlowProjectOptions,
  initializeFlowProject,
  loadEffectiveFlowConfig,
} from "../infrastructure/fs/flow-config-store.js";
import { AdmissionStoreError } from "../infrastructure/fs/jsonl-admission-store.js";
import { JsonlRunStore, RunStoreError } from "../infrastructure/fs/jsonl-run-store.js";
import {
  LocalAgentCommandApprovalChannel,
  LocalAgentCommandApprovalChannelError,
} from "../infrastructure/fs/local-agent-command-approval-channel.js";
import {
  AgentSkillCatalogError,
  type ProjectAgentSkillCatalog,
  snapshotSelectedAgentSkills,
} from "../infrastructure/fs/local-agent-skill-catalog.js";
import {
  LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../infrastructure/fs/local-supervisor-store.js";
import {
  CapabilityPackageStoreError,
  LocalCapabilityPackageStore,
} from "../infrastructure/fs/local-capability-package-store.js";
import {
  CapabilityBundlePackError,
  packCapabilityBundleDirectory,
} from "../infrastructure/fs/capability-bundle-packer.js";
import {
  type ProjectToolPackageCatalog,
  snapshotSelectedToolPackages,
  ToolPackageCatalogError,
} from "../infrastructure/fs/local-tool-package-catalog.js";
import {
  type ProjectVerifierPackageCatalog,
  snapshotSelectedVerifierPackages,
  VerifierPackageCatalogError,
} from "../infrastructure/fs/local-verifier-package-catalog.js";
import {
  type ProjectWorkflowPackageCatalog,
  snapshotSelectedWorkflowPackages,
  WorkflowPackageCatalogError,
} from "../infrastructure/fs/local-workflow-package-catalog.js";
import { discoverProjectCapabilityCatalogs } from "../infrastructure/fs/project-capability-catalog.js";
import { createProductionCapabilityBundleFetcher } from "../infrastructure/http/node-https-capability-bundle-transport.js";
import {
  CapabilityBundleFetchError,
  type CapabilityBundleFetcher,
} from "../infrastructure/http/strict-capability-bundle-fetcher.js";
import { createProductionNodeEffectReconciler } from "../infrastructure/runtime/production-effect-reconciler.js";
import { createProductionNodeExecutor } from "../infrastructure/runtime/production-node-executor.js";
import { createProductionWorkspaceIsolator } from "../infrastructure/runtime/production-workspace-isolator.js";
import {
  ensureSupervisor,
  requestSupervisor,
  runSupervisorDaemon,
  type SupervisorPolicy,
} from "../supervisor/daemon.js";
import type {
  SubmitCommand,
  SupervisorErrorCode,
  SupervisorResponse,
  SupervisorResult,
} from "../supervisor/protocol.js";
import { SupervisorServiceError } from "../supervisor/service.js";
import { executeWorkerJob } from "../supervisor/worker.js";

const HELP = `Flow — Provider-neutral coding-agent harness

Usage:
  flow init [directory] [--force]
  flow config show
  flow skills list
  flow skills inspect <name>
  flow skills validate
  flow verifiers list
  flow verifiers inspect <name>
  flow verifiers validate
  flow tools list
  flow tools inspect <name> --version <exact>
  flow tools validate
  flow workflows list
  flow workflows inspect <name> --version <exact>
  flow workflows validate
  flow packages install <https-url> --sha256 <64-lowercase-hex>
  flow packages pack <source-directory> --output <bundle.flowpkg>
  flow packages list
  flow packages inspect <name> --version <exact>
  flow packages verify
  flow packages remove <name> --version <exact>
  flow validate <workflow.yaml|workflow:name@version>
  flow run <workflow.yaml|workflow:name@version> [--detach] [--command-id <uuid>] [--run-id <id>] [--runs-dir <path>] [--cwd <path>]
  flow resume <workflow.yaml|workflow:name@version> --run-id <id> [--detach] [--command-id <uuid>] [--runs-dir <path>] [--cwd <path>]
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
  readonly createAgentCommandApprovalChannel: (
    rootDirectory: string,
  ) => AgentCommandApprovalDecisionChannel;
  readonly createWorkspaceIsolator: (runsDirectory: string) => WorkspaceIsolator;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly initializeProject: (
    directory: string,
    options?: InitializeFlowProjectOptions,
  ) => Promise<InitializedFlowProject>;
  readonly loadConfig: (options?: FlowConfigLocationOptions) => Promise<EffectiveFlowConfig>;
  readonly capabilityBundleFetcher: CapabilityBundleFetcher;
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
      case "skills":
        return await skillsCommand(args.slice(1), io, dependencyOverrides);
      case "verifiers":
        return await verifiersCommand(args.slice(1), io, dependencyOverrides);
      case "tools":
        return await toolsCommand(args.slice(1), io, dependencyOverrides);
      case "workflows":
        return await workflowsCommand(args.slice(1), io, dependencyOverrides);
      case "packages":
        return await packagesCommand(args.slice(1), io, dependencyOverrides);
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
    if (error instanceof AgentSkillCatalogError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (
      error instanceof CapabilityBundleFetchError ||
      error instanceof CapabilityPackageStoreError ||
      error instanceof CapabilityBundlePackError
    ) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (
      error instanceof VerifierPackageCatalogError ||
      error instanceof ToolPackageCatalogError ||
      error instanceof WorkflowPackageCatalogError ||
      error instanceof WorkflowCapabilityError
    ) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof RunStoreError) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof LocalAgentCommandApprovalChannelError) {
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

async function skillsCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals } = parseCommandArgs(args, {});
  const subcommand = positionals[0];
  if (
    (subcommand !== "list" && subcommand !== "validate" && subcommand !== "inspect") ||
    (subcommand === "inspect" ? positionals.length !== 2 : positionals.length !== 1)
  ) {
    throw new CliUsageError("skills requires list, validate, or inspect <name>");
  }
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const catalog = await discoverConfiguredAgentSkills(config);

  if (subcommand === "list") {
    io.stdout(
      JSON.stringify(
        {
          root: catalog.root,
          skills: catalog.skills.map(({ directory: _directory, ...skill }) => skill),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcommand === "inspect") {
    const name = positionals[1];
    if (name === undefined) {
      throw new CliUsageError("skills inspect requires one Agent Skill name");
    }
    const snapshot = await snapshotSelectedAgentSkills(catalog, [name]);
    const skill = snapshot.packages[0];
    if (skill === undefined) {
      throw new AgentSkillCatalogError("missing_skill", `Agent Skill "${name}" was not found`);
    }
    io.stdout(
      JSON.stringify(
        {
          ...skill,
          files: skill.files.map(({ contentBase64: _contentBase64, ...file }) => file),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const skill of catalog.skills) {
    await snapshotSelectedAgentSkills(catalog, [skill.name]);
  }
  io.stdout(
    JSON.stringify(
      { valid: true, root: catalog.root, skills: catalog.skills.map((skill) => skill.name) },
      null,
      2,
    ),
  );
  return 0;
}

async function verifiersCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals } = parseCommandArgs(args, {});
  const subcommand = positionals[0];
  if (
    (subcommand !== "list" && subcommand !== "validate" && subcommand !== "inspect") ||
    (subcommand === "inspect" ? positionals.length !== 2 : positionals.length !== 1)
  ) {
    throw new CliUsageError("verifiers requires list, validate, or inspect <name>");
  }
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const catalog = await discoverConfiguredVerifierPackages(config);

  if (subcommand === "list") {
    io.stdout(
      JSON.stringify(
        {
          root: catalog.root,
          packages: catalog.packages.map(
            ({ directory: _directory, manifestSha256, definition, ...item }) => ({
              ...item,
              definition: { kind: definition.kind },
              manifestSha256,
            }),
          ),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcommand === "inspect") {
    const name = positionals[1];
    if (name === undefined) {
      throw new CliUsageError("verifiers inspect requires one package name");
    }
    const discovered = catalog.packages.find((item) => item.name === name);
    if (discovered === undefined) {
      throw new VerifierPackageCatalogError(
        "missing_package",
        `verifier package "${name}" was not found`,
      );
    }
    const snapshot = await snapshotSelectedVerifierPackages(catalog, [
      { name, version: discovered.version },
    ]);
    const selected = snapshot.packages[0];
    if (selected === undefined) {
      throw new VerifierPackageCatalogError(
        "missing_package",
        `verifier package "${name}" was not captured`,
      );
    }
    const { contentBase64: _contentBase64, ...manifest } = selected.manifest;
    const { definition: _definition, ...identity } = selected;
    io.stdout(JSON.stringify({ ...identity, manifest }, null, 2));
    return 0;
  }

  for (const item of catalog.packages) {
    await snapshotSelectedVerifierPackages(catalog, [{ name: item.name, version: item.version }]);
  }
  io.stdout(
    JSON.stringify(
      {
        valid: true,
        root: catalog.root,
        packages: catalog.packages.map((item) => `${item.name}@${item.version}`),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function toolsCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    version: { type: "string" },
  });
  const subcommand = positionals[0];
  if (
    (subcommand !== "list" && subcommand !== "validate" && subcommand !== "inspect") ||
    (subcommand === "inspect" ? positionals.length !== 2 : positionals.length !== 1) ||
    (subcommand === "inspect" ? values.version === undefined : values.version !== undefined)
  ) {
    throw new CliUsageError("tools requires list, validate, or inspect <name> --version <exact>");
  }
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const catalog = await discoverConfiguredToolPackages(config);

  if (subcommand === "list") {
    io.stdout(
      JSON.stringify(
        {
          root: catalog.root,
          packages: catalog.packages.map(
            ({ directory: _directory, definition, manifestSha256, ...item }) => ({
              ...item,
              driver: {
                kind: definition.driver.kind,
                version: definition.driver.version,
                profile: definition.driver.profile,
              },
              manifestSha256,
            }),
          ),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcommand === "inspect") {
    const name = positionals[1];
    const version = values.version;
    if (name === undefined || version === undefined) {
      throw new CliUsageError("tools inspect requires <name> --version <exact>");
    }
    const snapshot = await snapshotSelectedToolPackages(catalog, [{ name, version }]);
    const selected = snapshot.packages.find((item) => item.kind === "tool-package");
    if (selected === undefined) {
      throw new ToolPackageCatalogError(
        "missing_package",
        `tool package "${name}" version "${version}" was not captured`,
      );
    }
    const { contentBase64: _contentBase64, ...manifest } = selected.manifest;
    io.stdout(JSON.stringify({ ...selected, manifest }, null, 2));
    return 0;
  }

  for (const item of catalog.packages) {
    await snapshotSelectedToolPackages(catalog, [{ name: item.name, version: item.version }]);
  }
  io.stdout(
    JSON.stringify(
      {
        valid: true,
        root: catalog.root,
        packages: catalog.packages.map((item) => `${item.name}@${item.version}`),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function workflowsCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    version: { type: "string" },
  });
  const subcommand = positionals[0];
  if (
    (subcommand !== "list" && subcommand !== "validate" && subcommand !== "inspect") ||
    (subcommand === "inspect" ? positionals.length !== 2 : positionals.length !== 1) ||
    (subcommand === "inspect" ? values.version === undefined : values.version !== undefined)
  ) {
    throw new CliUsageError(
      "workflows requires list, validate, or inspect <name> --version <exact>",
    );
  }
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const catalog = await discoverConfiguredWorkflowPackages(config);

  if (subcommand === "list") {
    io.stdout(
      JSON.stringify(
        {
          root: catalog.root,
          packages: catalog.packages.map(({ directory: _directory, ...item }) => item),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcommand === "inspect") {
    const name = positionals[1];
    const version = values.version;
    if (name === undefined || version === undefined) {
      throw new CliUsageError("workflows inspect requires <name> --version <exact>");
    }
    const snapshot = await snapshotSelectedWorkflowPackages(catalog, [{ name, version }]);
    const selected = snapshot.packages.find((item) => item.kind === "workflow-package");
    if (selected === undefined) {
      throw new WorkflowPackageCatalogError(
        "missing_package",
        `workflow package "${name}" version "${version}" was not captured`,
      );
    }
    const { contentBase64: _contentBase64, ...manifest } = selected.manifest;
    io.stdout(JSON.stringify({ ...selected, manifest }, null, 2));
    return 0;
  }

  const loadPackage = workflowPackageLoader(catalog);
  for (const item of catalog.packages) {
    const snapshot = await loadPackage({ name: item.name, version: item.version });
    await admitWorkflowPackages({ source: { kind: "package", snapshot }, loadPackage });
  }
  io.stdout(
    JSON.stringify(
      {
        valid: true,
        root: catalog.root,
        packages: catalog.packages.map((item) => `${item.name}@${item.version}`),
      },
      null,
      2,
    ),
  );
  return 0;
}

async function packagesCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    output: { type: "string" },
    sha256: { type: "string" },
    version: { type: "string" },
  });
  const subcommand = positionals[0];
  const valid =
    (subcommand === "install" &&
      positionals.length === 2 &&
      values.output === undefined &&
      values.sha256 !== undefined &&
      values.version === undefined) ||
    (subcommand === "pack" &&
      positionals.length === 2 &&
      values.output !== undefined &&
      values.sha256 === undefined &&
      values.version === undefined) ||
    ((subcommand === "list" || subcommand === "verify") &&
      positionals.length === 1 &&
      values.output === undefined &&
      values.sha256 === undefined &&
      values.version === undefined) ||
    ((subcommand === "inspect" || subcommand === "remove") &&
      positionals.length === 2 &&
      values.output === undefined &&
      values.sha256 === undefined &&
      values.version !== undefined);
  if (!valid) {
    throw new CliUsageError(
      "packages requires pack <source-directory> --output <bundle.flowpkg>, install <https-url> --sha256 <hex>, list, inspect <name> --version <exact>, verify, or remove <name> --version <exact>",
    );
  }
  const dependencies = configDependenciesFrom(overrides);
  if (subcommand === "pack") {
    const sourceDirectory = positionals[1];
    const output = values.output;
    if (sourceDirectory === undefined || output === undefined) {
      throw new CliUsageError(
        "packages pack requires <source-directory> --output <bundle.flowpkg>",
      );
    }
    const created = await packCapabilityBundleDirectory(
      resolve(dependencies.cwd, sourceDirectory),
      resolve(dependencies.cwd, output),
    );
    io.stdout(
      JSON.stringify(
        {
          status: "packed",
          name: created.bundle.name,
          version: created.bundle.version,
          bytes: created.bundle.bytes,
          digest: created.bundle.digest,
          packages: created.bundle.packages.map(capabilityBundlePackageSummary),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  if (config.projectRoot === null) {
    throw new CapabilityPackageStoreError(
      "io",
      "capability packages require a Flow project root containing .flow",
    );
  }
  const store = new LocalCapabilityPackageStore(config.projectRoot);
  if (subcommand === "install") {
    const source = positionals[1];
    const expectedSha256 = values.sha256;
    if (source === undefined || expectedSha256 === undefined) {
      throw new CliUsageError("packages install requires <https-url> --sha256 <hex>");
    }
    try {
      assertCapabilityBundleSha256(expectedSha256);
    } catch (error) {
      throw new CapabilityPackageStoreError(
        "invalid_bundle",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const fetcher = overrides.capabilityBundleFetcher ?? createProductionCapabilityBundleFetcher();
    const content = await fetcher.fetch(source, overrides.signal);
    const installed = await store.install({ source, expectedSha256, content });
    io.stdout(
      JSON.stringify(
        {
          status: installed.status,
          name: installed.bundle.name,
          version: installed.bundle.version,
          description: installed.bundle.description,
          ...(installed.bundle.license === undefined ? {} : { license: installed.bundle.license }),
          ...(installed.bundle.compatibility === undefined
            ? {}
            : { compatibility: installed.bundle.compatibility }),
          bytes: installed.bundle.bytes,
          digest: installed.bundle.digest,
          packages: installed.bundle.packages.map(capabilityBundlePackageSummary),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (subcommand === "list") {
    io.stdout(JSON.stringify(await store.list(), null, 2));
    return 0;
  }
  if (subcommand === "verify") {
    const verified = await store.verify();
    io.stdout(
      JSON.stringify(
        {
          valid: true,
          bundles: verified.length,
          packages: verified.reduce((total, item) => total + item.bundle.packages.length, 0),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const name = positionals[1];
  const version = values.version;
  if (name === undefined || version === undefined) {
    throw new CliUsageError(`packages ${subcommand} requires <name> --version <exact>`);
  }
  if (subcommand === "remove") {
    const removed = await store.remove(name, version);
    io.stdout(
      JSON.stringify(
        {
          status: removed.status,
          cleanup: removed.cleanup,
          name: removed.entry.name,
          version: removed.entry.version,
          digest: removed.entry.digest,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const verified = await store.verify();
  const selected = verified.find(
    (item) => item.entry.name === name && item.entry.version === version,
  );
  if (selected === undefined) {
    throw new CapabilityPackageStoreError(
      "not_found",
      `capability bundle ${name}@${version} is not installed`,
    );
  }
  io.stdout(
    JSON.stringify(
      {
        valid: true,
        ...selected.entry,
        description: selected.bundle.description,
        ...(selected.bundle.license === undefined ? {} : { license: selected.bundle.license }),
        ...(selected.bundle.compatibility === undefined
          ? {}
          : { compatibility: selected.bundle.compatibility }),
        packages: selected.bundle.packages.map(capabilityBundlePackageSummary),
      },
      null,
      2,
    ),
  );
  return 0;
}

function capabilityBundlePackageSummary(
  item: Awaited<
    ReturnType<LocalCapabilityPackageStore["verify"]>
  >[number]["bundle"]["packages"][number],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: item.kind,
    name: item.name,
    ...(item.kind === "agent-skill" ? {} : { version: item.version }),
  });
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
  const store = dependencies.createStore(runsDirectory);
  const agentSubmission = await trySubmitAgentCommandApprovalDecision({
    runId,
    requestId,
    actor,
    store,
    sink: dependencies.createAgentCommandApprovalChannel(runsDirectory),
    ...(decision === "approve"
      ? { decision }
      : {
          decision,
          ...(values.reason === undefined ? {} : { reason: values.reason }),
        }),
  });
  if (agentSubmission !== null) {
    io.stdout(JSON.stringify(agentSubmission, null, 2));
    return 0;
  }
  const state = await decideApproval({
    runId,
    requestId,
    actor,
    store,
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
    "resume requires one workflow path or exact workflow: locator",
  );
  const runId = requireStringOption(values["run-id"], "resume requires --run-id <id>");
  const dependencies = dependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const store = dependencies.createStore(runsDirectory);
  // Durable history is read without claiming ownership so package bytes can be reconstructed
  // before recovery performs its authoritative claim and compatibility checks.
  const durableState = reduceRunEvents(await store.read(runId));
  const capabilitySnapshot = durableState.capabilitySnapshot ?? undefined;
  const admitted = await admitResumeWorkflowArgument(
    workflowArgument,
    capabilitySnapshot,
    dependencies,
  );
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
        sourceName: admitted.sourceName,
        workflowSource: admitted.source,
        cwd: executionCwd,
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      },
      runsDirectory,
      config,
      io,
    );
  }
  const state = await resumeWorkflow(admitted.workflow, {
    cwd: executionCwd,
    protectedPaths: [runsDirectory],
    runId,
    store,
    workspaceIsolator: dependencies.createWorkspaceIsolator(runsDirectory),
    executor: dependencies.executor,
    effectReconciler: dependencies.effectReconciler,
    agentCommandApprovalDecisions: dependencies.createAgentCommandApprovalChannel(runsDirectory),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
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
    "validate requires one workflow path or exact workflow: locator",
  );
  const dependencies = dependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const admitted = await admitWorkflowArgument(workflowArgument, config, dependencies);
  const supplementalSnapshot = await resolveWorkflowCapabilitySnapshot(admitted.workflow, config);
  const capabilitySnapshot = combineOptionalCapabilitySnapshots([
    admitted.capabilitySnapshot,
    supplementalSnapshot,
  ]);
  const skillCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "agent-skill").length ?? 0;
  const verifierPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "verifier-package").length ?? 0;
  const toolPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "tool-package").length ?? 0;
  const workflowPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "workflow-package").length ?? 0;

  io.stdout(
    `Workflow "${admitted.workflow.id}" is valid (nodes: ${admitted.workflow.nodes.length}, criteria: ${admitted.workflow.goal?.criteria.length ?? 0}, skills: ${skillCount}, verifier packages: ${verifierPackageCount}, tool packages: ${toolPackageCount}, workflow packages: ${workflowPackageCount}).`,
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
  const workflowArgument = requireSinglePositional(
    positionals,
    "run requires one workflow path or exact workflow: locator",
  );
  const dependencies = dependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  // Admission and immutable compilation precede run-store construction and executor invocation.
  const admitted = await admitWorkflowArgument(workflowArgument, config, dependencies);
  const supplementalSnapshot = await resolveWorkflowCapabilitySnapshot(admitted.workflow, config);
  const capabilitySnapshot = combineOptionalCapabilitySnapshots([
    admitted.capabilitySnapshot,
    supplementalSnapshot,
  ]);
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
        sourceName: admitted.sourceName,
        workflowSource: admitted.source,
        cwd: executionCwd,
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      },
      runsDirectory,
      config,
      io,
    );
  }
  const state = await runWorkflow(admitted.workflow, {
    cwd: executionCwd,
    protectedPaths: [runsDirectory],
    store: dependencies.createStore(runsDirectory),
    workspaceIsolator: dependencies.createWorkspaceIsolator(runsDirectory),
    executor: dependencies.executor,
    agentCommandApprovalDecisions: dependencies.createAgentCommandApprovalChannel(runsDirectory),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
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
    createAgentCommandApprovalChannel: dependencies.createAgentCommandApprovalChannel,
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

async function resolveWorkflowCapabilitySnapshot(
  workflow: CompiledWorkflow,
  config: EffectiveFlowConfig,
): Promise<CapabilitySnapshot | undefined> {
  const names = collectWorkflowAgentSkillNames(workflow);
  const verifierReferences = collectWorkflowVerifierPackageReferences(workflow);
  const toolReferences = collectWorkflowToolPackageReferences(workflow);
  if (names.length === 0 && verifierReferences.length === 0 && toolReferences.length === 0) {
    return undefined;
  }
  if (config.projectRoot === null) {
    if (names.length > 0) {
      throw new AgentSkillCatalogError(
        "missing_skill",
        "Agent Skills require a Flow project root containing .flow/skills",
      );
    }
    if (verifierReferences.length > 0) {
      throw new VerifierPackageCatalogError(
        "missing_package",
        "verifier packages require a Flow project root containing .flow/verifiers",
      );
    }
    throw new ToolPackageCatalogError(
      "missing_package",
      "tool packages require a Flow project root containing .flow/tools",
    );
  }
  const catalogs = await discoverProjectCapabilityCatalogs(config.projectRoot);
  const snapshots: CapabilitySnapshot[] = [];
  if (names.length > 0) {
    snapshots.push(await snapshotSelectedAgentSkills(catalogs.agentSkills, names));
  }
  if (verifierReferences.length > 0) {
    snapshots.push(await snapshotSelectedVerifierPackages(catalogs.verifiers, verifierReferences));
  }
  if (toolReferences.length > 0) {
    snapshots.push(await snapshotSelectedToolPackages(catalogs.tools, toolReferences));
  }
  return combineCapabilitySnapshots(snapshots);
}

async function admitWorkflowArgument(
  argument: string,
  config: EffectiveFlowConfig,
  dependencies: Pick<CliDependencies, "cwd" | "readTextFile">,
) {
  let catalogPromise: Promise<ProjectWorkflowPackageCatalog> | undefined;
  const loadPackage = async (reference: WorkflowPackageReference) => {
    if (config.projectRoot === null) {
      throw new WorkflowPackageCatalogError(
        "missing_package",
        "workflow packages require a Flow project root containing .flow/workflows",
      );
    }
    catalogPromise ??= discoverProjectCapabilityCatalogs(config.projectRoot).then(
      (catalogs) => catalogs.workflows,
    );
    return await workflowPackageLoader(await catalogPromise)(reference);
  };
  const locator = parseWorkflowLocator(argument);
  if (locator !== null) {
    const snapshot = await loadPackage(locator);
    return await admitWorkflowPackages({ source: { kind: "package", snapshot }, loadPackage });
  }
  const sourceName = resolve(dependencies.cwd, argument);
  const content = await dependencies.readTextFile(sourceName);
  return await admitWorkflowPackages({
    source: { kind: "inline", content, sourceName },
    loadPackage,
  });
}

function parseWorkflowLocator(value: string): WorkflowPackageReference | null {
  try {
    return parseWorkflowPackageLocator(value);
  } catch {
    throw new CliUsageError(
      'workflow locators must use "workflow:<name>@<exact-semantic-version>"',
    );
  }
}

async function admitResumeWorkflowArgument(
  argument: string,
  capabilitySnapshot: CapabilitySnapshot | undefined,
  dependencies: Pick<CliDependencies, "cwd" | "readTextFile">,
) {
  const locator = parseWorkflowLocator(argument);
  let source: string;
  let sourceName: string;
  if (locator === null) {
    sourceName = resolve(dependencies.cwd, argument);
    source = await dependencies.readTextFile(sourceName);
  } else {
    const selected = capabilitySnapshot?.packages.find(
      (item): item is WorkflowPackageSnapshot =>
        item.kind === "workflow-package" &&
        item.name === locator.name &&
        item.version === locator.version,
    );
    if (selected === undefined) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `durable run history does not contain workflow package "${locator.name}@${locator.version}"`,
      );
    }
    sourceName = `workflow:${locator.name}@${locator.version}`;
    source = workflowPackageSource(selected);
  }
  return Object.freeze({
    source,
    sourceName,
    workflow: compileWorkflowFromSnapshot({
      source,
      sourceName,
      ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
    }),
  });
}

function combineOptionalCapabilitySnapshots(
  snapshots: readonly (CapabilitySnapshot | undefined)[],
): CapabilitySnapshot | undefined {
  return combineCapabilitySnapshots(
    snapshots.filter((snapshot): snapshot is CapabilitySnapshot => snapshot !== undefined),
  );
}

async function discoverConfiguredAgentSkills(
  config: EffectiveFlowConfig,
): Promise<ProjectAgentSkillCatalog> {
  if (config.projectRoot === null) {
    throw new AgentSkillCatalogError(
      "missing_skill",
      "Agent Skills require a Flow project root containing .flow/skills",
    );
  }
  return (await discoverProjectCapabilityCatalogs(config.projectRoot)).agentSkills;
}

async function discoverConfiguredVerifierPackages(
  config: EffectiveFlowConfig,
): Promise<ProjectVerifierPackageCatalog> {
  if (config.projectRoot === null) {
    throw new VerifierPackageCatalogError(
      "missing_package",
      "verifier packages require a Flow project root containing .flow/verifiers",
    );
  }
  return (await discoverProjectCapabilityCatalogs(config.projectRoot)).verifiers;
}

async function discoverConfiguredToolPackages(
  config: EffectiveFlowConfig,
): Promise<ProjectToolPackageCatalog> {
  if (config.projectRoot === null) {
    throw new ToolPackageCatalogError(
      "missing_package",
      "tool packages require a Flow project root containing .flow/tools",
    );
  }
  return (await discoverProjectCapabilityCatalogs(config.projectRoot)).tools;
}

async function discoverConfiguredWorkflowPackages(
  config: EffectiveFlowConfig,
): Promise<ProjectWorkflowPackageCatalog> {
  if (config.projectRoot === null) {
    throw new WorkflowPackageCatalogError(
      "missing_package",
      "workflow packages require a Flow project root containing .flow/workflows",
    );
  }
  return (await discoverProjectCapabilityCatalogs(config.projectRoot)).workflows;
}

function workflowPackageLoader(
  catalog: ProjectWorkflowPackageCatalog,
): (reference: WorkflowPackageReference) => Promise<WorkflowPackageSnapshot> {
  return async (reference) => {
    const snapshot = await snapshotSelectedWorkflowPackages(catalog, [reference]);
    const selected = snapshot.packages.find(
      (item): item is WorkflowPackageSnapshot => item.kind === "workflow-package",
    );
    if (selected === undefined) {
      throw new WorkflowPackageCatalogError(
        "missing_package",
        `workflow package "${reference.name}@${reference.version}" was not captured`,
      );
    }
    return selected;
  };
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
    capabilityBundleFetcher:
      overrides.capabilityBundleFetcher ?? createProductionCapabilityBundleFetcher(),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

function storageDependenciesFrom(
  overrides: Partial<CliDependencies>,
): Pick<CliDependencies, "cwd" | "createStore" | "createAgentCommandApprovalChannel"> {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    createStore: overrides.createStore ?? ((rootDirectory) => new JsonlRunStore(rootDirectory)),
    createAgentCommandApprovalChannel:
      overrides.createAgentCommandApprovalChannel ??
      ((rootDirectory) => new LocalAgentCommandApprovalChannel(rootDirectory)),
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
): Pick<
  CliDependencies,
  "cwd" | "createStore" | "createAgentCommandApprovalChannel" | "loadConfig"
> {
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
