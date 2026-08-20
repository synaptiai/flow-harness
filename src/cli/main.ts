#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  activateCapabilityMetadataCandidate,
  CapabilityMetadataActivationError,
} from "../application/activate-capability-metadata-candidate.js";
import {
  activateCapabilityRepositoryCandidate,
  CapabilityRepositoryActivationError,
} from "../application/activate-capability-repository-candidate.js";
import { CapabilityMetadataCandidateError } from "../application/capability-metadata-candidate.js";
import { CapabilityMetadataCandidateStoreError } from "../application/capability-metadata-candidate-store.js";
import {
  type CapabilityMetadataChannel,
  CapabilityMetadataChannelError,
} from "../application/capability-metadata-channel.js";
import {
  CapabilityRepositoryFirstActivationError,
  MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS,
  runCapabilityRepositoryFirstActivation,
} from "../application/capability-repository-first-activation.js";
import {
  CapabilityRepositorySchedulerError,
  MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS,
  MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS,
} from "../application/capability-repository-scheduler.js";
import { CapabilityRepositoryStoreError } from "../application/capability-repository-store.js";
import {
  CapabilityRepositoryWatcherError,
  runCapabilityRepositoryWatcher,
} from "../application/capability-repository-watcher.js";
import {
  CapabilityMetadataCheckError,
  createCapabilityMetadataChannelChecker,
} from "../application/check-capability-metadata-channel.js";
import {
  CapabilityRepositoryCheckError,
  createCapabilityRepositoryChecker,
} from "../application/check-capability-repository.js";
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
  AgentSkillCandidateGenerationExecutionError,
  generateAgentSkillCandidate,
} from "../application/generate-agent-skill-candidate.js";
import {
  AgentSkillPackageCandidateGenerationExecutionError,
  generateAgentSkillPackageCandidate,
} from "../application/generate-agent-skill-package-candidate.js";
import {
  generatePromptCandidate,
  PromptCandidateGenerationExecutionError,
} from "../application/generate-prompt-candidate.js";
import {
  generateSupplementalMemoryCandidate,
  SupplementalMemoryCandidateGenerationExecutionError,
} from "../application/generate-supplemental-memory-candidate.js";
import { createCapabilityMetadataImporter } from "../application/import-capability-metadata.js";
import { createSignedOciCapabilityBundleInstaller } from "../application/install-signed-oci-capability-bundle.js";
import type {
  AgentCommandApprovalDecisionChannel,
  NodeEffectReconciler,
  NodeExecutor,
  RecoverableRunEventStore,
  WorkspaceIsolator,
} from "../application/ports.js";
import {
  AgentSkillActivationAdmissionError,
  createAgentSkillActivationFromEvaluation,
} from "../application/prepare-agent-skill-activation.js";
import {
  AgentSkillPackageActivationAdmissionError,
  createAgentSkillPackageActivationFromEvaluation,
} from "../application/prepare-agent-skill-package-activation.js";
import {
  EffectiveHarnessActivationAdmissionError,
  prepareEffectiveHarnessActivation,
} from "../application/prepare-effective-harness-activation.js";
import {
  type EffectiveHarnessCandidateProjection,
  loadEffectiveHarnessCandidateBaseline,
  projectEffectiveHarnessCandidate,
} from "../application/prepare-effective-harness-candidate.js";
import {
  createPromptActivationFromEvaluation,
  PromptActivationAdmissionError,
} from "../application/prepare-prompt-activation.js";
import { reopenCapabilityRepositoryCandidate } from "../application/reopen-capability-repository-candidate.js";
import {
  CapabilityRepositoryReplacementError,
  replaceCapabilityRepositoryCandidate,
} from "../application/replace-capability-repository-candidate.js";
import { runEvaluationTrials } from "../application/run-evaluation.js";
import {
  RunPresentationActionController,
  type RunPresentationControl,
} from "../application/run-presentation-actions.js";
import {
  type RunPresentationEventSource,
  type RunPresentationRenderer,
  runPresentationSession,
} from "../application/run-presentation-session.js";
import { RunRecoveryError, resumeWorkflow, runWorkflow } from "../application/run-workflow.js";
import { createSignedCapabilityMetadataVerifier } from "../application/verify-signed-capability-metadata.js";
import {
  admitWorkflowPackages,
  compileWorkflowFromSnapshot,
} from "../application/workflow-package-admission.js";
import {
  AgentSkillActivationError,
  agentSkillActivationWorkflow,
} from "../domain/adaptation/agent-skill-activation.js";
import {
  AgentSkillCandidateError,
  projectAgentSkillCandidate,
} from "../domain/adaptation/agent-skill-candidate.js";
import {
  AgentSkillCandidateGenerationError,
  MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  prepareAgentSkillCandidateGeneration,
} from "../domain/adaptation/agent-skill-candidate-generation.js";
import {
  AgentSkillPackageActivationError,
  agentSkillPackageActivationWorkflow,
} from "../domain/adaptation/agent-skill-package-activation.js";
import {
  createAgentSkillPackageCandidateSource,
  projectAgentSkillPackageCandidate,
} from "../domain/adaptation/agent-skill-package-candidate.js";
import {
  AgentSkillPackageCandidateGenerationError,
  MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  prepareAgentSkillPackageCandidateGeneration,
} from "../domain/adaptation/agent-skill-package-candidate-generation.js";
import {
  createEffectiveHarnessCandidateArtifact,
  type EffectiveHarnessCandidateArtifact,
} from "../domain/adaptation/effective-harness-candidate.js";
import { restoreEffectiveHarnessRuntimeState } from "../domain/adaptation/effective-harness-runtime.js";
import {
  compileEffectiveHarnessState,
  type EffectiveHarnessHeadIdentity,
  type EffectiveHarnessState,
  effectiveHarnessWorkflowSource,
} from "../domain/adaptation/effective-harness-state.js";
import {
  PromptActivationError,
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
  projectSupplementalMemoryCandidate,
  SupplementalMemoryCandidateError,
  type SupplementalMemoryCandidateIdentity,
} from "../domain/adaptation/supplemental-memory-candidate.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
  prepareSupplementalMemoryCandidateGeneration,
  SupplementalMemoryCandidateGenerationError,
} from "../domain/adaptation/supplemental-memory-candidate-generation.js";
import {
  type AdaptiveActivationSnapshot,
  type AgentSkillCapabilitySnapshot,
  type AgentSkillPackageSnapshot,
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  combineCapabilitySnapshots,
  createEffectiveHarnessCapabilitySnapshot,
  type PolicyPackageCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../domain/capability/agent-skills.js";
import { assertCapabilityBundleSha256 } from "../domain/capability/capability-bundles.js";
import {
  CapabilityMetadataError,
  MAX_CAPABILITY_METADATA_BYTES,
} from "../domain/capability/capability-metadata.js";
import { MAX_SIGSTORE_BUNDLE_BYTES } from "../domain/capability/oci-capability-artifacts.js";
import { parsePresentationPackageReference } from "../domain/capability/presentation-packages.js";
import { SignedCapabilityMetadataEnvelopeError } from "../domain/capability/signed-capability-metadata-envelope.js";
import {
  OfflineSigstoreCapabilityVerifier,
  SigstoreCapabilityVerificationError,
  type SigstoreCapabilityVerifier,
  validateSigstoreCapabilityPublisherPolicy,
} from "../domain/capability/sigstore-capability-verifier.js";
import {
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../domain/capability/verifier-packages.js";
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
import {
  assertWorkflowSatisfiesPolicyPackages,
  PolicyPackageAdmissionError,
} from "../domain/policy/policy-package-admission.js";
import { applyPresentationPackage } from "../domain/presentation/presentation-package-projector.js";
import { projectRunPresentation } from "../domain/presentation/run-presentation-projector.js";
import { type RunEvent, type RunStatus, reduceRunEvents } from "../domain/run/events.js";
import {
  WorkflowCompilationError,
  type WorkflowPackageReference,
} from "../domain/workflow/compiler.js";
import type { CompiledWorkflow, ThinkingLevel } from "../domain/workflow/types.js";
import {
  createFlowAcpAgent,
  type FlowAcpAgentRuntime,
} from "../infrastructure/acp/flow-acp-agent.js";
import { createFlowAcpProtocolStream } from "../infrastructure/acp/flow-acp-protocol-stream.js";
import { createStrictAcpStream } from "../infrastructure/acp/strict-acp-stream.js";
import {
  CapabilityBundlePackError,
  packCapabilityBundleDirectory,
} from "../infrastructure/fs/capability-bundle-packer.js";
import {
  EvaluationExportError,
  writeCanonicalEvaluationExport,
} from "../infrastructure/fs/evaluation-report-exporter.js";
import {
  FlowConfigStoreError,
  type InitializedFlowProject,
  type InitializeFlowProjectOptions,
  initializeFlowProject,
  type LoadEffectiveFlowConfigOptions,
  loadEffectiveFlowConfig,
  locateFlowProjectRoot,
} from "../infrastructure/fs/flow-config-store.js";
import { AdmissionStoreError } from "../infrastructure/fs/jsonl-admission-store.js";
import { JsonlRunStore, RunStoreError } from "../infrastructure/fs/jsonl-run-store.js";
import { LocalAcpSessionStore } from "../infrastructure/fs/local-acp-session-store.js";
import { admitLocalAdaptationCandidate } from "../infrastructure/fs/local-adaptation-candidate.js";
import {
  LocalAgentCommandApprovalChannel,
  LocalAgentCommandApprovalChannelError,
} from "../infrastructure/fs/local-agent-command-approval-channel.js";
import { LocalAgentSkillCandidateError } from "../infrastructure/fs/local-agent-skill-candidate.js";
import {
  admitLocalAgentSkillCandidateGenerationSources,
  LocalAgentSkillCandidateGenerationSourceError,
} from "../infrastructure/fs/local-agent-skill-candidate-generation.js";
import {
  AgentSkillCatalogError,
  type ProjectAgentSkillCatalog,
  snapshotSelectedAgentSkills,
} from "../infrastructure/fs/local-agent-skill-catalog.js";
import {
  admitLocalAgentSkillPackageCandidateGenerationSources,
  LocalAgentSkillPackageCandidateGenerationSourceError,
} from "../infrastructure/fs/local-agent-skill-package-candidate-generation.js";
import {
  assertLocalAgentSkillPackageCandidateOutputAvailable,
  LocalAgentSkillPackageCandidatePublisherError,
  publishLocalAgentSkillPackageCandidate,
} from "../infrastructure/fs/local-agent-skill-package-candidate-publisher.js";
import { LocalCapabilityMetadataCandidateStore } from "../infrastructure/fs/local-capability-metadata-candidate-store.js";
import {
  CapabilityPackageStoreError,
  LocalCapabilityPackageStore,
} from "../infrastructure/fs/local-capability-package-store.js";
import {
  LocalCapabilityRepositoryFirstActivationStore,
  LocalCapabilityRepositoryFirstActivationStoreError,
} from "../infrastructure/fs/local-capability-repository-first-activation-store.js";
import { LocalCapabilityRepositoryStore } from "../infrastructure/fs/local-capability-repository-store.js";
import {
  LocalCapabilityRepositoryWatcherLock,
  LocalCapabilityRepositoryWatcherLockError,
} from "../infrastructure/fs/local-capability-repository-watcher-lock.js";
import {
  calculateLocalEffectiveHarnessScopeDigest,
  EffectiveHarnessStoreError,
  LocalEffectiveHarnessStore,
} from "../infrastructure/fs/local-effective-harness-store.js";
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
  PolicyPackageCatalogError,
  type ProjectPolicyPackageCatalog,
  snapshotSelectedPolicyPackages,
} from "../infrastructure/fs/local-policy-package-catalog.js";
import {
  PresentationPackageCatalogError,
  type ProjectPresentationPackageCatalog,
  snapshotSelectedPresentationPackage,
} from "../infrastructure/fs/local-presentation-package-catalog.js";
import {
  LocalPromptActivationStore,
  PromptActivationStoreError,
} from "../infrastructure/fs/local-prompt-activation-store.js";
import {
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
  admitLocalSupplementalMemoryCandidateGenerationSources,
  LocalSupplementalMemoryCandidateError,
} from "../infrastructure/fs/local-supplemental-memory-candidate.js";
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
import {
  type BrowserPresentationHost,
  LocalBrowserPresentationHost,
  type LocalBrowserPresentationHostOptions,
} from "../infrastructure/http/local-browser-presentation-host.js";
import {
  createProductionCapabilityBundleFetcher,
  createProductionCapabilityMetadataChannel,
  createProductionCapabilityRepositoryFetcher,
  createProductionOciCapabilityRegistry,
} from "../infrastructure/http/node-https-capability-bundle-transport.js";
import {
  CapabilityBundleFetchError,
  type CapabilityBundleFetcher,
} from "../infrastructure/http/strict-capability-bundle-fetcher.js";
import type { StrictCapabilityRepositoryFetcher } from "../infrastructure/http/strict-capability-repository-fetcher.js";
import {
  isValidOciRegistryUsername,
  OciCapabilityRegistryError,
  type OciRegistryCredentialProvider,
  type StrictOciCapabilityRegistry,
} from "../infrastructure/http/strict-oci-capability-registry.js";
import type { PrimeOciPreparationResult } from "../infrastructure/oci/prime-oci-preparation.js";
import {
  BuiltInExternalHarnessRegistry,
  type ExternalHarnessRegistry,
} from "../infrastructure/process/built-in-external-harness-registry.js";
import { createProductionNodeEffectReconciler } from "../infrastructure/runtime/production-effect-reconciler.js";
import { createProductionNodeExecutor } from "../infrastructure/runtime/production-node-executor.js";
import { createProductionWorkspaceIsolator } from "../infrastructure/runtime/production-workspace-isolator.js";
import { createSigstorePublicGoodTrustedRoot } from "../infrastructure/sigstore-public-good-trusted-root.js";
import {
  createProcessFlowTerminalRenderer,
  FlowTerminalRendererError,
  type InteractiveRunPresentationRenderer,
  isProcessTerminalInteractive,
} from "../infrastructure/terminal/flow-terminal-renderer.js";
import { createCapabilityRepositoryGenerationAuthenticator } from "../infrastructure/tuf/capability-repository-generation-authenticator.js";
import {
  CapabilityRepositoryInitializationError,
  createLocalCapabilityRepositoryInitializer,
} from "../infrastructure/tuf/local-capability-repository-initializer.js";
import { createLocalCapabilityRepositoryRefresher } from "../infrastructure/tuf/local-capability-repository-refresher.js";
import { MAX_CAPABILITY_REPOSITORY_TRUSTED_ROOT_BYTES } from "../infrastructure/tuf/staged-tuf-repository.js";
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
import { readBoundedSecretInput } from "./bounded-secret-input.js";
import { projectPublicRunOutput } from "./public-output.js";

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
  flow policies list
  flow policies inspect <name> --version <exact>
  flow policies validate
  flow presentations list
  flow presentations inspect <name> --version <exact>
  flow presentations validate [<manifest-path>]
  flow packages install <https-url> --sha256 <64-lowercase-hex>
  flow packages install-oci <registry/repository@sha256:digest> --certificate-issuer <https-url> --certificate-identity <exact> [--username <exact> --password-stdin]
  flow packages pack <source-directory> --output <bundle.flowpkg>
  flow packages metadata refresh <metadata.json> --sigstore-bundle <bundle.json> --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages metadata inspect
  flow packages metadata check <https-channel-url> --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages metadata candidates list
  flow packages metadata candidate inspect <sha256:digest>
  flow packages metadata candidate remove <sha256:digest>
  flow packages metadata activate <sha256:digest> --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages repository init <canonical-public-https-base> --trusted-root <local-root.json>
  flow packages repository status
  flow packages repository check
  flow packages repository first-activate <bundle-name> --version <exact> --max-checks <1..1000> [--interval-ms <60000..86400000>] --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages repository watch <installed-bundle-name> [--interval-ms <60000..86400000>] [--update-policy <patch|minor>] --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages repository candidates list
  flow packages repository candidate inspect <sha256:digest>
  flow packages repository candidate remove <sha256:digest>
  flow packages repository candidate activate <sha256:digest> --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages repository candidate replace <sha256:digest> --from-version <exact> --certificate-issuer <https-url> --certificate-identity <exact>
  flow packages list
  flow packages inspect <name> --version <exact>
  flow packages verify
  flow packages prune [--apply --expected-plan-digest <sha256>]
  flow packages remove <name> --version <exact>
  flow candidate generate <baseline> <evidence>... --output <candidate.yaml> --id <id> --version <semver> --allow-nodes <id,...> --provider <provider> --model <model> [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
  flow candidate generate <baseline> <evidence>... --output <candidate.yaml> --id <id> --version <semver> --skill <name> --allow-resources <path,...> --provider <provider> --model <model> [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
  flow candidate generate <baseline> <evidence>... --output <candidate-directory> --id <id> --version <semver> --blueprint <blueprint.json> --provider <provider> --model <model> [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
  flow candidate generate <workflow-id> <evidence>... --output <candidate.json> --id <id> --version <semver> --memory-agent <id> --memory-entry <id> --memory-operation <add|replace> [--memory-child-path <id,...>] --provider <provider> --model <model> [--thinking <level>] [--timeout-ms <count>] [--max-output-tokens <count>]
  flow candidate compose <candidate.yaml>
  flow candidate validate <candidate.yaml>
  flow candidate activate <candidate.yaml> --evaluation <id> --actor <label> [--reason <text>] [--evaluations-dir <path>] <--dry-run|--expected-digest <sha256>>
  flow activation list
  flow activation inspect <workflow-id>
  flow activation rollback <workflow-id> --to state:<sha256>|<candidate-id>@<version>|agent-skill:<candidate-id>@<version>|baseline --actor <label> [--reason <text>] <--dry-run|--expected-digest <sha256>>
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
  flow tui <run-id> --actor <label> [--presentation <name>@<exact-version>] [--runs-dir <path>]
  flow web <run-id> --actor <label> [--presentation <name>@<exact-version>] [--runs-dir <path>]
  flow acp --actor <label> [--runs-dir <path>]
  flow inspect <run-id> [--runs-dir <path>]
  flow supervisor status [--runs-dir <path>]
  flow supervisor shutdown [--runs-dir <path>]
  flow --help
`;

const MAX_ACP_RUN_START_WAIT_MS = 30_000;

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
  readonly loadConfig: (options?: LoadEffectiveFlowConfigOptions) => Promise<EffectiveFlowConfig>;
  readonly capabilityBundleFetcher: CapabilityBundleFetcher;
  readonly capabilityMetadataChannel: CapabilityMetadataChannel;
  readonly capabilityRepositoryFetcher: StrictCapabilityRepositoryFetcher;
  readonly capabilityRepositoryWatcherNow: () => Date;
  readonly capabilityRepositoryWatcherWait: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly ociCapabilityRegistry: StrictOciCapabilityRegistry;
  readonly sigstoreCapabilityVerifier: SigstoreCapabilityVerifier;
  readonly readRegistrySecret: (signal: AbortSignal) => Promise<Buffer>;
  readonly externalHarnessRegistry: ExternalHarnessRegistry;
  readonly externalHarnessRuntime: ExternalHarnessRuntime;
  readonly preparePrimeRuntime?: (input: {
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
  }) => Promise<PrimeOciPreparationResult>;
  readonly runSupervisorDaemon: typeof runSupervisorDaemon;
  readonly isInteractiveTerminal: () => boolean;
  readonly createTerminalPresentationRenderer: (options: {
    readonly onAction: (actionId: string) => Promise<void>;
    readonly onExit: () => void;
  }) => InteractiveRunPresentationRenderer;
  readonly createBrowserPresentationHost: (
    options: LocalBrowserPresentationHostOptions,
  ) => BrowserPresentationHost;
  readonly createAcpByteTransport: () => {
    readonly input: ReadableStream<Uint8Array>;
    readonly output: WritableStream<Uint8Array>;
    readonly dispose?: () => void;
  };
  readonly signal?: AbortSignal;
}

const processIo: CliIo = {
  stdout: (text) => writeProcessOutput(process.stdout, `${text}\n`),
  stderr: (text) => writeProcessOutput(process.stderr, `${text}\n`),
};
const readProcessRegistrySecret = async (signal: AbortSignal): Promise<Buffer> =>
  await readBoundedSecretInput(process.stdin, signal);
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
      case "policies":
        return await policiesCommand(args.slice(1), io, dependencyOverrides);
      case "presentations":
        return await presentationsCommand(args.slice(1), io, dependencyOverrides);
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
      case "tui":
        return await tuiCommand(args.slice(1), dependencyOverrides);
      case "web":
        return await webCommand(args.slice(1), io, dependencyOverrides);
      case "acp":
        return await acpCommand(args.slice(1), dependencyOverrides);
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
      error instanceof CapabilityMetadataActivationError ||
      error instanceof CapabilityMetadataCandidateError ||
      error instanceof CapabilityMetadataCandidateStoreError ||
      error instanceof CapabilityMetadataChannelError ||
      error instanceof CapabilityMetadataCheckError ||
      error instanceof CapabilityMetadataError ||
      error instanceof CapabilityPackageStoreError ||
      error instanceof CapabilityRepositoryFirstActivationError ||
      error instanceof CapabilityRepositoryActivationError ||
      error instanceof CapabilityRepositoryReplacementError ||
      error instanceof CapabilityRepositoryWatcherError ||
      error instanceof CapabilityRepositorySchedulerError ||
      error instanceof CapabilityRepositoryCheckError ||
      error instanceof CapabilityRepositoryInitializationError ||
      error instanceof CapabilityRepositoryStoreError ||
      error instanceof LocalCapabilityRepositoryFirstActivationStoreError ||
      error instanceof LocalCapabilityRepositoryWatcherLockError ||
      error instanceof OciCapabilityRegistryError ||
      error instanceof SigstoreCapabilityVerificationError ||
      error instanceof SignedCapabilityMetadataEnvelopeError ||
      error instanceof CapabilityBundlePackError
    ) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (
      error instanceof VerifierPackageCatalogError ||
      error instanceof ToolPackageCatalogError ||
      error instanceof WorkflowPackageCatalogError ||
      error instanceof PolicyPackageAdmissionError ||
      error instanceof WorkflowCapabilityError
    ) {
      io.stderr(`${error.code}: ${error.message}`);
      return 1;
    }
    if (error instanceof PolicyPackageCatalogError) {
      io.stderr(`${error.code}: ${publicPolicyPackageCatalogMessage(error.code)}`);
      return 1;
    }
    if (error instanceof PresentationPackageCatalogError) {
      io.stderr(`${error.code}: ${publicPresentationPackageCatalogMessage(error.code)}`);
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
    if (error instanceof FlowTerminalRendererError) {
      io.stderr(error.message);
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
      error instanceof SupplementalMemoryCandidateError ||
      error instanceof SupplementalMemoryCandidateGenerationError ||
      error instanceof SupplementalMemoryCandidateGenerationExecutionError ||
      error instanceof AgentSkillCandidateError ||
      error instanceof AgentSkillCandidateGenerationError ||
      error instanceof AgentSkillCandidateGenerationExecutionError ||
      error instanceof AgentSkillPackageCandidateGenerationError ||
      error instanceof AgentSkillPackageCandidateGenerationExecutionError ||
      error instanceof LocalAgentSkillCandidateError ||
      error instanceof LocalAgentSkillCandidateGenerationSourceError ||
      error instanceof LocalAgentSkillPackageCandidateGenerationSourceError ||
      error instanceof LocalPromptCandidateError ||
      error instanceof LocalSupplementalMemoryCandidateError
    ) {
      io.stderr(boundedCliDiagnostic(error.message));
      return 1;
    }
    if (error instanceof LocalPromptCandidatePublisherError) {
      io.stderr(`${error.code}: ${publicCandidatePublisherMessage(error.code)}`);
      return 1;
    }
    if (error instanceof LocalAgentSkillPackageCandidatePublisherError) {
      io.stderr(`${error.code}: ${publicCandidatePublisherMessage(error.code)}`);
      return 1;
    }
    if (
      error instanceof AgentSkillActivationError ||
      error instanceof AgentSkillActivationAdmissionError ||
      error instanceof AgentSkillPackageActivationError ||
      error instanceof AgentSkillPackageActivationAdmissionError ||
      error instanceof EffectiveHarnessActivationAdmissionError ||
      error instanceof PromptActivationError ||
      error instanceof PromptActivationAdmissionError ||
      error instanceof PromptActivationStoreError ||
      error instanceof EffectiveHarnessStoreError
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
  if (values["trusted-root"] !== undefined && subcommand !== "repository") {
    throw new CliUsageError("--trusted-root is accepted only by packages repository init");
  }
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

async function policiesCommand(
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
      "policies requires list, validate, or inspect <name> --version <exact>",
    );
  }
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const catalog = await discoverConfiguredPolicyPackages(config, dependencies.signal);

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
      throw new CliUsageError("policies inspect requires <name> --version <exact>");
    }
    const snapshot = await snapshotSelectedPolicyPackages(
      catalog,
      [{ name, version }],
      dependencies.signal === undefined ? {} : { signal: dependencies.signal },
    );
    const selected = snapshot.packages.find((item) => item.kind === "policy-package");
    if (selected === undefined) {
      throw new PolicyPackageCatalogError(
        "missing_package",
        `policy package "${name}" version "${version}" was not captured`,
      );
    }
    const { contentBase64: _contentBase64, ...manifest } = selected.manifest;
    io.stdout(JSON.stringify({ ...selected, manifest }, null, 2));
    return 0;
  }

  for (const item of catalog.packages) {
    await snapshotSelectedPolicyPackages(
      catalog,
      [{ name: item.name, version: item.version }],
      dependencies.signal === undefined ? {} : { signal: dependencies.signal },
    );
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

async function presentationsCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  assertStringOptionAtMostOnce(args, "version");
  const { positionals, values } = parseCommandArgs(args, {
    version: { type: "string" },
  });
  const subcommand = positionals[0];
  if (
    (subcommand !== "list" && subcommand !== "validate" && subcommand !== "inspect") ||
    (subcommand === "inspect"
      ? positionals.length !== 2
      : subcommand === "validate"
        ? positionals.length < 1 || positionals.length > 2
        : positionals.length !== 1) ||
    (subcommand === "inspect" ? values.version === undefined : values.version !== undefined)
  ) {
    throw new CliUsageError(
      "presentations requires list, validate [<manifest-path>], or inspect <name> --version <exact>",
    );
  }
  const dependencies = configDependenciesFrom(overrides);
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  const catalog = await discoverConfiguredPresentationPackages(config, dependencies.signal);
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
      throw new CliUsageError("presentations inspect requires <name> --version <exact>");
    }
    const selected = await snapshotSelectedPresentationPackage(
      catalog,
      { name, version },
      dependencies.signal === undefined ? {} : { signal: dependencies.signal },
    );
    const { contentBase64: _contentBase64, ...manifest } = selected.manifest;
    io.stdout(JSON.stringify({ ...selected, manifest }, null, 2));
    return 0;
  }
  const manifestPath = positionals[1];
  if (manifestPath !== undefined) {
    const selectedPath = resolve(
      catalog.projectRoot,
      relative(
        resolve(config.projectRoot ?? catalog.projectRoot),
        resolve(dependencies.cwd, manifestPath),
      ),
    );
    const item = catalog.packages.find(
      (candidate) => join(candidate.directory, "PRESENTATION.yaml") === selectedPath,
    );
    if (item === undefined) {
      throw new PresentationPackageCatalogError(
        "missing_package",
        "presentation package manifest is not in the project catalog",
      );
    }
    await snapshotSelectedPresentationPackage(
      catalog,
      { name: item.name, version: item.version },
      dependencies.signal === undefined ? {} : { signal: dependencies.signal },
    );
    io.stdout(JSON.stringify({ valid: true, package: `${item.name}@${item.version}` }, null, 2));
    return 0;
  }
  for (const item of catalog.packages) {
    await snapshotSelectedPresentationPackage(
      catalog,
      { name: item.name, version: item.version },
      dependencies.signal === undefined ? {} : { signal: dependencies.signal },
    );
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
  for (const option of [
    "username",
    "certificate-issuer",
    "certificate-identity",
    "expected-plan-digest",
    "from-version",
    "interval-ms",
    "max-checks",
    "update-policy",
    "version",
  ] as const) {
    const occurrences = args.filter(
      (argument) => argument === `--${option}` || argument.startsWith(`--${option}=`),
    ).length;
    if (occurrences > 1) {
      throw new CliUsageError(`--${option} may be specified only once`);
    }
  }
  const applyPrune = extractBooleanFlag(args, "--apply");
  const passwordInput = extractBooleanFlag(applyPrune.args, "--password-stdin");
  const { positionals, values } = parseCommandArgs(passwordInput.args, {
    "certificate-identity": { type: "string" },
    "certificate-issuer": { type: "string" },
    "expected-plan-digest": { type: "string" },
    "from-version": { type: "string" },
    "interval-ms": { type: "string" },
    "max-checks": { type: "string" },
    output: { type: "string" },
    sha256: { type: "string" },
    "sigstore-bundle": { type: "string" },
    "trusted-root": { type: "string" },
    "update-policy": { type: "string" },
    username: { type: "string" },
    version: { type: "string" },
  });
  const subcommand = positionals[0];
  if (
    values["from-version"] !== undefined &&
    !verifierPackageVersionSchema.safeParse(values["from-version"]).success
  ) {
    throw new CliUsageError("--from-version requires an exact semantic version");
  }
  if (values.username !== undefined && !isValidOciRegistryUsername(values.username)) {
    throw new CliUsageError(
      "--username requires 1 to 256 visible non-space ASCII characters without a colon",
    );
  }
  const hasCredentialPair =
    (values.username === undefined && !passwordInput.enabled) ||
    (values.username !== undefined && passwordInput.enabled);
  const hasNoCredentials = values.username === undefined && !passwordInput.enabled;
  const hasNoSigstoreBundle = values["sigstore-bundle"] === undefined;
  const hasNoAutomatedRepositoryOptions =
    values["interval-ms"] === undefined &&
    values["max-checks"] === undefined &&
    values["update-policy"] === undefined;
  const hasNoPruneOptions = !applyPrune.enabled && values["expected-plan-digest"] === undefined;
  const pruneValid =
    subcommand === "prune" &&
    positionals.length === 1 &&
    values["certificate-identity"] === undefined &&
    values["certificate-issuer"] === undefined &&
    values["from-version"] === undefined &&
    values["interval-ms"] === undefined &&
    values["max-checks"] === undefined &&
    values.output === undefined &&
    values.sha256 === undefined &&
    values["sigstore-bundle"] === undefined &&
    values["trusted-root"] === undefined &&
    values["update-policy"] === undefined &&
    values.username === undefined &&
    values.version === undefined &&
    !passwordInput.enabled &&
    applyPrune.enabled === (values["expected-plan-digest"] !== undefined) &&
    (values["expected-plan-digest"] === undefined ||
      /^sha256:[a-f0-9]{64}$/.test(values["expected-plan-digest"]));
  const standardValid =
    (subcommand === "install" &&
      positionals.length === 2 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 !== undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "install-oci" &&
      positionals.length === 2 &&
      values["certificate-identity"] !== undefined &&
      values["certificate-issuer"] !== undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasCredentialPair &&
      values.version === undefined) ||
    (subcommand === "pack" &&
      positionals.length === 2 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output !== undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    ((subcommand === "list" || subcommand === "verify") &&
      positionals.length === 1 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    ((subcommand === "inspect" || subcommand === "remove") &&
      positionals.length === 2 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version !== undefined) ||
    (subcommand === "metadata" &&
      positionals[1] === "refresh" &&
      positionals.length === 3 &&
      values["certificate-identity"] !== undefined &&
      values["certificate-issuer"] !== undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      !hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "repository" &&
      positionals[1] === "init" &&
      positionals.length === 3 &&
      values["trusted-root"] !== undefined &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "repository" &&
      positionals[1] === "status" &&
      positionals.length === 2 &&
      values["trusted-root"] === undefined &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "repository" &&
      positionals[1] === "check" &&
      positionals.length === 2 &&
      values["trusted-root"] === undefined &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "repository" &&
      positionals[1] === "candidates" &&
      positionals[2] === "list" &&
      positionals.length === 3 &&
      values["trusted-root"] === undefined &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "repository" &&
      positionals[1] === "candidate" &&
      (positionals[2] === "inspect" || positionals[2] === "remove") &&
      positionals.length === 4 &&
      values["trusted-root"] === undefined &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "repository" &&
      positionals[1] === "candidate" &&
      positionals[2] === "activate" &&
      positionals.length === 4 &&
      values["trusted-root"] === undefined &&
      values["certificate-identity"] !== undefined &&
      values["certificate-issuer"] !== undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "metadata" &&
      positionals[1] === "inspect" &&
      positionals.length === 2 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "metadata" &&
      positionals[1] === "check" &&
      positionals.length === 3 &&
      values["certificate-identity"] !== undefined &&
      values["certificate-issuer"] !== undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "metadata" &&
      positionals[1] === "candidates" &&
      positionals[2] === "list" &&
      positionals.length === 3 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "metadata" &&
      positionals[1] === "candidate" &&
      (positionals[2] === "inspect" || positionals[2] === "remove") &&
      positionals.length === 4 &&
      values["certificate-identity"] === undefined &&
      values["certificate-issuer"] === undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined) ||
    (subcommand === "metadata" &&
      positionals[1] === "activate" &&
      positionals.length === 3 &&
      values["certificate-identity"] !== undefined &&
      values["certificate-issuer"] !== undefined &&
      values.output === undefined &&
      values.sha256 === undefined &&
      hasNoSigstoreBundle &&
      hasNoCredentials &&
      values.version === undefined);
  const replacementValid =
    subcommand === "repository" &&
    positionals[1] === "candidate" &&
    positionals[2] === "replace" &&
    positionals.length === 4 &&
    values["trusted-root"] === undefined &&
    values["certificate-identity"] !== undefined &&
    values["certificate-issuer"] !== undefined &&
    values["from-version"] !== undefined &&
    values.output === undefined &&
    values.sha256 === undefined &&
    hasNoSigstoreBundle &&
    hasNoCredentials &&
    values.version === undefined;
  const watcherValid =
    subcommand === "repository" &&
    positionals[1] === "watch" &&
    positionals.length === 3 &&
    values["trusted-root"] === undefined &&
    values["certificate-identity"] !== undefined &&
    values["certificate-issuer"] !== undefined &&
    values["from-version"] === undefined &&
    values.output === undefined &&
    values.sha256 === undefined &&
    hasNoSigstoreBundle &&
    hasNoCredentials &&
    values["max-checks"] === undefined &&
    values.version === undefined;
  const firstActivationValid =
    subcommand === "repository" &&
    positionals[1] === "first-activate" &&
    positionals.length === 3 &&
    values["trusted-root"] === undefined &&
    values["certificate-identity"] !== undefined &&
    values["certificate-issuer"] !== undefined &&
    values["from-version"] === undefined &&
    values["max-checks"] !== undefined &&
    values["update-policy"] === undefined &&
    values.output === undefined &&
    values.sha256 === undefined &&
    hasNoSigstoreBundle &&
    hasNoCredentials &&
    values.version !== undefined;
  const valid =
    pruneValid ||
    (hasNoPruneOptions &&
      ((hasNoAutomatedRepositoryOptions &&
        ((values["from-version"] === undefined && standardValid) || replacementValid)) ||
        watcherValid ||
        firstActivationValid));
  if (!valid) {
    throw new CliUsageError(
      "packages requires pack, install, install-oci, metadata refresh, metadata inspect, metadata check, metadata candidates list, metadata candidate inspect/remove, metadata activate, repository init/status/check/first-activate/watch/candidates/candidate inspect/remove/activate/replace, list, inspect, verify, prune, or remove with the documented exact arguments",
    );
  }
  const watcherPackageName = watcherValid ? positionals[2] : undefined;
  const watcherCertificateIssuer = watcherValid ? values["certificate-issuer"] : undefined;
  const watcherCertificateIdentity = watcherValid ? values["certificate-identity"] : undefined;
  const watcherUpdatePolicy = watcherValid ? (values["update-policy"] ?? "patch") : undefined;
  const watcherIntervalMs = watcherValid
    ? parseRepositoryWatcherInterval(values["interval-ms"])
    : undefined;
  const firstActivationPackageName = firstActivationValid ? positionals[2] : undefined;
  const firstActivationVersion = firstActivationValid ? values.version : undefined;
  const firstActivationCertificateIssuer = firstActivationValid
    ? values["certificate-issuer"]
    : undefined;
  const firstActivationCertificateIdentity = firstActivationValid
    ? values["certificate-identity"]
    : undefined;
  const firstActivationIntervalMs = firstActivationValid
    ? parseRepositoryWatcherInterval(values["interval-ms"])
    : undefined;
  const firstActivationMaxChecks = firstActivationValid
    ? parseRepositoryFirstActivationMaxChecks(values["max-checks"])
    : undefined;
  if (watcherValid) {
    if (
      watcherPackageName === undefined ||
      watcherCertificateIssuer === undefined ||
      watcherCertificateIdentity === undefined ||
      !verifierPackageNameSchema.safeParse(watcherPackageName).success ||
      (watcherUpdatePolicy !== "patch" && watcherUpdatePolicy !== "minor")
    ) {
      throw new CliUsageError(
        "packages repository watch requires one installed bundle, exact publisher authority, a bounded interval, and patch or minor policy",
      );
    }
    try {
      validateSigstoreCapabilityPublisherPolicy({
        certificateIssuer: watcherCertificateIssuer,
        certificateIdentity: watcherCertificateIdentity,
      });
    } catch {
      throw new CliUsageError(
        "packages repository watch requires one installed bundle, exact publisher authority, a bounded interval, and patch or minor policy",
      );
    }
  }
  if (firstActivationValid) {
    if (
      firstActivationPackageName === undefined ||
      firstActivationVersion === undefined ||
      firstActivationCertificateIssuer === undefined ||
      firstActivationCertificateIdentity === undefined ||
      firstActivationIntervalMs === undefined ||
      firstActivationMaxChecks === undefined ||
      !verifierPackageNameSchema.safeParse(firstActivationPackageName).success ||
      !verifierPackageVersionSchema.safeParse(firstActivationVersion).success
    ) {
      throw new CliUsageError(
        "packages repository first-activate requires one exact bundle, exact publisher authority, a bounded interval, and finite checks",
      );
    }
    try {
      validateSigstoreCapabilityPublisherPolicy({
        certificateIssuer: firstActivationCertificateIssuer,
        certificateIdentity: firstActivationCertificateIdentity,
      });
    } catch {
      throw new CliUsageError(
        "packages repository first-activate requires one exact bundle, exact publisher authority, a bounded interval, and finite checks",
      );
    }
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
  if (subcommand === "prune") {
    const expectedPlanDigest = values["expected-plan-digest"];
    const result =
      expectedPlanDigest === undefined
        ? await store.previewPrune({
            ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
          })
        : await store.applyPrune({
            expectedPlanDigest,
            ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
          });
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  if (subcommand === "repository") {
    const sigstoreVerifier =
      overrides.sigstoreCapabilityVerifier ??
      new OfflineSigstoreCapabilityVerifier(createSigstorePublicGoodTrustedRoot());
    const repositoryStore = new LocalCapabilityRepositoryStore(
      config.projectRoot,
      createCapabilityRepositoryGenerationAuthenticator({ verifier: sigstoreVerifier }),
    );
    if (positionals[1] === "status") {
      const repository = await repositoryStore.status(overrides.signal);
      io.stdout(JSON.stringify({ repository: repository ?? null }, null, 2));
      return 0;
    }
    if (positionals[1] === "first-activate") {
      if (
        firstActivationPackageName === undefined ||
        firstActivationVersion === undefined ||
        firstActivationCertificateIssuer === undefined ||
        firstActivationCertificateIdentity === undefined ||
        firstActivationIntervalMs === undefined ||
        firstActivationMaxChecks === undefined
      ) {
        throw new CliUsageError(
          "packages repository first-activate requires one exact bundle, exact publisher authority, a bounded interval, and finite checks",
        );
      }
      const signal = overrides.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      let installedEntries: Awaited<ReturnType<LocalCapabilityPackageStore["list"]>>["bundles"];
      try {
        installedEntries = (await store.list()).bundles.filter(
          (entry) => entry.name === firstActivationPackageName,
        );
        signal.throwIfAborted();
      } catch {
        signal.throwIfAborted();
        throw new CapabilityRepositoryFirstActivationError("read installed package");
      }
      const activationAuthorization = Object.freeze({
        packageName: firstActivationPackageName,
        version: firstActivationVersion,
        certificateIssuer: firstActivationCertificateIssuer,
        certificateIdentity: firstActivationCertificateIdentity,
      });
      const activationStateStore = new LocalCapabilityRepositoryFirstActivationStore(
        config.projectRoot,
      );
      let activationState: Awaited<ReturnType<typeof activationStateStore.read>>;
      try {
        activationState = await activationStateStore.read(activationAuthorization, signal);
        signal.throwIfAborted();
      } catch {
        signal.throwIfAborted();
        throw new CapabilityRepositoryFirstActivationError(
          installedEntries.length > 0 ? "read installed package" : "read activation state",
        );
      }
      const receipt = activationState?.status === "waiting" ? undefined : activationState?.receipt;
      const installedEntry = installedEntries[0];
      const hasExactInstalledReceipt =
        installedEntries.length === 1 &&
        installedEntry !== undefined &&
        receipt !== undefined &&
        installedEntry.name === receipt.bundle.name &&
        installedEntry.version === receipt.bundle.version &&
        installedEntry.source === receipt.source &&
        installedEntry.digest === receipt.bundle.digest &&
        installedEntry.bytes === receipt.bundle.bytes &&
        installedEntry.publisher !== undefined &&
        installedEntry.publisher.kind === receipt.publisher.kind &&
        installedEntry.publisher.certificateIssuer === receipt.publisher.certificateIssuer &&
        installedEntry.publisher.certificateIdentity === receipt.publisher.certificateIdentity &&
        installedEntry.publisher.signatureBundleDigest === receipt.publisher.signatureBundleDigest;
      if (
        (installedEntries.length > 0 && !hasExactInstalledReceipt) ||
        (activationState?.status === "settled" && !hasExactInstalledReceipt)
      ) {
        throw new CapabilityRepositoryFirstActivationError("read installed package");
      }
      if (activationState === undefined || activationState.status === "waiting") {
        const repository = await repositoryStore.status(signal);
        if (repository === undefined) {
          throw new CapabilityRepositoryFirstActivationError("read activation state");
        }
      }
      const lease = await new LocalCapabilityRepositoryWatcherLock(config.projectRoot).acquire(
        signal,
      );
      let result: Awaited<ReturnType<typeof runCapabilityRepositoryFirstActivation>> | undefined;
      let operationError: unknown;
      try {
        result = await runCapabilityRepositoryFirstActivation(
          {
            state: activationStateStore,
            readInstalled: async (name, activeSignal) => {
              activeSignal.throwIfAborted();
              const entries = (await store.list()).bundles.filter((entry) => entry.name === name);
              const installed = [];
              for (const entry of entries) {
                installed.push(
                  await store.inspect(entry.name, entry.version, { signal: activeSignal }),
                );
              }
              activeSignal.throwIfAborted();
              return installed;
            },
            check: async (activeSignal) =>
              await createCapabilityRepositoryChecker({
                refresher: createLocalCapabilityRepositoryRefresher({
                  stateReader: repositoryStore,
                  fetcher:
                    overrides.capabilityRepositoryFetcher ??
                    createProductionCapabilityRepositoryFetcher(),
                }),
                verifier: sigstoreVerifier,
                publisher: repositoryStore,
                now: () => new Date(),
              }).check({ signal: activeSignal }),
            reopen: async (input) =>
              await reopenCapabilityRepositoryCandidate(
                { candidates: repositoryStore, verifier: sigstoreVerifier },
                input,
              ),
            install: async (input) => {
              try {
                return Object.freeze({
                  outcome: "settled" as const,
                  result: await store.installFromRepository(input),
                });
              } catch (error) {
                if (
                  error instanceof CapabilityPackageStoreError &&
                  error.code === "commit_uncertain"
                ) {
                  return Object.freeze({ outcome: "commit_uncertain" as const });
                }
                if (
                  error instanceof CapabilityPackageStoreError &&
                  error.code === "settlement_uncertain"
                ) {
                  return Object.freeze({ outcome: "settlement_uncertain" as const });
                }
                throw error;
              }
            },
            settlePackageMutation: async (activeSignal) => {
              await store.settleMutation(activeSignal);
            },
            now: overrides.capabilityRepositoryWatcherNow ?? (() => new Date()),
            wait:
              overrides.capabilityRepositoryWatcherWait ??
              (async (milliseconds, activeSignal) => {
                await delay(milliseconds, undefined, { signal: activeSignal });
              }),
            observe: (status) => {
              io.stdout(JSON.stringify(status));
            },
          },
          {
            packageName: firstActivationPackageName,
            version: firstActivationVersion,
            certificateIssuer: firstActivationCertificateIssuer,
            certificateIdentity: firstActivationCertificateIdentity,
            intervalMs: firstActivationIntervalMs,
            maxChecks: firstActivationMaxChecks,
            signal,
          },
        );
      } catch (error) {
        operationError = error;
      }
      let releaseError: unknown;
      try {
        await lease.release();
      } catch (error) {
        releaseError = error;
      }
      if (operationError !== undefined) {
        if (releaseError !== undefined) {
          const settlementError = new CapabilityRepositoryFirstActivationError("settle activation");
          io.stderr(`${settlementError.code}: ${settlementError.message}`);
        }
        throw operationError;
      }
      if (releaseError !== undefined) {
        throw new CapabilityRepositoryFirstActivationError("settle activation");
      }
      if (result === undefined) {
        throw new CapabilityRepositoryFirstActivationError("settle activation");
      }
      return result.outcome === "attempts_exhausted" ? 1 : 0;
    }
    if (positionals[1] === "watch") {
      if (
        watcherPackageName === undefined ||
        watcherCertificateIssuer === undefined ||
        watcherCertificateIdentity === undefined ||
        (watcherUpdatePolicy !== "patch" && watcherUpdatePolicy !== "minor") ||
        watcherIntervalMs === undefined
      ) {
        throw new CliUsageError(
          "packages repository watch requires one installed bundle, exact publisher authority, a bounded interval, and patch or minor policy",
        );
      }
      const signal = overrides.signal ?? new AbortController().signal;
      const lease = await new LocalCapabilityRepositoryWatcherLock(config.projectRoot).acquire(
        signal,
      );
      let operationError: unknown;
      try {
        const repository = await repositoryStore.status(signal);
        await runCapabilityRepositoryWatcher(
          {
            readInstalled: async (name, activeSignal) => {
              activeSignal.throwIfAborted();
              const installed = (await store.list()).bundles.find((entry) => entry.name === name);
              activeSignal.throwIfAborted();
              return installed;
            },
            check: async (activeSignal) =>
              await createCapabilityRepositoryChecker({
                refresher: createLocalCapabilityRepositoryRefresher({
                  stateReader: repositoryStore,
                  fetcher:
                    overrides.capabilityRepositoryFetcher ??
                    createProductionCapabilityRepositoryFetcher(),
                }),
                verifier: sigstoreVerifier,
                publisher: repositoryStore,
                now: () => new Date(),
              }).check({ signal: activeSignal }),
            replace: async (input) =>
              await replaceCapabilityRepositoryCandidate(
                { candidates: repositoryStore, verifier: sigstoreVerifier, packages: store },
                input,
              ),
            now: overrides.capabilityRepositoryWatcherNow ?? (() => new Date()),
            wait:
              overrides.capabilityRepositoryWatcherWait ??
              (async (milliseconds, activeSignal) => {
                await delay(milliseconds, undefined, { signal: activeSignal });
              }),
            observe: (status) => {
              io.stdout(JSON.stringify(status));
            },
          },
          {
            packageName: watcherPackageName,
            certificateIssuer: watcherCertificateIssuer,
            certificateIdentity: watcherCertificateIdentity,
            updatePolicy: watcherUpdatePolicy,
            intervalMs: watcherIntervalMs,
            ...(repository?.checkedAt === undefined
              ? {}
              : { previousCompletedAt: repository.checkedAt }),
            signal,
          },
        );
      } catch (error) {
        operationError = error;
      }
      try {
        await lease.release();
      } catch (error) {
        if (operationError === undefined) {
          throw error;
        }
        throw new CapabilityRepositoryWatcherError("settle watcher ownership");
      }
      throw operationError;
    }
    if (positionals[1] === "check") {
      const checked = await createCapabilityRepositoryChecker({
        refresher: createLocalCapabilityRepositoryRefresher({
          stateReader: repositoryStore,
          fetcher:
            overrides.capabilityRepositoryFetcher ?? createProductionCapabilityRepositoryFetcher(),
        }),
        verifier: sigstoreVerifier,
        publisher: repositoryStore,
        now: () => new Date(),
      }).check(overrides.signal === undefined ? {} : { signal: overrides.signal });
      io.stdout(JSON.stringify(checked, null, 2));
      return 0;
    }
    if (positionals[1] === "candidates") {
      io.stdout(
        JSON.stringify(
          { candidates: await repositoryStore.listCandidates(overrides.signal) },
          null,
          2,
        ),
      );
      return 0;
    }
    if (positionals[1] === "candidate") {
      const action = positionals[2];
      const candidateDigest = positionals[3];
      if (candidateDigest === undefined) {
        throw new CliUsageError(
          "packages repository candidate requires inspect, remove, activate, or replace <sha256:digest>",
        );
      }
      if (action === "inspect") {
        const candidate = (await repositoryStore.listCandidates(overrides.signal)).find(
          (entry) => entry.candidateDigest === candidateDigest,
        );
        if (candidate === undefined) {
          throw new CapabilityRepositoryStoreError("read repository candidate");
        }
        io.stdout(JSON.stringify({ candidate }, null, 2));
        return 0;
      }
      if (action === "remove") {
        const repository = await repositoryStore.removeCandidate(candidateDigest, overrides.signal);
        io.stdout(JSON.stringify({ status: "removed", candidateDigest, repository }, null, 2));
        return 0;
      }
      const certificateIssuer = values["certificate-issuer"];
      const certificateIdentity = values["certificate-identity"];
      if (certificateIssuer === undefined || certificateIdentity === undefined) {
        throw new CliUsageError(
          "packages repository candidate activate or replace requires <sha256:digest> and exact publisher authority",
        );
      }
      if (action === "replace") {
        const expectedCurrentVersion = values["from-version"];
        if (expectedCurrentVersion === undefined) {
          throw new CliUsageError(
            "packages repository candidate replace requires --from-version <exact>",
          );
        }
        const replaced = await replaceCapabilityRepositoryCandidate(
          { candidates: repositoryStore, verifier: sigstoreVerifier, packages: store },
          {
            candidateDigest,
            expectedCurrentVersion,
            certificateIssuer,
            certificateIdentity,
            ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
          },
        );
        io.stdout(
          JSON.stringify(
            {
              status: replaced.status,
              candidateDigest,
              ...(replaced.status === "replaced"
                ? { cleanup: replaced.cleanup, previous: replaced.previous }
                : {}),
              publisher: replaced.publisher,
              bundle: {
                name: replaced.bundle.name,
                version: replaced.bundle.version,
                bytes: replaced.bundle.bytes,
                digest: replaced.bundle.digest,
              },
            },
            null,
            2,
          ),
        );
        return 0;
      }
      const activated = await activateCapabilityRepositoryCandidate(
        {
          candidates: repositoryStore,
          verifier: sigstoreVerifier,
          packages: store,
        },
        {
          candidateDigest,
          certificateIssuer,
          certificateIdentity,
          ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
        },
      );
      io.stdout(
        JSON.stringify(
          {
            status: activated.status,
            candidateDigest,
            bundle: {
              name: activated.bundle.name,
              version: activated.bundle.version,
              bytes: activated.bundle.bytes,
              digest: activated.bundle.digest,
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const repositoryBaseUrl = positionals[2];
    const trustedRootPath = values["trusted-root"];
    if (repositoryBaseUrl === undefined || trustedRootPath === undefined) {
      throw new CliUsageError(
        "packages repository init requires <canonical-public-https-base> --trusted-root <local-root.json>",
      );
    }
    let trustedRoot: Buffer;
    try {
      trustedRoot = await readBoundedCommandInput(
        resolve(dependencies.cwd, trustedRootPath),
        MAX_CAPABILITY_REPOSITORY_TRUSTED_ROOT_BYTES,
      );
    } catch {
      throw new CapabilityRepositoryInitializationError("validate trusted root");
    }
    const repository = await createLocalCapabilityRepositoryInitializer({
      store: repositoryStore,
      now: () => new Date(),
    }).initialize({
      repositoryBaseUrl,
      trustedRoot,
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    });
    io.stdout(JSON.stringify({ status: "initialized", repository }, null, 2));
    return 0;
  }
  if (subcommand === "metadata") {
    const sigstoreVerifier =
      overrides.sigstoreCapabilityVerifier ??
      new OfflineSigstoreCapabilityVerifier(createSigstorePublicGoodTrustedRoot());
    const candidateStore = new LocalCapabilityMetadataCandidateStore(
      config.projectRoot,
      sigstoreVerifier,
    );
    if (positionals[1] === "inspect") {
      io.stdout(
        JSON.stringify({ metadata: await store.inspectMetadata(overrides.signal) }, null, 2),
      );
      return 0;
    }
    if (positionals[1] === "candidates") {
      io.stdout(
        JSON.stringify({ candidates: await candidateStore.list(overrides.signal) }, null, 2),
      );
      return 0;
    }
    if (positionals[1] === "candidate") {
      const action = positionals[2];
      const candidateDigest = positionals[3];
      if (candidateDigest === undefined || (action !== "inspect" && action !== "remove")) {
        throw new CliUsageError(
          "packages metadata candidate requires inspect or remove <sha256:digest>",
        );
      }
      if (action === "inspect") {
        const stored = await candidateStore.read(candidateDigest, overrides.signal);
        io.stdout(JSON.stringify({ candidate: stored.candidate }, null, 2));
        return 0;
      }
      await candidateStore.remove(candidateDigest, overrides.signal);
      io.stdout(JSON.stringify({ status: "removed", candidateDigest }, null, 2));
      return 0;
    }
    if (positionals[1] === "check") {
      const channel = positionals[2];
      const certificateIssuer = values["certificate-issuer"];
      const certificateIdentity = values["certificate-identity"];
      if (
        channel === undefined ||
        certificateIssuer === undefined ||
        certificateIdentity === undefined
      ) {
        throw new CliUsageError(
          "packages metadata check requires <https-channel-url> --certificate-issuer <https-url> --certificate-identity <exact>",
        );
      }
      const verifier = createSignedCapabilityMetadataVerifier(sigstoreVerifier);
      const checked = await createCapabilityMetadataChannelChecker({
        channel: overrides.capabilityMetadataChannel ?? createProductionCapabilityMetadataChannel(),
        verifier,
        activeMetadata: store,
        candidates: candidateStore,
        now: () => new Date(),
      }).check({
        channel,
        certificateIssuer,
        certificateIdentity,
        ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      });
      io.stdout(
        JSON.stringify(
          {
            status: checked.status,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (positionals[1] === "activate") {
      const candidateDigest = positionals[2];
      const certificateIssuer = values["certificate-issuer"];
      const certificateIdentity = values["certificate-identity"];
      if (
        candidateDigest === undefined ||
        certificateIssuer === undefined ||
        certificateIdentity === undefined
      ) {
        throw new CliUsageError(
          "packages metadata activate requires <sha256:digest> --certificate-issuer <https-url> --certificate-identity <exact>",
        );
      }
      const activated = await activateCapabilityMetadataCandidate(
        {
          candidates: candidateStore,
          verifier: createSignedCapabilityMetadataVerifier(sigstoreVerifier),
          activeMetadata: store,
          now: () => new Date(),
        },
        {
          candidateDigest,
          certificateIssuer,
          certificateIdentity,
          ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
        },
      );
      io.stdout(
        JSON.stringify(
          { status: activated.status, candidateDigest, metadata: activated.state },
          null,
          2,
        ),
      );
      return 0;
    }
    const metadataPath = positionals[2];
    const sigstoreBundlePath = values["sigstore-bundle"];
    const certificateIssuer = values["certificate-issuer"];
    const certificateIdentity = values["certificate-identity"];
    if (
      metadataPath === undefined ||
      sigstoreBundlePath === undefined ||
      certificateIssuer === undefined ||
      certificateIdentity === undefined
    ) {
      throw new CliUsageError(
        "packages metadata refresh requires <metadata.json> --sigstore-bundle <bundle.json> --certificate-issuer <https-url> --certificate-identity <exact>",
      );
    }
    let metadata: Buffer;
    let sigstoreBundle: Buffer;
    try {
      [metadata, sigstoreBundle] = await Promise.all([
        readBoundedCommandInput(
          resolve(dependencies.cwd, metadataPath),
          MAX_CAPABILITY_METADATA_BYTES,
        ),
        readBoundedCommandInput(
          resolve(dependencies.cwd, sigstoreBundlePath),
          MAX_SIGSTORE_BUNDLE_BYTES,
        ),
      ]);
    } catch (error) {
      throw new CapabilityPackageStoreError(
        "io",
        "could not read signed capability metadata inputs",
        { cause: error },
      );
    }
    const imported = await createCapabilityMetadataImporter(
      overrides.sigstoreCapabilityVerifier ??
        new OfflineSigstoreCapabilityVerifier(createSigstorePublicGoodTrustedRoot()),
      store,
    ).import({
      metadata,
      sigstoreBundle,
      certificateIssuer,
      certificateIdentity,
      now: new Date(),
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    });
    io.stdout(JSON.stringify({ status: imported.status, metadata: imported.state }, null, 2));
    return 0;
  }
  if (subcommand === "install-oci") {
    const reference = positionals[1];
    const certificateIssuer = values["certificate-issuer"];
    const certificateIdentity = values["certificate-identity"];
    if (
      reference === undefined ||
      certificateIssuer === undefined ||
      certificateIdentity === undefined
    ) {
      throw new CliUsageError(
        "packages install-oci requires <digest-reference> --certificate-issuer <https-url> --certificate-identity <exact>",
      );
    }
    const installer = createSignedOciCapabilityBundleInstaller(
      overrides.ociCapabilityRegistry ?? createProductionOciCapabilityRegistry(),
      overrides.sigstoreCapabilityVerifier ??
        new OfflineSigstoreCapabilityVerifier(createSigstorePublicGoodTrustedRoot()),
      store,
    );
    const username = values.username;
    const credentialProvider: OciRegistryCredentialProvider | undefined =
      username === undefined
        ? undefined
        : async (_challenge, signal) =>
            Object.freeze({
              username,
              password: await (overrides.readRegistrySecret ?? readProcessRegistrySecret)(signal),
            });
    const installed = await installer.install({
      reference,
      certificateIssuer,
      certificateIdentity,
      ...(credentialProvider === undefined ? {} : { credentialProvider }),
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    });
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
          source: installed.source,
          publisher: installed.publisher,
          packages: installed.bundle.packages.map(capabilityBundlePackageSummary),
        },
        null,
        2,
      ),
    );
    return 0;
  }
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
    const verified = await store.verify({
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    });
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
  const selected = await store.inspect(name, version, {
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
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

function parseRepositoryWatcherInterval(value: string | undefined): number {
  if (value === undefined) {
    return 60 * 60 * 1_000;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliUsageError("--interval-ms requires a bounded positive integer");
  }
  const intervalMs = Number(value);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS ||
    intervalMs > MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS
  ) {
    throw new CliUsageError(
      `--interval-ms requires ${MIN_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS}..${MAX_CAPABILITY_REPOSITORY_CHECK_INTERVAL_MS}`,
    );
  }
  return intervalMs;
}

function parseRepositoryFirstActivationMaxChecks(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new CliUsageError("--max-checks requires a bounded positive integer");
  }
  const maximumChecks = Number(value);
  if (
    !Number.isSafeInteger(maximumChecks) ||
    maximumChecks > MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS
  ) {
    throw new CliUsageError(
      `--max-checks requires 1..${MAX_CAPABILITY_REPOSITORY_FIRST_ACTIVATION_CHECKS}`,
    );
  }
  return maximumChecks;
}

async function readBoundedCommandInput(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      throw new Error("signed capability metadata input is not a bounded regular file");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error("signed capability metadata input exceeds its byte limit");
    }
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      BigInt(offset) !== after.size
    ) {
      throw new Error("signed capability metadata input changed during bounded read");
    }
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }
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
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
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
                  ...(profile.capabilitySnapshot === undefined
                    ? {}
                    : { capabilitySnapshotDigest: profile.capabilitySnapshot.digest }),
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
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });
    dependencies.signal?.throwIfAborted();
    const evaluationLocation = await resolveEvaluationLocation(
      dependencies,
      values["evaluations-dir"],
    );
    dependencies.signal?.throwIfAborted();
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
    dependencies.signal?.throwIfAborted();
    const evaluationId = values["evaluation-id"] ?? admitted.id;
    const store = new LocalEvaluationStore(evaluationsDirectory);
    const header = createPublicEvaluationHeader(admitted, evaluationId);
    try {
      await store.read(evaluationId);
      dependencies.signal?.throwIfAborted();
    } catch (error) {
      if (!(error instanceof EvaluationStoreError && error.code === "not_found")) {
        throw error;
      }
      dependencies.signal?.throwIfAborted();
      await store.create(header, {
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      });
    }
    dependencies.signal?.throwIfAborted();
    const claimed = await store.claim(evaluationId, admitted.planDigest, {
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });
    try {
      dependencies.signal?.throwIfAborted();
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
    for (const option of [
      "allow-nodes",
      "allow-resources",
      "blueprint",
      "id",
      "max-output-tokens",
      "memory-agent",
      "memory-child-path",
      "memory-entry",
      "memory-operation",
      "model",
      "output",
      "provider",
      "skill",
      "thinking",
      "timeout-ms",
      "version",
    ]) {
      assertStringOptionAtMostOnce(args.slice(1), option);
    }
    const { positionals, values } = parseCommandArgs(args.slice(1), {
      "allow-nodes": { type: "string" },
      "allow-resources": { type: "string" },
      blueprint: { type: "string" },
      "max-output-tokens": { type: "string" },
      "memory-agent": { type: "string" },
      "memory-child-path": { type: "string" },
      "memory-entry": { type: "string" },
      "memory-operation": { type: "string" },
      id: { type: "string" },
      model: { type: "string" },
      output: { type: "string" },
      provider: { type: "string" },
      skill: { type: "string" },
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
    const usesAgentSkillMode =
      values.skill !== undefined || values["allow-resources"] !== undefined;
    const usesAgentSkillPackageMode = values.blueprint !== undefined;
    const usesSupplementalMemoryMode =
      values["memory-agent"] !== undefined ||
      values["memory-child-path"] !== undefined ||
      values["memory-entry"] !== undefined ||
      values["memory-operation"] !== undefined;
    const usesPromptMode = values["allow-nodes"] !== undefined;
    const dependencies = dependenciesFrom(overrides);
    const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
    const outputPath = resolve(
      dependencies.cwd,
      requireStringOption(values.output, "candidate generate requires --output <path>"),
    );
    if (usesAgentSkillPackageMode) {
      await assertLocalAgentSkillPackageCandidateOutputAvailable(outputPath, dependencies.signal);
    } else {
      await assertLocalPromptCandidateOutputAvailable(outputPath);
    }
    if (
      [
        usesAgentSkillPackageMode,
        usesAgentSkillMode,
        usesSupplementalMemoryMode,
        usesPromptMode,
      ].filter(Boolean).length !== 1 ||
      (usesAgentSkillMode &&
        (values.skill === undefined || values["allow-resources"] === undefined)) ||
      (usesSupplementalMemoryMode &&
        (values["memory-agent"] === undefined ||
          values["memory-entry"] === undefined ||
          values["memory-operation"] === undefined))
    ) {
      throw new CliUsageError(
        "candidate generation mode requires exactly one of --allow-nodes, both --skill and --allow-resources, --blueprint, or --memory-agent with --memory-entry and --memory-operation",
      );
    }
    if (usesSupplementalMemoryMode) {
      const baselineState = (
        await loadCurrentEffectiveHarnessBaseline(baseline, config, dependencies.signal)
      ).state;
      const admitted = await admitLocalSupplementalMemoryCandidateGenerationSources(
        outputPath,
        evidence.map((path) => resolve(dependencies.cwd, path)),
        dependencies.signal === undefined ? {} : { signal: dependencies.signal },
      );
      const prepared = prepareSupplementalMemoryCandidateGeneration({
        candidate: {
          id: requireStringOption(values.id, "candidate generate requires --id <id>"),
          version: requireStringOption(
            values.version,
            "candidate generate requires --version <semver>",
          ),
        },
        baseline: baselineState,
        target: {
          workflowId: baseline,
          childPath:
            values["memory-child-path"] === undefined
              ? []
              : values["memory-child-path"].split(",").map((nodeId) => nodeId.trim()),
          agentNodeId: requireStringOption(
            values["memory-agent"],
            "candidate generate requires --memory-agent <id>",
          ),
          entryId: requireStringOption(
            values["memory-entry"],
            "candidate generate requires --memory-entry <id>",
          ),
          operation: parseSupplementalMemoryGenerationOperation(values["memory-operation"]),
        },
        evidence: admitted.evidence.map((item) => ({
          provenance: item.provenance,
          sourceSha256: item.sourceSha256,
          packet: item.packet,
        })),
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
            MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_GENERATION_OUTPUT_TOKENS,
          ),
        },
      });
      const source = await generateSupplementalMemoryCandidate(
        {
          prepared,
          cwd: admitted.root,
          ...(config.projectRoot === null ? {} : { projectRoot: config.projectRoot }),
          protectedPaths: [],
          ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        },
        dependencies.createNodeExecutor(
          config.sandbox.profile,
          config.projectRoot ?? admitted.root,
        ),
      );
      throwIfAborted(dependencies.signal, "candidate generation was cancelled");
      await admitted.revalidate();
      throwIfAborted(dependencies.signal, "candidate generation was cancelled");
      const sourceText = `${JSON.stringify(source, null, 2)}\n`;
      const projected = projectSupplementalMemoryCandidate({
        manifestProvenance: basename(admitted.outputPath),
        source,
        sourceSha256: sha256Text(sourceText),
        baseline: baselineState,
        evidence: admitted.evidence,
      });
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
            candidate: supplementalMemoryCandidateView(projected.identity),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (usesAgentSkillPackageMode) {
      const admitted = await admitLocalAgentSkillPackageCandidateGenerationSources({
        outputPath,
        baselinePath: resolve(dependencies.cwd, baseline),
        evidencePaths: evidence.map((path) => resolve(dependencies.cwd, path)),
        blueprintPath: resolve(
          dependencies.cwd,
          requireStringOption(values.blueprint, "candidate generate requires --blueprint <path>"),
        ),
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      });
      const prepared = prepareAgentSkillPackageCandidateGeneration({
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
          compiled: admitted.baseline.compiled,
        },
        targetNodeId: admitted.blueprint.document.scope.nodeId,
        blueprint: {
          provenance: admitted.blueprint.provenance,
          sourceSha256: admitted.blueprint.sourceSha256,
          document: admitted.blueprint.document,
        },
        evidence: admitted.evidence.map((item) => ({
          provenance: item.provenance,
          sourceSha256: item.sourceSha256,
          packet: item.packet,
        })),
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
            MAX_AGENT_SKILL_PACKAGE_CANDIDATE_GENERATION_OUTPUT_TOKENS,
          ),
        },
      });
      const completed = await generateAgentSkillPackageCandidate(
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
      const source = createAgentSkillPackageCandidateSource(prepared, completed);
      const sourceText = `${JSON.stringify(source, null, 2)}\n`;
      const projected = projectAgentSkillPackageCandidate({
        manifestProvenance: `${basename(admitted.outputPath)}/CANDIDATE.json`,
        source,
        sourceSha256: sha256Text(sourceText),
        baseline: {
          provenance: admitted.baseline.provenance,
          source: admitted.baseline.source,
          sourceSha256: admitted.baseline.sourceSha256,
          compiled: admitted.baseline.compiled,
        },
        evidence: admitted.evidence,
        package: completed.package,
      });
      await publishLocalAgentSkillPackageCandidate(admitted.outputPath, source, completed.package, {
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        revalidate: admitted.revalidate,
        beforePublish: async () => {
          await admitted.revalidate();
          throwIfAborted(dependencies.signal, "candidate generation was cancelled");
        },
      });
      io.stdout(
        JSON.stringify(
          {
            generated: true,
            output: relative(admitted.root, admitted.outputPath).split(sep).join("/"),
            candidate: {
              kind: projected.identity.kind,
              id: projected.identity.id,
              version: projected.identity.candidateVersion,
              skill: projected.identity.package.name,
              paths: source.blueprint.document.files.map((file) => file.path),
              provider: projected.identity.generation.provider,
              model: projected.identity.generation.model,
              limits: projected.identity.generation.limits,
              usage: projected.identity.generation.usage,
              requestDigest: projected.identity.generation.requestDigest,
              responseDigest: projected.identity.generation.responseDigest,
              packageDigest: projected.identity.package.packageDigest,
              workflowDigest: projected.identity.projectedWorkflow.workflowDigest,
              candidateDigest: projected.identity.candidateDigest,
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (usesAgentSkillMode) {
      const admitted = await admitLocalAgentSkillCandidateGenerationSources({
        outputPath,
        baselinePath: resolve(dependencies.cwd, baseline),
        evidencePaths: evidence.map((path) => resolve(dependencies.cwd, path)),
        skillName: requireStringOption(values.skill, "candidate generate requires --skill <name>"),
        resourcePaths: requireStringOption(
          values["allow-resources"],
          "candidate generate requires --allow-resources <path,...>",
        )
          .split(",")
          .map((path) => path.trim()),
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      });
      const prepared = prepareAgentSkillCandidateGeneration({
        candidate: {
          id: requireStringOption(values.id, "candidate generate requires --id <id>"),
          version: requireStringOption(
            values.version,
            "candidate generate requires --version <semver>",
          ),
        },
        baseline: admitted.baseline,
        skill: admitted.skill,
        evidence: admitted.evidence,
        allowedResourcePaths: admitted.resourcePaths,
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
            MAX_AGENT_SKILL_CANDIDATE_GENERATION_OUTPUT_TOKENS,
          ),
        },
      });
      const source = await generateAgentSkillCandidate(
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
      const projected = projectAgentSkillCandidate({
        manifestProvenance: basename(admitted.outputPath),
        source,
        sourceSha256: sha256Text(sourceText),
        baseline: {
          workflow: {
            provenance: admitted.baseline.provenance,
            sourceSha256: admitted.baseline.sourceSha256,
            compiled: admitted.baseline.compiled,
          },
          skill: admitted.skill,
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
            output: relative(admitted.root, admitted.outputPath).split(sep).join("/"),
            candidate: {
              kind: projected.identity.kind,
              id: projected.identity.id,
              version: projected.identity.candidateVersion,
              skill: projected.identity.scope.skillName,
              provider: projected.identity.generation?.provider,
              model: projected.identity.generation?.model,
              limits: projected.identity.generation?.limits,
              usage: projected.identity.generation?.usage,
              requestDigest: projected.identity.generation?.requestDigest,
              responseDigest: projected.identity.generation?.responseDigest,
              baselinePackageDigest: projected.identity.baseline.skill.packageDigest,
              projectedPackageDigest: projected.identity.projectedSkill.packageDigest,
              candidateDigest: projected.identity.candidateDigest,
              changes: projected.identity.changes.map((change) => change.path),
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
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
    const dependencies = configDependenciesFrom(overrides);
    const admitted = await admitLocalAdaptationCandidate(resolve(dependencies.cwd, candidatePath), {
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      resolveChildSpecialistPackages: async (source) => {
        const config = await awaitWithCancellationPrecedence(
          () => dependencies.loadConfig({ cwd: dependencies.cwd }),
          overrides.signal,
          "candidate validation was cancelled",
        );
        const baseline = await loadCurrentEffectiveHarnessBaseline(
          source.scope.workflowId,
          config,
          overrides.signal,
        );
        return baseline.state.packages;
      },
      resolveSupplementalMemoryBaseline: async (source) => {
        const config = await awaitWithCancellationPrecedence(
          () => dependencies.loadConfig({ cwd: dependencies.cwd }),
          overrides.signal,
          "candidate validation was cancelled",
        );
        return (
          await loadCurrentEffectiveHarnessBaseline(
            source.scope.workflowId,
            config,
            overrides.signal,
          )
        ).state;
      },
    });
    io.stdout(
      JSON.stringify({ valid: true, candidate: adaptationCandidateView(admitted) }, null, 2),
    );
    return 0;
  }
  if (subcommand === "compose") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    const candidatePath = requireSinglePositional(
      positionals,
      "candidate compose requires one candidate path",
    );
    const dependencies = configDependenciesFrom(overrides);
    const config = await awaitWithCancellationPrecedence(
      () => dependencies.loadConfig({ cwd: dependencies.cwd }),
      overrides.signal,
      "candidate composition was cancelled",
    );
    if (config.projectRoot === null) {
      throw new EffectiveHarnessStoreError(
        "not_found",
        "effective harness composition requires a Flow project root",
      );
    }
    const admitted = await admitLocalAdaptationCandidate(resolve(dependencies.cwd, candidatePath), {
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      resolveChildSpecialistPackages: async (source) =>
        (
          await loadCurrentEffectiveHarnessBaseline(
            source.scope.workflowId,
            config,
            overrides.signal,
          )
        ).state.packages,
      resolveSupplementalMemoryBaseline: async (source) =>
        (
          await loadCurrentEffectiveHarnessBaseline(
            source.scope.workflowId,
            config,
            overrides.signal,
          )
        ).state,
    });
    if (admitted.kind === "effective-harness-candidate") {
      throw new EffectiveHarnessStoreError(
        "invalid_input",
        "effective harness composition requires one ordinary adaptation candidate",
      );
    }
    const baseline = await loadCurrentEffectiveHarnessBaseline(
      admitted.candidate.identity.scope.workflowId,
      config,
      overrides.signal,
    );
    const projected = projectEffectiveHarnessCandidate({
      baseline: baseline.state,
      candidate: effectiveHarnessProjection(admitted),
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: baseline.head,
      baselineState: baseline.state,
      candidateState: projected.state,
      candidate: admitted.candidate.identity,
    });
    throwIfAborted(overrides.signal, "candidate composition was cancelled");
    const store = new LocalEffectiveHarnessStore(config.projectRoot);
    const staged = await store.stageCandidate(artifact, overrides.signal);
    io.stdout(
      JSON.stringify(
        {
          composed: true,
          candidate: effectiveHarnessCandidateView(artifact),
          staged: {
            path: relative(config.projectRoot, staged.path),
            artifactDigest: staged.artifactDigest,
            stateDigest: staged.stateDigest,
          },
        },
        null,
        2,
      ),
    );
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
    const config = await awaitWithCancellationPrecedence(
      () => dependencies.loadConfig({ cwd: dependencies.cwd }),
      overrides.signal,
      "candidate activation was cancelled",
    );
    const admitted = await awaitWithCancellationPrecedence(
      () =>
        admitLocalAdaptationCandidate(resolve(dependencies.cwd, candidatePath), {
          ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
          resolveChildSpecialistPackages: async (source) =>
            (
              await loadCurrentEffectiveHarnessBaseline(
                source.scope.workflowId,
                config,
                overrides.signal,
              )
            ).state.packages,
          resolveSupplementalMemoryBaseline: async (source) =>
            (
              await loadCurrentEffectiveHarnessBaseline(
                source.scope.workflowId,
                config,
                overrides.signal,
              )
            ).state,
        }),
      overrides.signal,
      "candidate activation was cancelled",
    );
    if (admitted.kind === "model-routing-candidate") {
      throw new CliUsageError(
        "model-routing candidate activation requires a composed effective harness candidate",
      );
    }
    if (admitted.kind === "child-specialist-candidate") {
      throw new CliUsageError(
        "child-specialist candidate activation requires a composed effective harness candidate",
      );
    }
    if (admitted.kind === "supplemental-memory-candidate") {
      throw new CliUsageError(
        "supplemental-memory candidate activation requires a composed effective harness candidate",
      );
    }
    const evaluationsDirectory = await awaitWithCancellationPrecedence(
      () => resolveEvaluationsDirectory(dependencies, values["evaluations-dir"]),
      overrides.signal,
      "candidate activation was cancelled",
    );
    const evaluation = await awaitWithCancellationPrecedence(
      () => new LocalEvaluationStore(evaluationsDirectory).read(evaluationId),
      overrides.signal,
      "candidate activation was cancelled",
    );
    if (admitted.kind === "effective-harness-candidate") {
      const prepared = prepareEffectiveHarnessActivation({
        artifact: admitted.candidate.artifact,
        stored: evaluation,
      });
      const store = effectiveHarnessStore(config);
      const input = {
        prepared,
        actor,
        ...(values.reason === undefined ? {} : { reason: values.reason }),
        ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      };
      throwIfAborted(overrides.signal, "candidate activation was cancelled");
      if (dryRun.enabled) {
        const proposal = await store.previewActivate(input);
        throwIfAborted(overrides.signal, "candidate activation was cancelled");
        io.stdout(
          JSON.stringify(
            {
              dryRun: true,
              activation: adaptationCandidateView(admitted),
              proposal,
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
    const store = promptActivationStore(config);
    const snapshots =
      admitted.kind === "prompt-candidate"
        ? createPromptActivationFromEvaluation(admitted.candidate, evaluation)
        : admitted.kind === "agent-skill-candidate"
          ? createAgentSkillActivationFromEvaluation(
              {
                identity: admitted.candidate.identity,
                workflow: {
                  source: admitted.candidate.baseline.workflow.sourceText,
                  sourceSha256: admitted.candidate.baseline.workflow.sourceSha256,
                  workflowDigest: admitted.candidate.baseline.workflow.workflowDigest,
                },
                baselineSkill: requiredSingleAgentSkill(
                  admitted.candidate.baselineCapabilitySnapshot,
                ),
                candidateSkill: requiredSingleAgentSkill(
                  admitted.candidate.candidateCapabilitySnapshot,
                ),
              },
              evaluation,
            )
          : createAgentSkillPackageActivationFromEvaluation(
              {
                identity: admitted.candidate.identity,
                baselineWorkflow: {
                  source: admitted.candidate.baseline.sourceText,
                  sourceSha256: admitted.candidate.identity.baseline.workflow.sourceSha256,
                  workflowDigest: admitted.candidate.identity.baseline.workflow.workflowDigest,
                },
                candidateWorkflow: {
                  source: admitted.candidate.workflow.source,
                  sourceSha256: admitted.candidate.identity.projectedWorkflow.sourceSha256,
                  workflowDigest: admitted.candidate.identity.projectedWorkflow.workflowDigest,
                },
                candidateSkill: requiredSingleAgentSkill(
                  admitted.candidate.candidateCapabilitySnapshot,
                ),
              },
              evaluation,
            );
    throwIfAborted(overrides.signal, "candidate activation was cancelled");
    const input = {
      snapshot: snapshots.candidate,
      baselineSnapshot: snapshots.baseline,
      actor,
      ...(values.reason === undefined ? {} : { reason: values.reason }),
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    };
    if (dryRun.enabled) {
      const proposal = await store.previewActivate(input);
      throwIfAborted(overrides.signal, "candidate activation was cancelled");
      io.stdout(
        JSON.stringify(
          {
            dryRun: true,
            activation: adaptiveActivationView(snapshots.candidate),
            proposal,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    throwIfAborted(overrides.signal, "candidate activation was cancelled");
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
  throw new CliUsageError("candidate requires generate, compose, validate, or activate");
}

async function activationCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const subcommand = args[0];
  const dependencies = configDependenciesFrom(overrides);
  const config = await awaitWithCancellationPrecedence(
    () => dependencies.loadConfig({ cwd: dependencies.cwd }),
    overrides.signal,
    "activation command was cancelled",
  );
  const store = promptActivationStore(config);
  const harnessStore = effectiveHarnessStore(config);
  if (subcommand === "list") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    if (positionals.length !== 0) {
      throw new CliUsageError("activation list accepts no arguments");
    }
    const legacy = await store.list();
    overrides.signal?.throwIfAborted();
    const effectiveHarness = await harnessStore.list();
    overrides.signal?.throwIfAborted();
    io.stdout(
      JSON.stringify(
        effectiveHarness.heads.length === 0
          ? legacy
          : { ...legacy, effectiveHarness: effectiveHarnessIndexView(effectiveHarness) },
        null,
        2,
      ),
    );
    return 0;
  }
  if (subcommand === "inspect") {
    const { positionals } = parseCommandArgs(args.slice(1), {});
    const workflowId = requireSinglePositional(
      positionals,
      "activation inspect requires one workflow id",
    );
    const effectiveIndex = await harnessStore.list();
    overrides.signal?.throwIfAborted();
    const effectiveHead = effectiveIndex.heads.find((item) => item.workflowId === workflowId);
    if (effectiveHead !== undefined) {
      const active = await harnessStore.loadActive(workflowId);
      overrides.signal?.throwIfAborted();
      io.stdout(
        JSON.stringify(
          {
            workflowId,
            effectiveHarness: {
              head: active.head,
              history: effectiveIndex.history.filter((item) => item.workflowId === workflowId),
              active: effectiveHarnessStateView(active.state),
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
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
        : adaptiveActivationView((await store.loadActive(workflowId)).snapshot);
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
    const targetValue = requireStringOption(
      values.to,
      "activation rollback requires --to <target>",
    );
    requireMutationMode(dryRun.enabled, values["expected-digest"], "activation rollback");
    const stateTargetDigest = parseEffectiveHarnessRollbackState(targetValue);
    if (stateTargetDigest !== undefined) {
      const input = {
        workflowId,
        targetStateDigest: stateTargetDigest,
        actor,
        ...(values.reason === undefined ? {} : { reason: values.reason }),
        ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      };
      if (dryRun.enabled) {
        io.stdout(
          JSON.stringify(
            { dryRun: true, proposal: await harnessStore.previewRollback(input) },
            null,
            2,
          ),
        );
        return 0;
      }
      io.stdout(
        JSON.stringify(
          await harnessStore.applyRollback({
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
    const effectiveIndex = await harnessStore.list();
    overrides.signal?.throwIfAborted();
    if (effectiveIndex.heads.some((item) => item.workflowId === workflowId)) {
      throw new CliUsageError("effective harness rollback requires --to state:<sha256>");
    }
    const target = parseRollbackSelection(targetValue);
    const input = {
      workflowId,
      target,
      actor,
      ...(values.reason === undefined ? {} : { reason: values.reason }),
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
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

function effectiveHarnessStore(config: EffectiveFlowConfig): LocalEffectiveHarnessStore {
  if (config.projectRoot === null) {
    throw new EffectiveHarnessStoreError(
      "not_found",
      "effective harness activation requires a Flow project root",
    );
  }
  return new LocalEffectiveHarnessStore(config.projectRoot);
}

function adaptiveActivationView(snapshot: AdaptiveActivationSnapshot) {
  if (snapshot.kind === "prompt-activation") {
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
  return Object.freeze({
    version: snapshot.version,
    kind: snapshot.kind,
    selection: snapshot.selection,
    workflowId: snapshot.workflowId,
    candidateId: snapshot.candidateId,
    candidateVersion: snapshot.candidateVersion,
    candidate: snapshot.candidate,
    evaluation: snapshot.evaluation,
    activationDigest: snapshot.activationDigest,
    workflow: { bytes: snapshot.workflow.bytes, sha256: snapshot.workflow.sha256 },
    ...(snapshot.skill === undefined
      ? {}
      : { skill: { name: snapshot.skill.name, digest: snapshot.skill.digest } }),
  });
}

function adaptationCandidateView(
  admitted: Awaited<ReturnType<typeof admitLocalAdaptationCandidate>>,
) {
  if (admitted.kind === "supplemental-memory-candidate") {
    return supplementalMemoryCandidateView(admitted.candidate.identity);
  }
  if (admitted.kind !== "effective-harness-candidate") {
    return admitted.candidate.identity;
  }
  return effectiveHarnessCandidateView(admitted.candidate.artifact);
}

function supplementalMemoryCandidateView(identity: SupplementalMemoryCandidateIdentity) {
  const { manifest, generation, ...publicIdentity } = identity;
  return Object.freeze({
    ...publicIdentity,
    version: identity.candidateVersion,
    operation: generation?.operation ?? identity.change.kind,
    ...(generation === undefined ? {} : { provider: generation.provider, model: generation.model }),
    manifest: { sourceSha256: manifest.sourceSha256 },
    ...(generation === undefined
      ? {}
      : {
          generation: {
            ...generation,
            evidence: generation.evidence.map(({ path: _path, ...evidence }) => evidence),
          },
        }),
  });
}

function effectiveHarnessProjection(
  admitted: Exclude<
    Awaited<ReturnType<typeof admitLocalAdaptationCandidate>>,
    { readonly kind: "effective-harness-candidate" }
  >,
): EffectiveHarnessCandidateProjection {
  switch (admitted.kind) {
    case "prompt-candidate":
      return {
        kind: "prompt",
        projection: admitted.candidate,
        baselineWorkflowSource: admitted.candidate.baseline.sourceText,
      };
    case "agent-skill-candidate":
      return {
        kind: "agent-skill-resource",
        projection: admitted.candidate,
        baselineWorkflowSource: admitted.candidate.baseline.workflow.sourceText,
      };
    case "agent-skill-package-candidate":
      return {
        kind: "agent-skill-package",
        baselineWorkflowSource: admitted.candidate.baseline.sourceText,
        projection: {
          identity: admitted.candidate.identity,
          workflow: admitted.candidate.workflow,
          baselineCapabilitySnapshot: undefined,
          candidateCapabilitySnapshot: admitted.candidate.candidateCapabilitySnapshot,
        },
      };
    case "model-routing-candidate":
      return {
        kind: "model-routing",
        projection: admitted.candidate,
        baselineWorkflowSource: admitted.candidate.baseline.sourceText,
      };
    case "child-specialist-candidate":
      return {
        kind: "child-specialist",
        projection: {
          identity: admitted.candidate.identity,
          workflow: admitted.candidate.workflow,
        },
        baselineWorkflowSource: admitted.candidate.baseline.sourceText,
      };
    case "supplemental-memory-candidate":
      return {
        kind: "supplemental-memory",
        projection: {
          identity: admitted.candidate.identity,
          state: admitted.candidate.state,
        },
      };
  }
}

function effectiveHarnessCandidateView(artifact: EffectiveHarnessCandidateArtifact) {
  return Object.freeze({
    kind: artifact.kind,
    artifactDigest: artifact.artifactDigest,
    scopeDigest: artifact.scopeDigest,
    workflowId: artifact.workflowId,
    surface: artifact.surface,
    candidate: artifact.candidate,
    baselineHeadDigest: artifact.baselineHead.headDigest,
    baselineStateDigest: artifact.baselineState.stateDigest,
    candidateStateDigest: artifact.candidateState.stateDigest,
  });
}

function effectiveHarnessIndexView(index: Awaited<ReturnType<LocalEffectiveHarnessStore["list"]>>) {
  return Object.freeze({
    version: index.version,
    origins: index.origins,
    states: index.states,
    artifacts: index.artifacts,
    heads: index.heads,
    history: index.history.map((transition) =>
      transition.action === "activate"
        ? Object.freeze({ ...transition, artifactDigest: transition.toActivationDigest })
        : transition,
    ),
    digest: index.digest,
  });
}

function effectiveHarnessStateView(state: EffectiveHarnessState) {
  return Object.freeze({
    version: state.version,
    kind: state.kind,
    scopeDigest: state.scopeDigest,
    workflowId: state.workflowId,
    workflow: {
      bytes: state.workflow.bytes,
      sha256: state.workflow.sha256,
      workflowDigest: state.workflow.workflowDigest,
    },
    ...(state.rootPackage === undefined ? {} : { rootPackage: state.rootPackage }),
    packages: state.packages.map((item) =>
      item.kind === "agent-skill"
        ? Object.freeze({ kind: item.kind, name: item.name, digest: item.digest })
        : Object.freeze({
            kind: item.kind,
            name: item.name,
            version: item.version,
            digest: item.digest,
          }),
    ),
    ...(state.supplementalMemory === undefined
      ? {}
      : {
          supplementalMemory: state.supplementalMemory.map((entry) =>
            Object.freeze({
              id: entry.id,
              target: entry.target,
              bytes: entry.bytes,
              sha256: entry.sha256,
            }),
          ),
        }),
    stateDigest: state.stateDigest,
  });
}

function adaptiveActivationSource(snapshot: AdaptiveActivationSnapshot): string {
  if (snapshot.kind === "agent-skill-activation") {
    return agentSkillActivationWorkflow(snapshot);
  }
  if (snapshot.kind === "agent-skill-package-activation") {
    return agentSkillPackageActivationWorkflow(snapshot);
  }
  return promptActivationSource(snapshot);
}

function requiredSingleAgentSkill(
  snapshot: AgentSkillCapabilitySnapshot,
): AgentSkillPackageSnapshot {
  const skill = snapshot.packages[0];
  if (snapshot.packages.length !== 1 || skill === undefined) {
    throw new Error("Agent Skill activation candidate must contain exactly one skill package");
  }
  return skill;
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
  const agentSkillMatch = /^agent-skill:([^@]+)@([^@]+)$/.exec(value);
  if (agentSkillMatch?.[1] !== undefined && agentSkillMatch[2] !== undefined) {
    return Object.freeze({
      kind: "agent-skill-activation" as const,
      candidateId: agentSkillMatch[1],
      candidateVersion: agentSkillMatch[2],
    });
  }
  const agentSkillPackageMatch = /^agent-skill-package:([^@]+)@([^@]+)$/.exec(value);
  if (agentSkillPackageMatch?.[1] !== undefined && agentSkillPackageMatch[2] !== undefined) {
    return Object.freeze({
      kind: "agent-skill-package-activation" as const,
      candidateId: agentSkillPackageMatch[1],
      candidateVersion: agentSkillPackageMatch[2],
    });
  }
  const match = /^([^:@]+)@([^@]+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new CliUsageError(
      "activation rollback target must be baseline, <candidate-id>@<exact-version>, agent-skill:<candidate-id>@<exact-version>, or agent-skill-package:<candidate-id>@<exact-version>",
    );
  }
  return Object.freeze({ candidateId: match[1], candidateVersion: match[2] });
}

function parseEffectiveHarnessRollbackState(value: string): string | undefined {
  if (!value.startsWith("state:")) return undefined;
  const stateDigest = value.slice("state:".length);
  if (!/^[a-f0-9]{64}$/.test(stateDigest)) {
    throw new CliUsageError("effective harness rollback target must be state:<sha256>");
  }
  return stateDigest;
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
  const result = await submitApprovalDecision({
    runId,
    requestId,
    actor,
    ...(decision === "approve"
      ? { decision }
      : {
          decision,
          ...(values.reason === undefined ? {} : { reason: values.reason }),
        }),
    store: dependencies.createStore(runsDirectory),
    sink: dependencies.createAgentCommandApprovalChannel(runsDirectory),
  });

  io.stdout(JSON.stringify(projectPublicRunOutput(result), null, 2));
  return 0;
}

async function submitApprovalDecision(input: {
  readonly runId: string;
  readonly requestId: string;
  readonly actor: string;
  readonly decision: "approve" | "deny";
  readonly reason?: string;
  readonly store: RecoverableRunEventStore;
  readonly sink: AgentCommandApprovalDecisionChannel;
}): Promise<unknown> {
  const decision =
    input.decision === "approve"
      ? {
          runId: input.runId,
          requestId: input.requestId,
          actor: input.actor,
          decision: input.decision,
          store: input.store,
        }
      : {
          runId: input.runId,
          requestId: input.requestId,
          actor: input.actor,
          decision: input.decision,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          store: input.store,
        };
  const agentSubmission = await trySubmitAgentCommandApprovalDecision({
    ...decision,
    sink: input.sink,
  });
  return agentSubmission ?? (await decideApproval(decision));
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
  const runsDirectory = await resolveRecoveryRunsDirectory(dependencies.cwd, values["runs-dir"]);
  const store = dependencies.createStore(runsDirectory);
  // Durable history is read without claiming ownership so package bytes can be reconstructed
  // before recovery performs its authoritative claim and compatibility checks.
  const durableState = reduceRunEvents(await store.read(runId));
  const capabilitySnapshot = durableState.capabilitySnapshot ?? undefined;
  const policyPackages = selectPolicyPackageSnapshot(capabilitySnapshot);
  const config = await dependencies.loadConfig({
    cwd: dependencies.cwd,
    ...(policyPackages === undefined ? {} : { policyPackages }),
  });
  assertCurrentPolicyPackageSnapshot(config, capabilitySnapshot, runId);
  const admitted = await admitResumeWorkflowArgument(
    workflowArgument,
    capabilitySnapshot,
    dependencies,
  );
  assertWorkflowSatisfiesPolicyPackages(admitted.workflow, capabilitySnapshot);
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

  io.stdout(JSON.stringify(projectPublicRunOutput(state), null, 2));
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
  const supplementalSnapshot = await resolveWorkflowCapabilitySnapshot(
    admitted.workflow,
    config,
    admitted.capabilitySnapshot,
  );
  const capabilitySnapshot = combineOptionalCapabilitySnapshots([
    admitted.capabilitySnapshot,
    supplementalSnapshot,
  ]);
  assertWorkflowSatisfiesPolicyPackages(admitted.workflow, capabilitySnapshot);
  const skillCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "agent-skill").length ?? 0;
  const verifierPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "verifier-package").length ?? 0;
  const toolPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "tool-package").length ?? 0;
  const workflowPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "workflow-package").length ?? 0;
  const policyPackageCount =
    capabilitySnapshot?.packages.filter((item) => item.kind === "policy-package").length ?? 0;

  io.stdout(
    `Workflow "${admitted.workflow.id}" is valid (nodes: ${admitted.workflow.nodes.length}, criteria: ${admitted.workflow.goal?.criteria.length ?? 0}, skills: ${skillCount}, verifier packages: ${verifierPackageCount}, tool packages: ${toolPackageCount}, workflow packages: ${workflowPackageCount}, policy packages: ${policyPackageCount}).`,
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
  const supplementalSnapshot = await resolveWorkflowCapabilitySnapshot(
    admitted.workflow,
    config,
    admitted.capabilitySnapshot,
  );
  const capabilitySnapshot = combineOptionalCapabilitySnapshots([
    admitted.capabilitySnapshot,
    supplementalSnapshot,
  ]);
  assertWorkflowSatisfiesPolicyPackages(admitted.workflow, capabilitySnapshot);
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

  io.stdout(JSON.stringify(projectPublicRunOutput(state), null, 2));
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

  io.stdout(JSON.stringify(projectPublicRunOutput(state), null, 2));
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
  const result = await submitSupervisorCancellation({
    runId,
    actor,
    commandId,
    ...(values.reason === undefined ? {} : { reason: values.reason }),
    store: new LocalSupervisorStore(runsDirectory),
    config,
  });
  io.stdout(JSON.stringify(result, null, 2));
  return 0;
}

async function submitSupervisorCancellation(input: {
  readonly runId: string;
  readonly actor: string;
  readonly commandId: string;
  readonly reason?: string;
  readonly store: LocalSupervisorStore;
  readonly config: SupervisorPolicy;
}): Promise<SupervisorResult> {
  await ensureSupervisor(input.store, fileURLToPath(import.meta.url), input.config);
  const result = requireSupervisorSuccess(
    await requestSupervisor(input.store, {
      type: "cancel",
      policyDigest: input.config.policyDigest,
      commandId: input.commandId,
      runId: input.runId,
      actor: input.actor,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  );
  if (result.type !== "cancelled") {
    throw new SupervisorCommandError(
      "protocol_invalid",
      "supervisor returned a non-cancellation result",
    );
  }
  return result;
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
      io.stdout(JSON.stringify(projectPublicRunOutput(result), null, 2));
      return 0;
    }
    for (const event of result.events) {
      io.stdout(JSON.stringify(projectPublicRunOutput(event)));
    }
    cursor = result.cursor;
    if (result.terminal) {
      return 0;
    }
    await delay(100);
  }
}

async function acpCommand(
  args: readonly string[],
  overrides: Partial<CliDependencies>,
): Promise<number> {
  const { positionals, values } = parseCommandArgs(args, {
    actor: { type: "string" },
    "runs-dir": { type: "string" },
  });
  if (positionals.length !== 0) {
    throw new CliUsageError("acp does not accept positional arguments");
  }
  const actor = requireStringOption(values.actor, "acp requires --actor <label>");
  const dependencies = dependenciesFrom(overrides);
  let config: EffectiveFlowConfig;
  try {
    dependencies.signal?.throwIfAborted();
    config = await dependencies.loadConfig({ cwd: dependencies.cwd });
    dependencies.signal?.throwIfAborted();
  } catch {
    throw new FlowAcpBridgeSetupError();
  }
  let projectRoot: string;
  try {
    projectRoot = await realpath(config.projectRoot ?? dependencies.cwd);
  } catch {
    dependencies.signal?.throwIfAborted();
    throw new Error("Cannot start Flow ACP bridge: resolve project root");
  }
  dependencies.signal?.throwIfAborted();
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const runtime = createCliAcpRuntime({
    projectRoot,
    runsDirectory,
    config,
    dependencies,
    overrides,
  });
  const byteTransport = dependencies.createAcpByteTransport();
  const app = createFlowAcpAgent({
    sessionStore: new LocalAcpSessionStore(runsDirectory),
    projectRoot,
    policyDigest: config.policyDigest,
    actor,
    version: installedFlowVersion,
    createSessionId: randomUUID,
    createCancellationCommandId: deterministicAcpCancellationCommandId,
    now: () => new Date().toISOString(),
    runtime,
  });
  const protocolStream = createFlowAcpProtocolStream(createStrictAcpStream(byteTransport));
  const connection = app.connect(protocolStream);
  const signal = dependencies.signal;
  const closeForSignal = () => connection.close();
  if (signal?.aborted) {
    closeForSignal();
  } else {
    signal?.addEventListener("abort", closeForSignal, { once: true });
  }
  let connectionFailure: Error | undefined;
  try {
    await connection.closed;
  } catch {
    connectionFailure = new Error("Flow ACP connection failed");
  } finally {
    signal?.removeEventListener("abort", closeForSignal);
  }
  let protocolFailure: Error | undefined;
  let disposalFailure: Error | undefined;
  try {
    protocolFailure = await protocolStream.settle();
  } finally {
    try {
      byteTransport.dispose?.();
    } catch {
      disposalFailure = new Error("Cannot settle Flow ACP byte transport");
    }
  }
  signal?.throwIfAborted();
  if (protocolFailure !== undefined) {
    throw protocolFailure;
  }
  if (connectionFailure !== undefined) {
    throw connectionFailure;
  }
  if (disposalFailure !== undefined) {
    throw disposalFailure;
  }
  return 0;
}

function createCliAcpRuntime(input: {
  readonly projectRoot: string;
  readonly runsDirectory: string;
  readonly config: EffectiveFlowConfig;
  readonly dependencies: CliDependencies;
  readonly overrides: Partial<CliDependencies>;
}): FlowAcpAgentRuntime {
  const supervisorStore = new LocalSupervisorStore(input.runsDirectory);
  const runStore = input.dependencies.createStore(input.runsDirectory);
  const approvalChannel = input.dependencies.createAgentCommandApprovalChannel(input.runsDirectory);
  return {
    submit: async ({ sessionId, workflowSource, signal }) => {
      signal?.throwIfAborted();
      let exitCode: number;
      try {
        exitCode = await runCommand(
          [
            workflowSource,
            "--detach",
            "--command-id",
            sessionId,
            "--run-id",
            sessionId,
            "--runs-dir",
            input.runsDirectory,
            "--cwd",
            input.projectRoot,
          ],
          { stdout: () => undefined, stderr: () => undefined },
          {
            ...input.overrides,
            cwd: input.projectRoot,
            loadConfig: async () => input.config,
            ...(signal === undefined ? {} : { signal }),
          },
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (
          !(await isCompletedAcpSubmission({
            store: supervisorStore,
            sessionId,
            workflowSource,
            projectRoot: input.projectRoot,
            policy: input.config,
            ...(signal === undefined ? {} : { signal }),
          }))
        ) {
          throw error;
        }
        return;
      }
      signal?.throwIfAborted();
      if (exitCode !== 0) {
        throw new Error("Cannot submit Flow run through ACP");
      }
    },
    replay: async ({ sessionId, render, signal }) => {
      signal?.throwIfAborted();
      if (runStore.exists !== undefined && !(await runStore.exists(sessionId))) {
        signal?.throwIfAborted();
        return;
      }
      let events: readonly RunEvent[];
      try {
        events = await runStore.read(sessionId);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof RunStoreError && error.code === "not_found") {
          return;
        }
        throw error;
      }
      signal?.throwIfAborted();
      await render(projectRunPresentation(projectPublicRunOutput(reduceRunEvents(events))));
      signal?.throwIfAborted();
    },
    observe: async ({ sessionId, awaitRunStart, render, signal }) => {
      signal?.throwIfAborted();
      await ensureSupervisor(supervisorStore, fileURLToPath(import.meta.url), input.config);
      signal?.throwIfAborted();
      await runPresentationSession({
        runId: sessionId,
        source: createAcpPresentationSource({
          supervisorStore,
          policyDigest: input.config.policyDigest,
          awaitRunStart,
          ...(signal === undefined ? {} : { signal }),
        }),
        renderer: { render, close: async () => undefined },
        waitForMore: async (waitSignal) => {
          await delay(
            100,
            undefined,
            waitSignal === undefined ? undefined : { signal: waitSignal },
          );
        },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    decide: async (decision) =>
      await submitApprovalDecision({
        ...decision,
        store: runStore,
        sink: approvalChannel,
      }),
    cancel: async (cancellation) => {
      try {
        await supervisorStore.readCommand(cancellation.runId);
      } catch (error) {
        if (error instanceof LocalSupervisorStoreError && error.code === "not_found") {
          return;
        }
        throw error;
      }
      await submitSupervisorCancellation({
        ...cancellation,
        store: supervisorStore,
        config: input.config,
      });
    },
  };
}

function createAcpPresentationSource(input: {
  readonly supervisorStore: LocalSupervisorStore;
  readonly policyDigest: string;
  readonly awaitRunStart: boolean;
  readonly signal?: AbortSignal;
}): RunPresentationEventSource {
  let awaitingRunStart = input.awaitRunStart;
  const runStartDeadline = Date.now() + MAX_ACP_RUN_START_WAIT_MS;
  return {
    readPage: async (request) => {
      for (;;) {
        input.signal?.throwIfAborted();
        try {
          const result = requireSupervisorSuccess(
            await requestSupervisor(input.supervisorStore, {
              type: "events",
              policyDigest: input.policyDigest,
              runId: request.runId,
              afterSequence: request.afterSequence,
              limit: request.limit,
            }),
          );
          if (result.type !== "events") {
            throw new SupervisorCommandError(
              "protocol_invalid",
              "supervisor returned a non-event result",
            );
          }
          awaitingRunStart = false;
          return {
            type: result.type,
            events: result.events,
            cursor: result.cursor,
            terminal: result.terminal,
          };
        } catch (error) {
          input.signal?.throwIfAborted();
          if (
            !awaitingRunStart ||
            !(error instanceof SupervisorCommandError) ||
            error.code !== "not_found" ||
            Date.now() >= runStartDeadline
          ) {
            throw error;
          }
          await delay(
            100,
            undefined,
            input.signal === undefined ? undefined : { signal: input.signal },
          );
        }
      }
    },
  };
}

async function isCompletedAcpSubmission(input: {
  readonly store: LocalSupervisorStore;
  readonly sessionId: string;
  readonly workflowSource: string;
  readonly projectRoot: string;
  readonly policy: EffectiveFlowConfig;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  let command: Awaited<ReturnType<LocalSupervisorStore["readCommand"]>>;
  try {
    command = await input.store.readCommand(input.sessionId);
  } catch {
    input.signal?.throwIfAborted();
    return false;
  }
  input.signal?.throwIfAborted();
  const locator =
    parseWorkflowPackageLocator(input.workflowSource) ??
    parsePromptActivationLocator(input.workflowSource);
  const sourceName =
    locator === null ? resolve(input.projectRoot, input.workflowSource) : input.workflowSource;
  return (
    command.type === "submit" &&
    command.status === "completed" &&
    command.commandId === input.sessionId &&
    command.runId === input.sessionId &&
    command.mode === "run" &&
    command.policyDigest === input.policy.policyDigest &&
    command.sourceName === sourceName &&
    command.cwd === input.projectRoot &&
    (command.projectRoot ?? null) === input.policy.projectRoot
  );
}

function deterministicAcpCancellationCommandId(sessionId: string): string {
  const bytes = createHash("sha256")
    .update("flow-acp-cancellation-v1\0")
    .update(sessionId)
    .digest();
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("Cannot create Flow ACP cancellation identity");
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function tuiCommand(
  args: readonly string[],
  overrides: Partial<CliDependencies>,
): Promise<number> {
  assertStringOptionAtMostOnce(args, "presentation");
  const { positionals, values } = parseCommandArgs(args, {
    actor: { type: "string" },
    presentation: { type: "string" },
    "runs-dir": { type: "string" },
  });
  const runId = requireSinglePositional(positionals, "tui requires one run id");
  const actor = requireStringOption(values.actor, "tui requires --actor <label>");
  const isInteractive = overrides.isInteractiveTerminal ?? isProcessTerminalInteractive;
  if (!isInteractive()) {
    throw new CliUsageError("tui requires an interactive input and output terminal");
  }

  const dependencies = dependenciesFrom(overrides);
  const exitController = new AbortController();
  const signal =
    dependencies.signal === undefined
      ? exitController.signal
      : AbortSignal.any([dependencies.signal, exitController.signal]);
  signal.throwIfAborted();
  const config = await dependencies.loadConfig({ cwd: dependencies.cwd });
  signal.throwIfAborted();
  const selectedPresentation =
    values.presentation === undefined
      ? undefined
      : await snapshotSelectedPresentationPackage(
          await discoverConfiguredPresentationPackages(config, signal),
          parsePresentationPackageReference(values.presentation),
          { signal },
        );
  signal.throwIfAborted();
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const supervisorStore = new LocalSupervisorStore(runsDirectory);
  await ensureSupervisor(supervisorStore, fileURLToPath(import.meta.url), config);
  signal.throwIfAborted();
  const runStore = dependencies.createStore(runsDirectory);
  const approvalChannel = dependencies.createAgentCommandApprovalChannel(runsDirectory);
  const control: RunPresentationControl = {
    decide: async (input) =>
      await submitApprovalDecision({ ...input, store: runStore, sink: approvalChannel }),
    cancel: async (input) =>
      await submitSupervisorCancellation({
        ...input,
        store: supervisorStore,
        config,
      }),
  };
  const actionController = new RunPresentationActionController({
    runId,
    actor,
    control,
    createCommandId: randomUUID,
    signal,
  });
  let actionTail: Promise<void> = Promise.resolve();
  let exitRequested = false;
  const requestExit = () => {
    if (exitRequested) {
      return;
    }
    exitRequested = true;
    void actionTail.then(() => exitController.abort(new TuiExitRequested()));
  };
  const renderer = dependencies.createTerminalPresentationRenderer({
    onAction: (actionId) => {
      if (exitRequested) {
        return Promise.reject(new TuiExitRequested());
      }
      const operation = actionController.execute(actionId).then((result) => {
        if (isQueuedCancellationResult(result)) {
          requestExit();
        }
      });
      actionTail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    onExit: requestExit,
  });
  const sessionRenderer: RunPresentationRenderer = {
    render: async (document) => {
      const projected =
        selectedPresentation === undefined
          ? document
          : applyPresentationPackage(document, selectedPresentation);
      actionController.update(projected);
      await renderer.render(projected);
    },
    close: async () => {
      await actionTail;
      await renderer.close();
    },
  };
  const source: RunPresentationEventSource = {
    readPage: async (input) => {
      const result = requireSupervisorSuccess(
        await requestSupervisor(supervisorStore, {
          type: "events",
          policyDigest: config.policyDigest,
          runId: input.runId,
          afterSequence: input.afterSequence,
          limit: input.limit,
        }),
      );
      if (result.type !== "events") {
        throw new SupervisorCommandError(
          "protocol_invalid",
          "supervisor returned a non-event result",
        );
      }
      return {
        type: result.type,
        events: result.events,
        cursor: result.cursor,
        terminal: result.terminal,
      };
    },
  };

  renderer.start();
  let hasSessionError = false;
  let sessionError: unknown;
  let state: Awaited<ReturnType<typeof runPresentationSession>> | undefined;
  try {
    state = await runPresentationSession({
      runId,
      source,
      renderer: sessionRenderer,
      waitForMore: async (waitSignal) => {
        await delay(100, undefined, waitSignal === undefined ? undefined : { signal: waitSignal });
      },
      signal,
    });
  } catch (error) {
    hasSessionError = true;
    sessionError = error;
  }

  await actionTail;
  if (hasSessionError) {
    if (sessionError instanceof TuiExitRequested) {
      return 0;
    }
    throw sessionError;
  }
  if (state === undefined) {
    throw new Error("Flow terminal presentation ended without run state");
  }
  return runStateExitCode(state.status);
}

async function webCommand(
  args: readonly string[],
  io: CliIo,
  overrides: Partial<CliDependencies>,
): Promise<number> {
  assertStringOptionAtMostOnce(args, "presentation");
  const { positionals, values } = parseCommandArgs(args, {
    actor: { type: "string" },
    presentation: { type: "string" },
    "runs-dir": { type: "string" },
  });
  const runId = requireSinglePositional(positionals, "web requires one run id");
  const actor = requireStringOption(values.actor, "web requires --actor <label>");
  const presentationReference =
    values.presentation === undefined
      ? undefined
      : parsePresentationPackageReference(values.presentation);
  const dependencies = dependenciesFrom(overrides);
  const config = await awaitWithCancellationPrecedence(
    () => dependencies.loadConfig({ cwd: dependencies.cwd }),
    dependencies.signal,
    "browser presentation was cancelled",
  );
  const selectedPresentation =
    presentationReference === undefined
      ? undefined
      : await snapshotSelectedPresentationPackage(
          await discoverConfiguredPresentationPackages(config, dependencies.signal),
          presentationReference,
          dependencies.signal === undefined ? {} : { signal: dependencies.signal },
        );
  dependencies.signal?.throwIfAborted();
  const runsDirectory = resolveRunsDirectory(dependencies.cwd, values["runs-dir"], config);
  const runStore = dependencies.createStore(runsDirectory);
  let initialEvents: readonly RunEvent[];
  try {
    initialEvents = await runStore.read(runId);
  } catch {
    dependencies.signal?.throwIfAborted();
    throw new Error("Cannot open Flow browser presentation: run is unavailable");
  }
  dependencies.signal?.throwIfAborted();
  if (initialEvents.length === 0) {
    throw new Error("Cannot open Flow browser presentation: run is unavailable");
  }
  const supervisorStore = new LocalSupervisorStore(runsDirectory);
  const approvalChannel = dependencies.createAgentCommandApprovalChannel(runsDirectory);
  const control: RunPresentationControl = {
    decide: async (input) =>
      await submitApprovalDecision({ ...input, store: runStore, sink: approvalChannel }),
    cancel: async (input) =>
      await submitSupervisorCancellation({ ...input, store: supervisorStore, config }),
  };
  const actionController = new RunPresentationActionController({
    runId,
    actor,
    control,
    createCommandId: randomUUID,
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
  await ensureSupervisor(supervisorStore, fileURLToPath(import.meta.url), config);
  dependencies.signal?.throwIfAborted();
  const host = dependencies.createBrowserPresentationHost({ actionController });
  let session: Awaited<ReturnType<BrowserPresentationHost["start"]>>;
  try {
    session = await host.start();
  } catch (startError) {
    try {
      await host.close();
    } catch (closeError) {
      throw new AggregateError(
        [startError, closeError],
        "Cannot open Flow browser presentation: startup and cleanup failed",
      );
    }
    throw startError;
  }
  io.stdout(session.url);
  const source: RunPresentationEventSource = {
    readPage: async (input) => {
      const result = requireSupervisorSuccess(
        await requestSupervisor(supervisorStore, {
          type: "events",
          policyDigest: config.policyDigest,
          runId: input.runId,
          afterSequence: input.afterSequence,
          limit: input.limit,
        }),
      );
      if (result.type !== "events") {
        throw new SupervisorCommandError(
          "protocol_invalid",
          "supervisor returned a non-event result",
        );
      }
      return {
        type: result.type,
        events: result.events,
        cursor: result.cursor,
        terminal: result.terminal,
      };
    },
  };
  const renderer: RunPresentationRenderer = {
    render: async (document) => {
      await host.render(
        selectedPresentation === undefined
          ? document
          : applyPresentationPackage(document, selectedPresentation),
      );
    },
    close: async () => await host.close(),
  };
  const state = await runPresentationSession({
    runId,
    source,
    renderer,
    waitForMore: async (waitSignal) => {
      await delay(100, undefined, waitSignal === undefined ? undefined : { signal: waitSignal });
    },
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
  return runStateExitCode(state.status);
}

function isQueuedCancellationResult(input: unknown): boolean {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  const result = input as Record<string, unknown>;
  return (
    result.type === "cancelled" &&
    result.phase === "queued" &&
    result.lastSequence === null &&
    result.runStatus === "cancelled"
  );
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
    "policy-package-digest": { type: "string" },
    "policy-digest": { type: "string" },
    "runs-dir": { type: "string" },
    "sandbox-profile": { type: "string" },
    "startup-owner-token": { type: "string" },
    "startup-token": { type: "string" },
  });
  if (positionals.length !== 0) {
    throw new CliUsageError("internal supervisor accepts no positional arguments");
  }
  const storageDependencies = storageDependenciesFrom(overrides);
  const runsDirectory = resolve(storageDependencies.cwd, values["runs-dir"] ?? ".flow/runs");
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
  const policyPackageDigest = values["policy-package-digest"];
  if (policyPackageDigest !== undefined && !/^[a-f0-9]{64}$/.test(policyPackageDigest)) {
    throw new CliUsageError("--policy-package-digest requires a SHA-256 hexadecimal digest");
  }
  if (calculateFlowPolicyDigest(supervisor, sandboxProfile, policyPackageDigest) !== policyDigest) {
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
  const runtimeDependencies = dependenciesFrom(overrides);
  await runtimeDependencies.runSupervisorDaemon({
    store: new LocalSupervisorStore(runsDirectory),
    cliPath: fileURLToPath(import.meta.url),
    startupOwnerToken,
    startupToken,
    policy: {
      policyDigest,
      ...(policyPackageDigest === undefined ? {} : { policyPackageDigest }),
      sandbox: { profile: sandboxProfile },
      supervisor,
    },
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

function assertStringOptionAtMostOnce(args: readonly string[], option: string): void {
  const flag = `--${option}`;
  const occurrences = args.filter(
    (argument) => argument === flag || argument.startsWith(`${flag}=`),
  ).length;
  if (occurrences > 1) {
    throw new CliUsageError(`${flag} may be specified only once`);
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

function parseSupplementalMemoryGenerationOperation(value: string | undefined): "add" | "replace" {
  if (value !== "add" && value !== "replace") {
    throw new CliUsageError("--memory-operation requires add or replace");
  }
  return value;
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
  admittedSnapshot?: CapabilitySnapshot,
): Promise<CapabilitySnapshot | undefined> {
  const admittedSkills = new Set(
    (admittedSnapshot?.packages ?? [])
      .filter((item) => item.kind === "agent-skill")
      .map((item) => item.name),
  );
  const admittedVerifiers = new Set(
    (admittedSnapshot?.packages ?? [])
      .filter((item) => item.kind === "verifier-package")
      .map((item) => `${item.name}\0${item.version}`),
  );
  const admittedTools = new Set(
    (admittedSnapshot?.packages ?? [])
      .filter((item) => item.kind === "tool-package")
      .map((item) => `${item.name}\0${item.version}`),
  );
  const names = collectWorkflowAgentSkillNames(workflow).filter(
    (name) => !admittedSkills.has(name),
  );
  const verifierReferences = collectWorkflowVerifierPackageReferences(workflow).filter(
    (reference) => !admittedVerifiers.has(`${reference.name}\0${reference.version}`),
  );
  const toolReferences = collectWorkflowToolPackageReferences(workflow).filter(
    (reference) => !admittedTools.has(`${reference.name}\0${reference.version}`),
  );
  if (names.length === 0 && verifierReferences.length === 0 && toolReferences.length === 0) {
    return config.policyPackages?.snapshot;
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
  const catalogs = await discoverProjectCapabilityCatalogs(config.projectRoot, {
    includePolicies: false,
  });
  const snapshots: CapabilitySnapshot[] = [
    ...(config.policyPackages === undefined ? [] : [config.policyPackages.snapshot]),
  ];
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
    catalogPromise ??= discoverProjectCapabilityCatalogs(config.projectRoot, {
      includePolicies: false,
    }).then((catalogs) => catalogs.workflows);
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
    const effective = await loadEffectiveHarness(config.projectRoot, activationLocator.workflowId);
    if (effective !== null) {
      const source = effectiveHarnessWorkflowSource(effective.state);
      const sourceName = `activation:${activationLocator.workflowId}`;
      const capabilitySnapshot = createEffectiveHarnessCapabilitySnapshot(
        effective.state,
        effective.head,
      );
      return Object.freeze({
        source,
        sourceName,
        capabilitySnapshot,
        workflow: compileEffectiveHarnessState(effective.state),
      });
    }
    const loaded = await new LocalPromptActivationStore(config.projectRoot).loadActive(
      activationLocator.workflowId,
    );
    const source = adaptiveActivationSource(loaded.snapshot);
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
    const effectiveHarness = capabilitySnapshot?.effectiveHarness;
    if (effectiveHarness !== undefined && capabilitySnapshot !== undefined) {
      if (effectiveHarness.workflowId !== activationLocator.workflowId) {
        throw new RunRecoveryError(
          "workflow_mismatch",
          `durable run history does not contain activation "${activationLocator.workflowId}"`,
        );
      }
      const state = restoreEffectiveHarnessRuntimeState(
        effectiveHarness,
        capabilitySnapshot.packages,
      );
      sourceName = `activation:${activationLocator.workflowId}`;
      source = effectiveHarnessWorkflowSource(state);
      return Object.freeze({
        source,
        sourceName,
        workflow: compileEffectiveHarnessState(state),
      });
    }
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
    source = adaptiveActivationSource(selected);
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

async function loadCurrentEffectiveHarnessBaseline(
  workflowId: string,
  config: EffectiveFlowConfig,
  signal?: AbortSignal,
): Promise<{
  readonly state: EffectiveHarnessState;
  readonly head: EffectiveHarnessHeadIdentity;
}> {
  signal?.throwIfAborted();
  const projectRoot = config.projectRoot;
  if (projectRoot === null) {
    throw new EffectiveHarnessStoreError(
      "not_found",
      "effective harness composition requires a Flow project root",
    );
  }
  const effective = await loadEffectiveHarness(projectRoot, workflowId);
  signal?.throwIfAborted();
  if (effective !== null) return effective;

  const legacyStore = new LocalPromptActivationStore(projectRoot);
  const loaded = await legacyStore.loadActive(workflowId);
  signal?.throwIfAborted();
  const source = adaptiveActivationSource(loaded.snapshot);
  const sourceName = `activation:${workflowId}`;
  const workflow = compileWorkflowFromSnapshot({
    source,
    sourceName,
    capabilitySnapshot: loaded.capabilitySnapshot,
  });
  const supplemental = await resolveWorkflowCapabilitySnapshot(
    workflow,
    config,
    loaded.capabilitySnapshot,
  );
  signal?.throwIfAborted();
  return await loadEffectiveHarnessCandidateBaseline({
    scopeDigest: await calculateLocalEffectiveHarnessScopeDigest(projectRoot),
    workflowId,
    store: legacyStore,
    supplementalPackages: (supplemental?.packages ?? []).filter(
      (item) => item.kind !== "policy-package",
    ),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function loadEffectiveHarness(projectRoot: string, workflowId: string) {
  try {
    return await new LocalEffectiveHarnessStore(projectRoot).loadActive(workflowId);
  } catch (error) {
    if (error instanceof EffectiveHarnessStoreError && error.code === "not_found") return null;
    throw error;
  }
}

function combineOptionalCapabilitySnapshots(
  snapshots: readonly (CapabilitySnapshot | undefined)[],
): CapabilitySnapshot | undefined {
  return combineCapabilitySnapshots(
    snapshots.filter((snapshot): snapshot is CapabilitySnapshot => snapshot !== undefined),
  );
}

function assertCurrentPolicyPackageSnapshot(
  config: EffectiveFlowConfig,
  durableSnapshot: CapabilitySnapshot | undefined,
  runId: string,
): void {
  const current = (config.policyPackages?.snapshot.packages ?? [])
    .filter((item) => item.kind === "policy-package")
    .map((item) => `${item.name}\0${item.version}\0${item.digest}`);
  const durable = (durableSnapshot?.packages ?? [])
    .filter((item) => item.kind === "policy-package")
    .map((item) => `${item.name}\0${item.version}\0${item.digest}`);
  if (JSON.stringify(current) !== JSON.stringify(durable)) {
    throw new RunRecoveryError(
      "workflow_mismatch",
      `run "${runId}" policy package snapshot does not match current configuration`,
    );
  }
}

function selectPolicyPackageSnapshot(
  snapshot: CapabilitySnapshot | undefined,
): PolicyPackageCapabilitySnapshot | undefined {
  const packages = (snapshot?.packages ?? []).filter((item) => item.kind === "policy-package");
  if (packages.length === 0) {
    return undefined;
  }
  return validateCapabilitySnapshot({
    version: 1,
    packages,
    digest: calculateCapabilitySnapshotDigest(packages),
  }) as PolicyPackageCapabilitySnapshot;
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
  return (await discoverProjectCapabilityCatalogs(config.projectRoot, { includePolicies: false }))
    .agentSkills;
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
  return (await discoverProjectCapabilityCatalogs(config.projectRoot, { includePolicies: false }))
    .verifiers;
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
  return (await discoverProjectCapabilityCatalogs(config.projectRoot, { includePolicies: false }))
    .tools;
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
  return (await discoverProjectCapabilityCatalogs(config.projectRoot, { includePolicies: false }))
    .workflows;
}

async function discoverConfiguredPolicyPackages(
  config: EffectiveFlowConfig,
  signal: AbortSignal | undefined,
): Promise<ProjectPolicyPackageCatalog> {
  if (config.projectRoot === null) {
    throw new PolicyPackageCatalogError(
      "missing_package",
      "policy packages require a Flow project root containing .flow/policies",
    );
  }
  return (
    await discoverProjectCapabilityCatalogs(config.projectRoot, {
      includeNonPolicies: false,
      ...(signal === undefined ? {} : { signal }),
    })
  ).policies;
}

async function discoverConfiguredPresentationPackages(
  config: EffectiveFlowConfig,
  signal: AbortSignal | undefined,
): Promise<ProjectPresentationPackageCatalog> {
  if (config.projectRoot === null) {
    throw new PresentationPackageCatalogError(
      "missing_package",
      "presentation packages require a Flow project root",
    );
  }
  return (
    await discoverProjectCapabilityCatalogs(config.projectRoot, {
      includeNonPolicies: false,
      includePolicies: false,
      includePresentations: true,
      ...(signal === undefined ? {} : { signal }),
    })
  ).presentations;
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
    capabilityMetadataChannel:
      overrides.capabilityMetadataChannel ?? createProductionCapabilityMetadataChannel(),
    capabilityRepositoryFetcher:
      overrides.capabilityRepositoryFetcher ?? createProductionCapabilityRepositoryFetcher(),
    capabilityRepositoryWatcherNow: overrides.capabilityRepositoryWatcherNow ?? (() => new Date()),
    capabilityRepositoryWatcherWait:
      overrides.capabilityRepositoryWatcherWait ??
      (async (milliseconds, signal) => {
        await delay(milliseconds, undefined, { signal });
      }),
    ociCapabilityRegistry:
      overrides.ociCapabilityRegistry ?? createProductionOciCapabilityRegistry(),
    sigstoreCapabilityVerifier:
      overrides.sigstoreCapabilityVerifier ??
      new OfflineSigstoreCapabilityVerifier(createSigstorePublicGoodTrustedRoot()),
    readRegistrySecret: overrides.readRegistrySecret ?? readProcessRegistrySecret,
    externalHarnessRegistry,
    externalHarnessRuntime:
      overrides.externalHarnessRuntime ??
      createLazyProductionExternalHarnessRuntime(externalHarnessRegistry),
    runSupervisorDaemon: overrides.runSupervisorDaemon ?? runSupervisorDaemon,
    isInteractiveTerminal: overrides.isInteractiveTerminal ?? isProcessTerminalInteractive,
    createTerminalPresentationRenderer:
      overrides.createTerminalPresentationRenderer ?? createProcessFlowTerminalRenderer,
    createBrowserPresentationHost:
      overrides.createBrowserPresentationHost ??
      ((options) => new LocalBrowserPresentationHost(options)),
    createAcpByteTransport:
      overrides.createAcpByteTransport ??
      (() => ({
        input: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
        output: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        dispose: () => {
          process.stdin.destroy();
          process.stdout.destroy();
        },
      })),
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
): Pick<CliDependencies, "cwd" | "initializeProject" | "loadConfig" | "signal"> {
  const loadConfig = overrides.loadConfig ?? loadEffectiveFlowConfig;
  return {
    cwd: overrides.cwd ?? process.cwd(),
    initializeProject: overrides.initializeProject ?? initializeFlowProject,
    loadConfig: async (options = {}) =>
      await loadConfig({
        ...options,
        ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

function boundedCliDiagnostic(message: string): string {
  return message.length <= 8_192 ? message : `${message.slice(0, 8_192)}…`;
}

function publicCandidatePublisherMessage(code: LocalPromptCandidatePublisherError["code"]): string {
  switch (code) {
    case "cleanup_uncertain":
      return "candidate publication cleanup is uncertain";
    case "invalid_output":
      return "candidate output path is invalid";
    case "invalid_source":
      return "generated candidate is invalid";
    case "io":
      return "candidate publication failed";
    case "output_exists":
      return "candidate output already exists";
    case "publication_uncertain":
      return "candidate publication is uncertain after commit";
    case "temporary_limit":
      return "candidate publication temporary state exceeds its limit";
  }
}

function publicPolicyPackageCatalogMessage(code: PolicyPackageCatalogError["code"]): string {
  switch (code) {
    case "duplicate_package":
      return "policy package catalog contains a duplicate package";
    case "invalid_package":
      return "policy package catalog contains an invalid package";
    case "io":
      return "policy package catalog inspection failed";
    case "limit_exceeded":
      return "policy package catalog exceeds its limits";
    case "missing_package":
      return "required policy package is unavailable";
    case "source_changed":
      return "policy package source changed during capture";
    case "unsafe_entry":
      return "policy package catalog contains an unsafe entry";
    case "version_mismatch":
      return "policy package version does not match";
  }
}

function publicPresentationPackageCatalogMessage(
  code: PresentationPackageCatalogError["code"],
): string {
  switch (code) {
    case "duplicate_package":
      return "presentation package names conflict";
    case "invalid_package":
      return "presentation package is invalid";
    case "io":
      return "presentation package storage failed";
    case "limit_exceeded":
      return "presentation package limit exceeded";
    case "missing_package":
      return "presentation package is missing";
    case "source_changed":
      return "presentation package source changed";
    case "unsafe_entry":
      return "presentation package source is unsafe";
    case "version_mismatch":
      return "presentation package version does not match";
  }
}

function controlDependenciesFrom(
  overrides: Partial<CliDependencies>,
): Pick<
  CliDependencies,
  "cwd" | "createStore" | "createAgentCommandApprovalChannel" | "loadConfig" | "signal"
> {
  const loadConfig = overrides.loadConfig ?? loadEffectiveFlowConfig;
  return {
    ...storageDependenciesFrom(overrides),
    loadConfig: async (options = {}) =>
      await loadConfig({
        ...options,
        ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
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

async function resolveRecoveryRunsDirectory(
  invocationDirectory: string,
  explicitRunsDirectory: string | undefined,
): Promise<string> {
  if (explicitRunsDirectory !== undefined) {
    return resolve(invocationDirectory, explicitRunsDirectory);
  }
  const projectRoot = await locateFlowProjectRoot({ cwd: invocationDirectory });
  return resolve(projectRoot ?? invocationDirectory, ".flow/runs");
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

async function awaitWithCancellationPrecedence<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  throwIfAborted(signal, message);
  try {
    const result = await operation();
    throwIfAborted(signal, message);
    return result;
  } catch (error) {
    throwIfAborted(signal, message);
    throw error;
  }
}

class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

class TuiExitRequested extends Error {
  override readonly name = "TuiExitRequested";

  constructor() {
    super("Flow terminal presentation exit requested");
  }
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

class FlowAcpBridgeSetupError extends Error {
  override readonly name = "FlowAcpBridgeSetupError";

  constructor() {
    super("Cannot start Flow ACP bridge");
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
