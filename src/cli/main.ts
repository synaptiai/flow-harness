#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ApprovalDecisionError,
  decideApproval,
  trySubmitAgentCommandApprovalDecision,
} from "../application/command-approval.js";
import {
  FlowWorkflowEvaluationAdapter,
  type HarnessEvaluationAdapter,
} from "../application/evaluation-adapter.js";
import {
  ExternalHarnessEvaluationAdapter,
  type ExternalHarnessRuntime,
} from "../application/external-harness-adapter.js";
import {
  generatePromptCandidate,
  PromptCandidateGenerationExecutionError,
} from "../application/generate-prompt-candidate.js";
import type {
  AgentCommandApprovalDecisionChannel,
  NodeEffectReconciler,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../application/ports.js";
import {
  createPromptActivationFromEvaluation,
  PromptActivationAdmissionError,
} from "../application/prepare-prompt-activation.js";
import { runEvaluationTrials } from "../application/run-evaluation.js";
import { RunRecoveryError, resumeWorkflow, runWorkflow } from "../application/run-workflow.js";
import {
  admitWorkflowPackages,
  compileWorkflowFromSnapshot,
} from "../application/workflow-package-admission.js";
import {
  PromptActivationError,
  type PromptActivationSnapshot,
  parsePromptActivationLocator,
  promptActivationSource,
} from "../domain/adaptation/prompt-activation.js";
import {
  PromptCandidateError,
  projectPromptCandidate,
} from "../domain/adaptation/prompt-candidate.js";
import {
  MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  PromptCandidateGenerationError,
  preparePromptCandidateGeneration,
} from "../domain/adaptation/prompt-candidate-generation.js";
import {
  type CapabilitySnapshot,
  combineCapabilitySnapshots,
} from "../domain/capability/agent-skills.js";
import { assertCapabilityBundleSha256 } from "../domain/capability/capability-bundles.js";
import {
  collectWorkflowAgentSkillNames,
  collectWorkflowToolPackageReferences,
  collectWorkflowVerifierPackageReferences,
  WorkflowCapabilityError,
} from "../domain/capability/workflow-capabilities.js";
import {
  parseWorkflowPackageLocator,
  type WorkflowPackageSnapshot,
  workflowPackageSource,
} from "../domain/capability/workflow-packages.js";
import {
  calculateFlowPolicyDigest,
  type EffectiveFlowConfig,
  FlowConfigError,
  type FlowSandboxProfile,
} from "../domain/config/resolver.js";
import { aggregateEvaluation, EvaluationAggregationError } from "../domain/evaluation/aggregate.js";
import { parseEvaluationTrialAttempt } from "../domain/evaluation/attempt.js";
import { verifyEvaluationWorkspace } from "../domain/evaluation/filesystem-verifier.js";
import { EvaluationPlanError } from "../domain/evaluation/plan.js";
import { EvaluationRecordError } from "../domain/evaluation/records.js";
import {
  createTuningEvidencePacket,
  TuningEvidenceError,
} from "../domain/evaluation/tuning-evidence.js";
import { type RunStatus, reduceRunEvents } from "../domain/run/events.js";
import {
  WorkflowCompilationError,
  type WorkflowPackageReference,
} from "../domain/workflow/compiler.js";
import type { CompiledWorkflow, ThinkingLevel } from "../domain/workflow/types.js";
import {
  CapabilityBundlePackError,
  packCapabilityBundleDirectory,
} from "../infrastructure/fs/capability-bundle-packer.js";
import {
  EvaluationExportError,
  writeCanonicalEvaluationExport,
} from "../infrastructure/fs/evaluation-report-exporter.js";
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
  CapabilityPackageStoreError,
  LocalCapabilityPackageStore,
} from "../infrastructure/fs/local-capability-package-store.js";
import {
  admitLocalEvaluationPlan,
  EvaluationAdmissionError,
  observeEvaluationFixture,
} from "../infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  EvaluationStoreError,
  evaluationReportInput,
  LocalEvaluationStore,
  type StoredEvaluation,
} from "../infrastructure/fs/local-evaluation-store.js";
import {
  LocalPromptActivationStore,
  PromptActivationStoreError,
} from "../infrastructure/fs/local-prompt-activation-store.js";
import {
  admitLocalPromptCandidate,
  admitLocalPromptCandidateGenerationSources,
  LocalPromptCandidateError,
} from "../infrastructure/fs/local-prompt-candidate.js";
import {
  assertLocalPromptCandidateOutputAvailable,
  LocalPromptCandidatePublisherError,
  publishLocalPromptCandidate,
} from "../infrastructure/fs/local-prompt-candidate-publisher.js";
import {
  LocalSupervisorStore,
  LocalSupervisorStoreError,
} from "../infrastructure/fs/local-supervisor-store.js";
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
import type { PrimeOciPreparationResult } from "../infrastructure/oci/prime-oci-preparation.js";
import {
  BuiltInExternalHarnessRegistry,
  type ExternalHarnessRegistry,
} from "../infrastructure/process/built-in-external-harness-registry.js";
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
  flow candidate generate <baseline> <evidence>... --output <candidate.yaml> --id <id> --version <semver> --allow-nodes <id,...> --provider <provider> --model <model> [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
  flow candidate validate <candidate.yaml>
  flow candidate activate <candidate.yaml> --evaluation <id> --actor <label> [--reason <text>] [--evaluations-dir <path>] <--dry-run|--expected-digest <sha256>>
  flow activation list
  flow activation inspect <workflow-id>
  flow activation rollback <workflow-id> --to <candidate-id>@<version>|baseline --actor <label> [--reason <text>] <--dry-run|--expected-digest <sha256>>
  flow eval validate <plan.yaml>
  flow eval run <plan.yaml> [--evaluation-id <id>] [--evaluations-dir <path>]
  flow eval inspect <evaluation-id> [--evaluations-dir <path>]
  flow eval export <evaluation-id> --output <path> [--evaluations-dir <path>]
  flow eval tuning-evidence <evaluation-id> --output <path> [--evaluations-dir <path>]
  flow runtime prepare prime-agent
  flow validate <workflow.yaml|workflow:name@version|activation:workflow-id>
  flow run <workflow.yaml|workflow:name@version|activation:workflow-id> [--detach] [--command-id <uuid>] [--run-id <id>] [--runs-dir <path>] [--cwd <path>]
  flow resume <workflow.yaml|workflow:name@version|activation:workflow-id> --run-id <id> [--detach] [--command-id <uuid>] [--runs-dir <path>] [--cwd <path>]
  flow approve <run-id> <request-id> --actor <label> [--runs-dir <path>]
  flow deny <run-id> <request-id> --actor <label> [--reason <text>] [--runs-dir <path>]
  flow cancel <run-id> --actor <label> [--reason <text>] [--command-id <uuid>] [--runs-dir <path>]
  flow events <run-id> [--after <sequence>] [--limit <count>] [--follow] [--runs-dir <path>]
  flow inspect <run-id> [--runs-dir <path>]
  flow supervisor status [--runs-dir <path>]
  flow supervisor shutdown [--runs-dir <path>]
  flow --help
`;

const installedPackageMetadata = createRequire(import.meta.url)("../../package.json") as unknown;
const installedFlowVersion = parseInstalledFlowVersion(installedPackageMetadata);

export function createEvaluationEnvironment(
  input: {
    readonly platform?: string;
    readonly architecture?: string;
    readonly nodeVersion?: string;
  } = {},
) {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`evaluation is unsupported on platform "${platform.slice(0, 64)}"`);
  }
  const architecture = input.architecture ?? process.arch;
  const nodeVersion = input.nodeVersion ?? process.version;
  if (
    architecture.length === 0 ||
    architecture.length > 64 ||
    nodeVersion.length === 0 ||
    nodeVersion.length > 64
  ) {
    throw new Error("evaluation environment identity exceeds its bounds");
  }
  return Object.freeze({
    platform,
    architecture,
    nodeVersion,
    flowVersion: installedFlowVersion,
  });
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliDependencies {
  readonly cwd: string;
  readonly executor: NodeExecutor;
  readonly createNodeExecutor: (profile: FlowSandboxProfile, projectRoot?: string) => NodeExecutor;
  readonly effectReconciler: NodeEffectReconciler;
  readonly createStore: (rootDirectory: string) => RecoverableRunEventStore;
  readonly createAgentCommandApprovalChannel: (
    rootDirectory: string,
  ) => AgentCommandApprovalDecisionChannel;
  readonly createWorkspaceIsolator: (
    runsDirectory: string,
    protectedPaths?: readonly string[],
    executionRoot?: string,
    projectRoot?: string,
  ) => WorkspaceIsolator;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly initializeProject: (
    directory: string,
    options?: InitializeFlowProjectOptions,
  ) => Promise<InitializedFlowProject>;
  readonly loadConfig: (options?: FlowConfigLocationOptions) => Promise<EffectiveFlowConfig>;
  readonly capabilityBundleFetcher: CapabilityBundleFetcher;
  readonly externalHarnessRegistry: ExternalHarnessRegistry;
  readonly externalHarnessRuntime: ExternalHarnessRuntime;
  readonly preparePrimeRuntime?: (input: {
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
  }) => Promise<PrimeOciPreparationResult>;
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
      case "candidate":
        return await candidateCommand(args.slice(1), io, dependencyOverrides);
      case "activation":
        return await activationCommand(args.slice(1), io, dependencyOverrides);
      case "eval":
        return await evaluationCommand(args.slice(1), io, dependencyOverrides);
      case "runtime":
        return await runtimeCommand(args.slice(1), io, dependencyOverrides);
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
    if (error instanceof EvaluationPlanError) {
      io.stderr(boundedCliDiagnostic(error.message));
      return 2;
    }
    if (
      error instanceof EvaluationAdmissionError ||
      error instanceof EvaluationStoreError ||
      error instanceof EvaluationExportError
    ) {
      io.stderr(boundedCliDiagnostic(error.message));
      return 1;
    }
    if (error instanceof EvaluationAggregationError || error instanceof EvaluationRecordError) {
      io.stderr(error.message);
      return 1;
    }
    if (
      error instanceof PromptCandidateError ||
      error instanceof PromptCandidateGenerationError ||
      error instanceof PromptCandidateGenerationExecutionError ||
      error instanceof LocalPromptCandidateError ||
      error instanceof LocalPromptCandidatePublisherError
    ) {
      io.stderr(boundedCliDiagnostic(error.message));
      return 1;
    }
    if (
      error instanceof PromptActivationError ||
      error instanceof PromptActivationAdmissionError ||
      error instanceof PromptActivationStoreError
    ) {
      io.stderr(`${error.code}: ${boundedCliDiagnostic(error.message)}`);
      return 1;
    }
    if (error instanceof TuningEvidenceError) {
      io.stderr(boundedCliDiagnostic(error.message));
      return 1;
    }

    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runtimeCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals } = parseCommandArgs(args, {});
  if (
    positionals.length !== 2 ||
    positionals[0] !== "prepare" ||
    positionals[1] !== "prime-agent"
  ) {
    throw new CliUsageError("runtime prepare requires prime-agent");
  }
  const cwd = overrides.cwd ?? process.cwd();
  const preparePrimeRuntime =
    overrides.preparePrimeRuntime ??
    (async (input: { readonly cwd: string; readonly signal: AbortSignal | undefined }) => {
      const { prepareProductionPrimeOciRuntime } = await import(
        "../infrastructure/oci/production-prime-oci-preparation.js"
      );
      return prepareProductionPrimeOciRuntime(input);
    });
  const result = await preparePrimeRuntime({ cwd, signal: overrides.signal });
  io.stdout(JSON.stringify({ prepared: true, ...result }, null, 2));
  return 0;
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

async function evaluationCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const subcommand = args[0];
  if (subcommand === "validate") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    const planArgument = requireSinglePositional(
      positionals,
      "eval validate requires one evaluation plan path",
    );
    const cwd = overrides.cwd ?? process.cwd();
    const registry =
      overrides.externalHarnessRegistry ?? new BuiltInExternalHarnessRegistry({ cwd });
    const admitted = await admitLocalEvaluationPlan(resolve(cwd, planArgument), {
      resolveExternalHarnessIdentity: (profile) => registry.resolveIdentity(profile),
    });
    io.stdout(
      JSON.stringify(
        {
          valid: true,
          id: admitted.id,
          planDigest: admitted.planDigest,
          suite: { id: admitted.suite.id, version: admitted.suite.version },
          tasks: admitted.suite.tasks.map((task) => ({
            id: task.id,
            partition: task.partition,
          })),
          profiles: admitted.profiles.map((profile) =>
            profile.adapter !== "flow-workflow-v1"
              ? {
                  id: profile.id,
                  adapter: profile.adapter,
                  driverArtifactSha256: profile.harness.driver.artifactSha256,
                }
              : {
                  id: profile.id,
                  adapter: profile.adapter,
                  workflowDigest: profile.workflow.workflowDigest,
                  ...(profile.candidate === undefined
                    ? {}
                    : { candidateDigest: profile.candidate.candidateDigest }),
                },
          ),
          scheduledTrials: admitted.schedule.length,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcommand === "tuning-evidence") {
    const { positionals, values } = parseCommandArgs(args.slice(1), {
      "evaluations-dir": { type: "string" },
      output: { type: "string" },
    });
    const evaluationId = requireSinglePositional(
      positionals,
      "eval tuning-evidence requires one evaluation id",
    );
    const dependencies = configDependenciesFrom(overrides);
    const evaluationsDirectory = await resolveEvaluationsDirectory(
      dependencies,
      values["evaluations-dir"],
    );
    const stored = await new LocalEvaluationStore(evaluationsDirectory).read(evaluationId);
    const packet = tuningEvidence(stored);
    const output = requireStringOption(
      values.output,
      "eval tuning-evidence requires --output <path>",
    );
    const outputPath = resolve(dependencies.cwd, output);
    await writeCanonicalEvaluationExport(outputPath, packet);
    io.stdout(
      JSON.stringify(
        {
          exported: true,
          evaluationId,
          evidenceDigest: packet.evidenceDigest,
          output: outputPath,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (subcommand === "run") {
    const { positionals, values } = parseCommandArgs(args.slice(1), {
      "evaluation-id": { type: "string" },
      "evaluations-dir": { type: "string" },
    });
    const planArgument = requireSinglePositional(
      positionals,
      "eval run requires one evaluation plan path",
    );
    const dependencies = dependenciesFrom(overrides);
    const admitted = await admitLocalEvaluationPlan(resolve(dependencies.cwd, planArgument), {
      resolveExternalHarnessIdentity: (profile) =>
        dependencies.externalHarnessRegistry.resolveIdentity(profile),
    });
    const evaluationLocation = await resolveEvaluationLocation(
      dependencies,
      values["evaluations-dir"],
    );
    const evaluationsDirectory = evaluationLocation.directory;
    const hasExternalProfile = admitted.profiles.some(
      (profile) => profile.adapter !== "flow-workflow-v1",
    );
    if (hasExternalProfile && evaluationLocation.projectRoot === null) {
      throw new CliUsageError(
        "eval run requires a configured Flow project root for an external harness profile",
      );
    }
    const projectRoot = evaluationLocation.projectRoot ?? (await realpath(dependencies.cwd));
    const evaluationId = values["evaluation-id"] ?? admitted.id;
    const store = new LocalEvaluationStore(evaluationsDirectory);
    const header = createPublicEvaluationHeader(admitted, evaluationId);
    try {
      await store.read(evaluationId);
    } catch (error) {
      if (!(error instanceof EvaluationStoreError && error.code === "not_found")) {
        throw error;
      }
      await store.create(header);
    }
    const claimed = await store.claim(evaluationId, admitted.planDigest);
    const evaluationRuntime = join(evaluationsDirectory, evaluationId, "runtime");
    const runStoreDirectory = join(evaluationsDirectory, evaluationId, "runs");
    const evaluationRoot = join(evaluationsDirectory, evaluationId);
    const workspaceIsolator = dependencies.createWorkspaceIsolator(
      evaluationRuntime,
      [
        evaluationRuntime,
        ...(evaluationLocation.projectRoot === null
          ? []
          : [join(evaluationLocation.projectRoot, ".flow")]),
      ],
      evaluationRuntime,
      projectRoot,
    );
    const adapters = new Map<string, HarnessEvaluationAdapter>();
    try {
      await runEvaluationTrials({
        plan: {
          planDigest: admitted.planDigest,
          schedule: admitted.schedule,
          controls: admitted.controls,
          tasks: admitted.suite.tasks.map((task) => ({
            id: task.id,
            fixture: {
              sourceCwd: task.fixture.sourceCwd,
              digest: task.fixture.digest,
              entryCount: task.fixture.entryCount,
              logicalBytes: task.fixture.logicalBytes,
              instructionPath: task.fixture.instructionPath,
              instructionSha256: task.fixture.instructionSha256,
            },
            verifier: task.verifier,
          })),
          profiles: admitted.profiles.map((profile) => ({
            id: profile.id,
            adapter: profile.adapter,
          })),
        },
        committedRecords: claimed.records,
        attempts: {
          active: claimed.activeAttempt,
          begin: (attempt) => store.beginAttempt(evaluationId, attempt),
          update: (attempt) => store.updateAttempt(evaluationId, attempt),
          recover: async (attempt) => {
            const profile = admitted.profiles.find((item) => item.id === attempt.profileId);
            if (
              profile?.adapter !== "prime-agent-native-v1" ||
              dependencies.externalHarnessRuntime.recoverAttempt === undefined
            ) {
              throw new Error("Prime OCI attempt recovery is not available");
            }
            let current = attempt;
            return dependencies.externalHarnessRuntime.recoverAttempt(
              {
                identity: profile.harness,
                attempt,
                workspaceRoot: join(evaluationRuntime, `workspace-${attempt.trialId}`, "workspace"),
                updateOciLease: async (lease) => {
                  const updated = parseEvaluationTrialAttempt({ ...current, ociLease: lease });
                  await store.updateAttempt(evaluationId, updated);
                  current = updated;
                },
              },
              dependencies.signal,
            );
          },
          complete: (attempt) => store.completeAttempt(evaluationId, attempt),
        },
        append: (record) => store.append(evaluationId, record),
        workspaceIsolator,
        observeFixture: observeEvaluationFixture,
        resolveAdapter: (profileId, adapterKind) => {
          const existing = adapters.get(profileId);
          if (existing !== undefined) {
            return existing;
          }
          const profile = admitted.profiles.find((item) => item.id === profileId);
          if (profile === undefined || profile.adapter !== adapterKind) {
            throw new Error(`evaluation profile "${profileId}" is unavailable`);
          }
          const adapter =
            profile.adapter === "flow-workflow-v1"
              ? new FlowWorkflowEvaluationAdapter(profile, {
                  executor: dependencies.createNodeExecutor(
                    evaluationLocation.sandboxProfile,
                    projectRoot,
                  ),
                  createStore: () => dependencies.createStore(runStoreDirectory),
                  workspaceIsolator,
                  ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
                })
              : new ExternalHarnessEvaluationAdapter(profile, dependencies.externalHarnessRuntime, {
                  isolation: {
                    projectRoot,
                    protectedPaths: [
                      dirname(admitted.sourcePath),
                      evaluationRoot,
                      join(projectRoot, ".flow"),
                    ],
                  },
                  ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
                });
          adapters.set(profileId, adapter);
          return adapter;
        },
        verifyWorkspace: verifyEvaluationWorkspace,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        environment: createEvaluationEnvironment(),
      });
    } finally {
      await store.release(evaluationId);
    }
    io.stdout(JSON.stringify(evaluationEvidence(await store.read(evaluationId)), null, 2));
    return 0;
  }

  if (subcommand === "inspect" || subcommand === "export") {
    const { positionals, values } = parseCommandArgs(args.slice(1), {
      "evaluations-dir": { type: "string" },
      ...(subcommand === "export" ? { output: { type: "string" as const } } : {}),
    });
    const evaluationId = requireSinglePositional(
      positionals,
      `eval ${subcommand} requires one evaluation id`,
    );
    const dependencies = configDependenciesFrom(overrides);
    const evaluationsDirectory = await resolveEvaluationsDirectory(
      dependencies,
      values["evaluations-dir"],
    );
    const evidence = evaluationEvidence(
      await new LocalEvaluationStore(evaluationsDirectory).read(evaluationId),
    );
    if (subcommand === "inspect") {
      io.stdout(JSON.stringify(evidence, null, 2));
      return 0;
    }
    const output = requireStringOption(values.output, "eval export requires --output <path>");
    const outputPath = resolve(dependencies.cwd, output);
    await writeCanonicalEvaluationExport(outputPath, evidence);
    io.stdout(JSON.stringify({ exported: true, evaluationId, output: outputPath }, null, 2));
    return 0;
  }

  throw new CliUsageError("eval requires validate, run, inspect, export, or tuning-evidence");
}

async function candidateCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const subcommand = args[0];
  if (subcommand === "generate") {
    const { positionals, values } = parseCommandArgs(args.slice(1), {
      "allow-nodes": { type: "string" },
      "max-output-tokens": { type: "string" },
      id: { type: "string" },
      model: { type: "string" },
      output: { type: "string" },
      provider: { type: "string" },
      thinking: { type: "string" },
      "timeout-ms": { type: "string" },
      version: { type: "string" },
    });
    if (positionals.length < 2) {
      throw new CliUsageError(
        "candidate generate requires one baseline path and at least one evidence path",
      );
    }
    const [baseline, ...evidence] = positionals;
    if (baseline === undefined) {
      throw new CliUsageError("candidate generate requires one baseline path");
    }
    const dependencies = dependenciesFrom(overrides);
    const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
    const outputPath = resolve(
      dependencies.cwd,
      requireStringOption(values.output, "candidate generate requires --output <path>"),
    );
    await assertLocalPromptCandidateOutputAvailable(outputPath);
    const admitted = await admitLocalPromptCandidateGenerationSources(
      outputPath,
      resolve(dependencies.cwd, baseline),
      evidence.map((path) => resolve(dependencies.cwd, path)),
    );
    const prepared = preparePromptCandidateGeneration({
      candidate: {
        id: requireStringOption(values.id, "candidate generate requires --id <id>"),
        version: requireStringOption(
          values.version,
          "candidate generate requires --version <semver>",
        ),
      },
      baseline: {
        provenance: admitted.baseline.provenance,
        sourceSha256: admitted.baseline.sourceSha256,
        workflowDigest: admitted.baseline.workflowDigest,
        source: admitted.baseline.source,
        compiled: admitted.baseline.compiled,
      },
      evidence: admitted.evidence.map((item) => ({
        provenance: item.provenance,
        sourceSha256: item.sourceSha256,
        packet: item.packet,
      })),
      allowedNodeIds: requireStringOption(
        values["allow-nodes"],
        "candidate generate requires --allow-nodes <id,...>",
      )
        .split(",")
        .map((nodeId) => nodeId.trim()),
      model: {
        provider: requireStringOption(
          values.provider,
          "candidate generate requires --provider <provider>",
        ),
        id: requireStringOption(values.model, "candidate generate requires --model <model>"),
        thinking: parseThinkingLevel(values.thinking),
      },
      limits: {
        timeoutMs: parsePositiveIntegerOption(values["timeout-ms"], "--timeout-ms", 300_000),
        maxOutputTokens: parsePositiveIntegerOption(
          values["max-output-tokens"],
          "--max-output-tokens",
          MAX_PROMPT_CANDIDATE_GENERATION_OUTPUT_TOKENS,
        ),
      },
    });
    const source = await generatePromptCandidate(
      {
        prepared,
        cwd: admitted.root,
        projectRoot: admitted.root,
        protectedPaths: [],
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      },
      dependencies.createNodeExecutor(config.sandbox.profile, admitted.root),
    );
    throwIfAborted(dependencies.signal, "candidate generation was cancelled");
    await admitted.revalidate();
    throwIfAborted(dependencies.signal, "candidate generation was cancelled");
    const sourceText = `${JSON.stringify(source, null, 2)}\n`;
    const projected = projectPromptCandidate({
      manifestProvenance: basename(admitted.outputPath),
      source,
      sourceSha256: sha256Text(sourceText),
      baseline: {
        provenance: admitted.baseline.provenance,
        source: admitted.baseline.source,
        sourceSha256: admitted.baseline.sourceSha256,
        compiled: admitted.baseline.compiled,
      },
      evidence: admitted.evidence.map((item) => ({
        provenance: item.provenance,
        sourceSha256: item.sourceSha256,
        packet: item.packet,
      })),
    });
    await admitted.revalidate();
    throwIfAborted(dependencies.signal, "candidate generation was cancelled");
    await publishLocalPromptCandidate(admitted.outputPath, sourceText, {
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      beforePublish: async () => {
        await admitted.revalidate();
        throwIfAborted(dependencies.signal, "candidate generation was cancelled");
      },
    });
    io.stdout(
      JSON.stringify(
        {
          generated: true,
          output: admitted.outputPath,
          candidate: {
            id: projected.identity.id,
            version: projected.identity.candidateVersion,
            provider: projected.identity.generation?.provider,
            model: projected.identity.generation?.model,
            requestDigest: projected.identity.generation?.requestDigest,
            responseDigest: projected.identity.generation?.responseDigest,
            candidateDigest: projected.identity.candidateDigest,
            changes: projected.identity.changes.map((change) => change.nodeId),
          },
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (subcommand === "validate") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    const candidatePath = requireSinglePositional(
      positionals,
      "candidate validate requires one candidate path",
    );
    const cwd = overrides.cwd ?? process.cwd();
    const admitted = await admitLocalPromptCandidate(resolve(cwd, candidatePath));
    io.stdout(JSON.stringify({ valid: true, candidate: admitted.identity }, null, 2));
    return 0;
  }
  if (subcommand === "activate") {
    const dryRun = extractBooleanFlag(args.slice(1), "--dry-run");
    const { positionals, values } = parseCommandArgs(dryRun.args, {
      actor: { type: "string" },
      evaluation: { type: "string" },
      "evaluations-dir": { type: "string" },
      "expected-digest": { type: "string" },
      reason: { type: "string" },
    });
    const candidatePath = requireSinglePositional(
      positionals,
      "candidate activate requires one candidate path",
    );
    const actor = requireStringOption(values.actor, "candidate activate requires --actor <label>");
    const evaluationId = requireStringOption(
      values.evaluation,
      "candidate activate requires --evaluation <id>",
    );
    requireMutationMode(dryRun.enabled, values["expected-digest"], "candidate activate");
    const dependencies = configDependenciesFrom(overrides);
    const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
    const store = promptActivationStore(config);
    const candidate = await admitLocalPromptCandidate(resolve(dependencies.cwd, candidatePath));
    const evaluationsDirectory = await resolveEvaluationsDirectory(
      dependencies,
      values["evaluations-dir"],
    );
    const evaluation = await new LocalEvaluationStore(evaluationsDirectory).read(evaluationId);
    const snapshots = createPromptActivationFromEvaluation(candidate, evaluation);
    const input = {
      snapshot: snapshots.candidate,
      baselineSnapshot: snapshots.baseline,
      actor,
      ...(values.reason === undefined ? {} : { reason: values.reason }),
    };
    if (dryRun.enabled) {
      io.stdout(
        JSON.stringify(
          {
            dryRun: true,
            activation: promptActivationView(snapshots.candidate),
            proposal: await store.previewActivate(input),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    io.stdout(
      JSON.stringify(
        await store.applyActivate({
          ...input,
          expectedDigest: requireStringOption(
            values["expected-digest"],
            "candidate activate requires --expected-digest <sha256>",
          ),
        }),
        null,
        2,
      ),
    );
    return 0;
  }
  throw new CliUsageError("candidate requires generate, validate, or activate");
}

async function activationCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const subcommand = args[0];
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const store = promptActivationStore(config);
  if (subcommand === "list") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    if (positionals.length !== 0) {
      throw new CliUsageError("activation list accepts no arguments");
    }
    io.stdout(JSON.stringify(await store.list(), null, 2));
    return 0;
  }
  if (subcommand === "inspect") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    const workflowId = requireSinglePositional(
      positionals,
      "activation inspect requires one workflow id",
    );
    const index = await store.list();
    const head = index.heads.find((item) => item.workflowId === workflowId);
    if (head === undefined) {
      throw new PromptActivationStoreError(
        "not_found",
        `workflow "${workflowId}" has no activation history`,
      );
    }
    const activations = index.activations.filter((item) => item.workflowId === workflowId);
    const active =
      head.activationDigest === null
        ? null
        : promptActivationView((await store.loadActive(workflowId)).snapshot);
    io.stdout(JSON.stringify({ workflowId, head, activations, active }, null, 2));
    return 0;
  }
  if (subcommand === "rollback") {
    const dryRun = extractBooleanFlag(args.slice(1), "--dry-run");
    const { positionals, values } = parseCommandArgs(dryRun.args, {
      actor: { type: "string" },
      "expected-digest": { type: "string" },
      reason: { type: "string" },
      to: { type: "string" },
    });
    const workflowId = requireSinglePositional(
      positionals,
      "activation rollback requires one workflow id",
    );
    const actor = requireStringOption(values.actor, "activation rollback requires --actor <label>");
    const target = parseRollbackSelection(
      requireStringOption(values.to, "activation rollback requires --to <target>"),
    );
    requireMutationMode(dryRun.enabled, values["expected-digest"], "activation rollback");
    const input = {
      workflowId,
      target,
      actor,
      ...(values.reason === undefined ? {} : { reason: values.reason }),
    };
    if (dryRun.enabled) {
      io.stdout(
        JSON.stringify({ dryRun: true, proposal: await store.previewRollback(input) }, null, 2),
      );
      return 0;
    }
    io.stdout(
      JSON.stringify(
        await store.applyRollback({
          ...input,
          expectedDigest: requireStringOption(
            values["expected-digest"],
            "activation rollback requires --expected-digest <sha256>",
          ),
        }),
        null,
        2,
      ),
    );
    return 0;
  }
  throw new CliUsageError("activation requires list, inspect, or rollback");
}

function promptActivationStore(config: EffectiveFlowConfig): LocalPromptActivationStore {
  if (config.projectRoot === null) {
    throw new PromptActivationStoreError(
      "not_found",
      "prompt activation requires a Flow project root",
    );
  }
  return new LocalPromptActivationStore(config.projectRoot);
}

function promptActivationView(snapshot: PromptActivationSnapshot) {
  return Object.freeze({
    version: snapshot.version,
    kind: snapshot.kind,
    selection: snapshot.selection,
    workflowId: snapshot.workflowId,
    candidateId: snapshot.candidateId,
    candidateVersion: snapshot.candidateVersion,
    candidate: snapshot.candidate,
    evaluation: snapshot.evaluation,
    source: { bytes: snapshot.source.bytes, sha256: snapshot.source.sha256 },
    activationDigest: snapshot.activationDigest,
  });
}

function requireMutationMode(
  dryRun: boolean,
  expectedDigest: string | undefined,
  command: string,
): void {
  if (dryRun === (expectedDigest !== undefined)) {
    throw new CliUsageError(
      `${command} requires exactly one of --dry-run or --expected-digest <sha256>`,
    );
  }
}

function parseRollbackSelection(value: string) {
  if (value === "baseline") {
    return null;
  }
  const match = /^([^@]+)@([^@]+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new CliUsageError(
      "activation rollback target must be baseline or <candidate-id>@<exact-version>",
    );
  }
  return Object.freeze({ candidateId: match[1], candidateVersion: match[2] });
}

function tuningEvidence(stored: StoredEvaluation) {
  const flowProfiles = stored.header.profiles.filter(
    (
      profile,
    ): profile is Extract<
      StoredEvaluation["header"]["profiles"][number],
      { readonly adapter: "flow-workflow-v1" }
    > => profile.adapter === "flow-workflow-v1",
  );
  if (flowProfiles.length !== stored.header.profiles.length) {
    throw new CliUsageError("tuning evidence does not support external harness profiles");
  }
  return createTuningEvidencePacket({
    evaluationId: stored.header.evaluationId,
    planDigest: stored.header.planDigest,
    suite: { id: stored.header.suite.id, version: stored.header.suite.version },
    tasks: stored.header.suite.tasks.map((task) => ({
      id: task.id,
      partition: task.partition,
    })),
    profiles: flowProfiles.map((profile) => ({
      id: profile.id,
      adapter: profile.adapter,
      workflowDigest: profile.workflow.workflowDigest,
      ...(profile.candidate === undefined
        ? {}
        : { candidateDigest: profile.candidate.identity.candidateDigest }),
    })),
    schedule: stored.header.schedule,
    records: stored.records,
  });
}

function evaluationEvidence(stored: StoredEvaluation) {
  return Object.freeze({
    header: stored.header,
    records: stored.records,
    report: aggregateEvaluation(evaluationReportInput(stored.header), stored.records),
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
  const protectedPaths = resolveRunProtectedPaths(runsDirectory, config);
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
        ...(config.projectRoot === null ? {} : { projectRoot: config.projectRoot }),
        protectedPaths,
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      },
      runsDirectory,
      config,
      io,
    );
  }
  const state = await resumeWorkflow(admitted.workflow, {
    cwd: executionCwd,
    ...(config.projectRoot === null ? {} : { projectRoot: config.projectRoot }),
    protectedPaths,
    runId,
    store,
    workspaceIsolator: dependencies.createWorkspaceIsolator(
      runsDirectory,
      protectedPaths,
      executionCwd,
      config.projectRoot ?? undefined,
    ),
    executor: dependencies.createNodeExecutor(
      config.sandbox.profile,
      config.projectRoot ?? dependencies.cwd,
    ),
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
  const protectedPaths = resolveRunProtectedPaths(runsDirectory, config);
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
        ...(config.projectRoot === null ? {} : { projectRoot: config.projectRoot }),
        protectedPaths,
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      },
      runsDirectory,
      config,
      io,
    );
  }
  const state = await runWorkflow(admitted.workflow, {
    cwd: executionCwd,
    ...(config.projectRoot === null ? {} : { projectRoot: config.projectRoot }),
    protectedPaths,
    store: dependencies.createStore(runsDirectory),
    workspaceIsolator: dependencies.createWorkspaceIsolator(
      runsDirectory,
      protectedPaths,
      executionCwd,
      config.projectRoot ?? undefined,
    ),
    executor: dependencies.createNodeExecutor(
      config.sandbox.profile,
      config.projectRoot ?? dependencies.cwd,
    ),
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
    "sandbox-profile": { type: "string" },
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
  const sandboxProfile = parseSandboxProfileOption(
    requireStringOption(
      values["sandbox-profile"],
      "internal supervisor requires --sandbox-profile",
    ),
  );
  if (calculateFlowPolicyDigest(supervisor, sandboxProfile) !== policyDigest) {
    throw new CliUsageError(
      "--policy-digest does not match the supplied supervisor limits and sandbox profile",
    );
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
    policy: { policyDigest, sandbox: { profile: sandboxProfile }, supervisor },
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
    createExecutor: dependencies.createNodeExecutor,
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

function parseSandboxProfileOption(value: string): FlowSandboxProfile {
  if (value === "native" || value === "container") {
    return value;
  }
  throw new CliUsageError("--sandbox-profile requires native or container");
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

function parseThinkingLevel(value: string | undefined): ThinkingLevel {
  const thinking = value ?? "medium";
  if (
    thinking !== "off" &&
    thinking !== "minimal" &&
    thinking !== "low" &&
    thinking !== "medium" &&
    thinking !== "high" &&
    thinking !== "xhigh"
  ) {
    throw new CliUsageError("--thinking requires off, minimal, low, medium, high, or xhigh");
  }
  return thinking;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  const activationLocator = parseActiveWorkflowLocator(argument);
  if (activationLocator !== null) {
    if (config.projectRoot === null) {
      throw new PromptActivationStoreError(
        "not_found",
        "activation locators require a Flow project root",
      );
    }
    const loaded = await new LocalPromptActivationStore(config.projectRoot).loadActive(
      activationLocator.workflowId,
    );
    const source = promptActivationSource(loaded.snapshot);
    const sourceName = `activation:${activationLocator.workflowId}`;
    const admitted = await admitWorkflowPackages({
      source: { kind: "inline", content: source, sourceName },
      loadPackage,
    });
    const capabilitySnapshot = combineOptionalCapabilitySnapshots([
      loaded.capabilitySnapshot,
      admitted.capabilitySnapshot,
    ]);
    return Object.freeze({
      source,
      sourceName,
      ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      workflow: compileWorkflowFromSnapshot({
        source,
        sourceName,
        ...(capabilitySnapshot === undefined ? {} : { capabilitySnapshot }),
      }),
    });
  }
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

function parseActiveWorkflowLocator(value: string) {
  try {
    return parsePromptActivationLocator(value);
  } catch {
    throw new CliUsageError('activation locators must use "activation:<workflow-id>"');
  }
}

async function admitResumeWorkflowArgument(
  argument: string,
  capabilitySnapshot: CapabilitySnapshot | undefined,
  dependencies: Pick<CliDependencies, "cwd" | "readTextFile">,
) {
  const activationLocator = parseActiveWorkflowLocator(argument);
  const locator = activationLocator === null ? parseWorkflowLocator(argument) : null;
  let source: string;
  let sourceName: string;
  if (activationLocator !== null) {
    const selected = capabilitySnapshot?.activations?.find(
      (item) => item.workflowId === activationLocator.workflowId,
    );
    if (selected === undefined) {
      throw new RunRecoveryError(
        "workflow_mismatch",
        `durable run history does not contain activation "${activationLocator.workflowId}"`,
      );
    }
    sourceName = `activation:${activationLocator.workflowId}`;
    source = promptActivationSource(selected);
  } else if (locator === null) {
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
  const externalHarnessRegistry =
    overrides.externalHarnessRegistry ??
    new BuiltInExternalHarnessRegistry({ cwd: storageDependencies.cwd });
  return {
    ...storageDependencies,
    ...configDependencies,
    executor: overrides.executor ?? createProductionNodeExecutor(),
    createNodeExecutor:
      overrides.createNodeExecutor ??
      ((profile, projectRoot) =>
        overrides.executor ?? createProductionNodeExecutor(profile, projectRoot)),
    effectReconciler: overrides.effectReconciler ?? createProductionNodeEffectReconciler(),
    createWorkspaceIsolator: overrides.createWorkspaceIsolator ?? createProductionWorkspaceIsolator,
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, "utf8")),
    capabilityBundleFetcher:
      overrides.capabilityBundleFetcher ?? createProductionCapabilityBundleFetcher(),
    externalHarnessRegistry,
    externalHarnessRuntime:
      overrides.externalHarnessRuntime ??
      createLazyProductionExternalHarnessRuntime(externalHarnessRegistry),
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

function boundedCliDiagnostic(message: string): string {
  return message.length <= 8_192 ? message : `${message.slice(0, 8_192)}…`;
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

function resolveRunProtectedPaths(runsDirectory: string, config: EffectiveFlowConfig): string[] {
  return [
    ...new Set([
      runsDirectory,
      ...(config.projectRoot === null ? [] : [join(config.projectRoot, ".flow")]),
    ]),
  ];
}

async function resolveEvaluationsDirectory(
  dependencies: Pick<CliDependencies, "cwd" | "loadConfig">,
  explicitEvaluationsDirectory: string | undefined,
): Promise<string> {
  return (await resolveEvaluationLocation(dependencies, explicitEvaluationsDirectory)).directory;
}

async function resolveEvaluationLocation(
  dependencies: Pick<CliDependencies, "cwd" | "loadConfig">,
  explicitEvaluationsDirectory: string | undefined,
): Promise<{
  readonly directory: string;
  readonly projectRoot: string | null;
  readonly sandboxProfile: FlowSandboxProfile;
}> {
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const projectRoot = config.projectRoot === null ? null : await realpath(config.projectRoot);
  return Object.freeze({
    directory:
      explicitEvaluationsDirectory === undefined
        ? resolve(projectRoot ?? dependencies.cwd, ".flow/evaluations")
        : resolve(dependencies.cwd, explicitEvaluationsDirectory),
    projectRoot,
    sandboxProfile: config.sandbox.profile,
  });
}

function createLazyProductionExternalHarnessRuntime(
  registry: ExternalHarnessRegistry,
): ExternalHarnessRuntime {
  let runtime: Promise<ExternalHarnessRuntime> | undefined;
  return Object.freeze({
    execute: async (
      request: Parameters<ExternalHarnessRuntime["execute"]>[0],
      signal?: AbortSignal,
    ) => {
      runtime ??= import("../infrastructure/runtime/production-external-harness-runtime.js").then(
        ({ createProductionExternalHarnessRuntime }) =>
          createProductionExternalHarnessRuntime(registry),
      );
      return (await runtime).execute(request, signal);
    },
    recoverAttempt: async (
      request: Parameters<NonNullable<ExternalHarnessRuntime["recoverAttempt"]>>[0],
      signal?: AbortSignal,
    ) => {
      runtime ??= import("../infrastructure/runtime/production-external-harness-runtime.js").then(
        ({ createProductionExternalHarnessRuntime }) =>
          createProductionExternalHarnessRuntime(registry),
      );
      const loaded = await runtime;
      if (loaded.recoverAttempt === undefined) {
        throw new Error("Prime OCI attempt recovery is not available");
      }
      return loaded.recoverAttempt(request, signal);
    },
  });
}

function formatCompilationError(error: WorkflowCompilationError): string {
  return [
    `Workflow compilation failed for ${error.sourceName}:`,
    ...error.diagnostics.map(
      (diagnostic) => `- ${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}`,
    ),
  ].join("\n");
}

function parseInstalledFlowVersion(input: unknown): string {
  const version =
    typeof input === "object" && input !== null && "version" in input
      ? (input as { readonly version?: unknown }).version
      : undefined;
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version,
    )
  ) {
    throw new Error("installed Flow package metadata has an invalid version");
  }
  return version;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error(message);
  }
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
