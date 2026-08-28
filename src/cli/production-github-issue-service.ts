import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { cancelGitHubIssue } from "../application/cancel-github-issue.js";
import type { CommandSandbox } from "../application/command-sandbox.js";
import { replayIssueLifecycleState } from "../application/continue-github-issue.js";
import type {
  IssueControllerDependencies,
  IssueControllerRuntimeDependencies,
} from "../application/github-issue-controller-ports.js";
import type {
  GitHubIssueAdmissionPort,
  GitHubIssueLifecyclePort,
} from "../application/github-issue-ports.js";
import {
  admitIssueWorkflow,
  completeIssueWorkflowBudget,
  type IssueWorkflowModelBinding,
} from "../application/issue-workflow-admission.js";
import { mergeGitHubIssue } from "../application/merge-github-issue.js";
import type { NodeExecutor } from "../application/ports.js";
import { resumeGitHubIssue } from "../application/resume-github-issue.js";
import { runGitHubIssue } from "../application/run-github-issue.js";
import type { CapabilitySnapshot } from "../domain/capability/agent-skills.js";
import type { FlowSandboxProfile } from "../domain/config/resolver.js";
import { parseIssueLifecycleCommand } from "../domain/issue-lifecycle/commands.js";
import { projectPublicIssueLifecycleState } from "../domain/issue-lifecycle/events.js";
import { parseGitHubIssueUrl } from "../domain/issue-lifecycle/identity.js";
import { parseGitHubIssuePlanText } from "../domain/issue-lifecycle/plan.js";
import {
  type FrozenProjectFile,
  readFrozenProjectFile,
} from "../infrastructure/fs/frozen-project-file.js";
import { JsonlIssueLifecycleStore } from "../infrastructure/fs/jsonl-issue-lifecycle-store.js";
import { JsonlModelSessionStore } from "../infrastructure/fs/jsonl-model-session-store.js";
import { LocalArtifactStore } from "../infrastructure/fs/local-artifact-store.js";
import { ensureOwnedPrivateDirectory } from "../infrastructure/fs/owned-private-directory.js";
import {
  type GitHubIssueHostExecutables,
  resolveGitHubIssueHostExecutables,
} from "../infrastructure/git/fixed-host-executables.js";
import { LocalGitIssueEffects } from "../infrastructure/git/local-git-issue-effects.js";
import { LocalGitRepositoryAdmission } from "../infrastructure/git/local-git-repository-admission.js";
import { LocalIssueReviewEvidence } from "../infrastructure/git/local-issue-review-evidence.js";
import { LocalIssueVerification } from "../infrastructure/git/local-issue-verification.js";
import { GitHubCliGitCredentialBroker } from "../infrastructure/github/github-cli-git-credential-broker.js";
import { GitHubCliIssueLifecycleAdapter } from "../infrastructure/github/github-cli-issue-lifecycle-adapter.js";
import { IssueLifecycleHost } from "../infrastructure/github/issue-lifecycle-host.js";
import {
  ProductionIssueRunFreezer,
  ProductionIssueWorkflowRunner,
} from "../infrastructure/issue-lifecycle/production-issue-runner.js";
import { inspectPreparedPrimeRuntime } from "../infrastructure/oci/prime-environment-doctor.js";
import { inspectPiProviderConfiguration } from "../infrastructure/pi/pi-environment-doctor.js";
import { createProductionNodeEffectReconciler } from "../infrastructure/runtime/production-effect-reconciler.js";
import { inspectProductionNativeSandbox } from "../infrastructure/runtime/production-environment-doctor.js";
import {
  createProductionCommandSandbox,
  createProductionNodeExecutor,
} from "../infrastructure/runtime/production-node-executor.js";
import { createProductionWorkspaceIsolator } from "../infrastructure/runtime/production-workspace-isolator.js";
import type { GitHubIssueCliRequest, GitHubIssueCliService } from "./github-issue.js";

const SOURCE_FILE_LIMIT_BYTES = 1_048_576;
const READINESS_TIMEOUT_MS = 10_000;
const GIT_OPERATION_TIMEOUT_MS = 60_000;
const GITHUB_OPERATION_TIMEOUT_MS = 30_000;
const CONTROLLER_TIMEOUTS = Object.freeze([
  Object.freeze({ id: "git-read", timeoutMs: GIT_OPERATION_TIMEOUT_MS }),
  Object.freeze({ id: "github-read", timeoutMs: GITHUB_OPERATION_TIMEOUT_MS }),
  Object.freeze({ id: "git-write", timeoutMs: GIT_OPERATION_TIMEOUT_MS }),
  Object.freeze({ id: "github-write", timeoutMs: GITHUB_OPERATION_TIMEOUT_MS }),
]);
const VALIDATION_MODEL_BINDING = Object.freeze({
  provider: "controller",
  id: "operator-selected",
});

export interface ProductionGitHubIssueCliServiceOptions {
  readonly projectRoot: string;
  readonly sandboxProfile: FlowSandboxProfile;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly signal?: AbortSignal;
  readonly resolveExecutables?: typeof resolveGitHubIssueHostExecutables;
  readonly randomUuid?: () => string;
  readonly inspectProviderConfiguration?: typeof inspectPiProviderConfiguration;
  readonly inspectSandbox?: (
    profile: FlowSandboxProfile,
    projectRoot: string,
    signal: AbortSignal,
  ) => Promise<void>;
  /** @internal Replaces only nondeterministic host boundaries in process-backed integration tests. */
  readonly testOnly?: {
    readonly localRemotePath: string;
    readonly github: GitHubIssueAdmissionPort & GitHubIssueLifecyclePort;
    readonly executor: NodeExecutor;
    readonly commandSandbox: CommandSandbox;
  };
}

interface RuntimeAdapters {
  readonly runtimeDependencies: IssueControllerRuntimeDependencies;
  readonly githubAdmission: GitHubIssueAdmissionPort;
  readonly repositoryAdmission: LocalGitRepositoryAdmission;
}

/** Composes the public issue CLI with the strict production lifecycle adapters. */
export function createProductionGitHubIssueCliService(
  options: ProductionGitHubIssueCliServiceOptions,
): GitHubIssueCliService {
  return new ProductionGitHubIssueCliService(options);
}

class ProductionGitHubIssueCliService implements GitHubIssueCliService {
  readonly #artifactRoot: string;
  readonly #durableRoot: string;
  readonly #capabilitySnapshot: CapabilitySnapshot | undefined;
  readonly #hostRoot: string;
  readonly #inspectProviderConfiguration: typeof inspectPiProviderConfiguration;
  readonly #inspectSandbox: NonNullable<ProductionGitHubIssueCliServiceOptions["inspectSandbox"]>;
  readonly #projectRoot: string;
  readonly #randomUuid: () => string;
  readonly #resolveExecutables: typeof resolveGitHubIssueHostExecutables;
  readonly #sandboxProfile: FlowSandboxProfile;
  readonly #signal: AbortSignal | undefined;
  readonly #store: JsonlIssueLifecycleStore;
  readonly #testOnly: ProductionGitHubIssueCliServiceOptions["testOnly"];
  #runtimePromise: Promise<RuntimeAdapters> | undefined;

  constructor(options: ProductionGitHubIssueCliServiceOptions) {
    if (
      !isAbsolute(options.projectRoot) ||
      resolve(options.projectRoot) !== options.projectRoot ||
      options.projectRoot.includes("\0")
    ) {
      throw new Error("production issue service project root must be an absolute normalized path");
    }
    this.#projectRoot = realpathSync(options.projectRoot);
    this.#sandboxProfile = options.sandboxProfile;
    this.#capabilitySnapshot = options.capabilitySnapshot;
    this.#signal = options.signal;
    this.#resolveExecutables = options.resolveExecutables ?? resolveGitHubIssueHostExecutables;
    this.#randomUuid = options.randomUuid ?? randomUUID;
    this.#inspectProviderConfiguration =
      options.inspectProviderConfiguration ?? inspectPiProviderConfiguration;
    this.#inspectSandbox = options.inspectSandbox ?? inspectIssueSandbox;
    if (
      options.testOnly !== undefined &&
      (!isAbsolute(options.testOnly.localRemotePath) ||
        resolve(options.testOnly.localRemotePath) !== options.testOnly.localRemotePath ||
        options.testOnly.localRemotePath.includes("\0"))
    ) {
      throw new Error("test-only local Git remote must be an absolute normalized path");
    }
    this.#testOnly = options.testOnly;
    this.#durableRoot = join(this.#projectRoot, ".flow", "issue-runs");
    this.#artifactRoot = join(this.#durableRoot, "artifact-store");
    const projectIdentity = createHash("sha256")
      .update(this.#projectRoot)
      .digest("hex")
      .slice(0, 32);
    const userIdentity = process.getuid?.() ?? 0;
    this.#hostRoot = join(
      realpathSync(tmpdir()),
      `flow-issue-host-${userIdentity}`,
      projectIdentity,
    );
    this.#store = new JsonlIssueLifecycleStore(this.#durableRoot);
  }

  async execute(request: GitHubIssueCliRequest): Promise<unknown> {
    this.#signal?.throwIfAborted();
    switch (request.kind) {
      case "validate":
        return await this.#validate(request.planPath);
      case "doctor":
        return await this.#doctor(
          request.issueUrl,
          request.planPath,
          request.provider,
          request.model,
        );
      case "run": {
        await this.#validate(
          request.planPath,
          { provider: request.provider, id: request.model },
          "exact",
        );
        await this.#preflightExecution(request.provider, request.model);
        const planFile = await this.#readPlan(request.planPath);
        const issue = parseGitHubIssueUrl(request.issueUrl);
        const runtime = await this.#runtime();
        const dependencies: IssueControllerDependencies = Object.freeze({
          ...runtime.runtimeDependencies,
          freezer: this.#createFreezer(
            request.planPath,
            runtime.repositoryAdmission,
            runtime.githubAdmission,
          ),
        });
        return await runGitHubIssue(
          {
            version: 1,
            kind: "run",
            commandId: request.commandId,
            issueUrl: issue.canonicalUrl,
            repositoryIdentity: issue.repositoryIdentity,
            planDigest: planFile.file.sha256,
            provider: request.provider,
            model: request.model,
          },
          dependencies,
        );
      }
      case "inspect": {
        const [manifest, events] = await Promise.all([
          this.#store.readManifest(request.runId),
          this.#store.read(request.runId),
        ]);
        return projectPublicIssueLifecycleState(replayIssueLifecycleState(manifest, events));
      }
      case "events":
        return await this.#store.readPage({
          runId: request.runId,
          afterSequence: request.afterSequence,
          limit: request.limit,
        });
      case "resume": {
        const runtime = await this.#runtimeForExistingRun(request.runId, true);
        return await resumeGitHubIssue(
          { version: 1, kind: "resume", runId: request.runId, commandId: request.commandId },
          runtime.runtimeDependencies,
        );
      }
      case "cancel": {
        const runtime = await this.#runtimeForExistingRun(request.runId);
        return await cancelGitHubIssue(
          {
            version: 1,
            kind: "cancel",
            runId: request.runId,
            commandId: request.commandId,
            actor: request.actor,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          },
          runtime.runtimeDependencies,
        );
      }
      case "merge": {
        const runtime = await this.#runtimeForExistingRun(request.runId, true);
        return await mergeGitHubIssue(
          {
            version: 1,
            kind: "merge",
            runId: request.runId,
            commandId: request.commandId,
            actor: request.actor,
            expectedPullRequest: request.expectedPullRequest,
            expectedHead: request.expectedHead,
            expectedGateDigest: request.expectedGateDigest,
          },
          runtime.runtimeDependencies,
        );
      }
    }
  }

  async #validate(
    planPath: string,
    model: IssueWorkflowModelBinding = VALIDATION_MODEL_BINDING,
    policyModelBinding: "exact" | "deferred" = "deferred",
  ): Promise<unknown> {
    const { file: planFile, plan } = await this.#readPlan(planPath);
    const [implementationFile, reviewFile] = await Promise.all([
      this.#readSource(plan.implementation.workflow),
      this.#readSource(plan.review.workflow),
    ]);
    const implementation = admitIssueWorkflow({
      role: "implementation",
      source: decodeText(implementationFile),
      sourceName: plan.implementation.workflow,
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      model,
      policyModelBinding,
      context: { kind: "issue", content: validationIssueContext(plan.repository.expected) },
      allowedWritePrefixes: plan.candidate.allowedPathPrefixes,
    });
    completeIssueWorkflowBudget(implementation.workflow.budget, "implementation");
    const review = admitIssueWorkflow({
      role: "review",
      source: decodeText(reviewFile),
      sourceName: plan.review.workflow,
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      model,
      policyModelBinding,
      context: {
        kind: "review",
        content: validationReviewContext(
          plan.repository.expected,
          implementation.criteria.map((criterion) => criterion.id),
        ),
      },
      resultNodeId: plan.review.resultNode,
    });
    completeIssueWorkflowBudget(review.workflow.budget, "review");
    return Object.freeze({
      status: "valid",
      repositoryIdentity: plan.repository.expected,
      planDigest: planFile.sha256,
      implementationSourceDigest: implementationFile.sha256,
      reviewSourceDigest: reviewFile.sha256,
      acceptanceCriterionCount: implementation.criteria.length,
      verificationCommandCount: plan.verification.length,
      hostedCheckCount: plan.hostedChecks.required.length,
    });
  }

  async #doctor(
    issueUrl: string,
    planPath: string,
    provider: string,
    model: string,
  ): Promise<unknown> {
    await this.#validate(planPath, { provider, id: model }, "exact");
    await this.#preflightExecution(provider, model);
    const { file: planFile } = await this.#readPlan(planPath);
    const issue = parseGitHubIssueUrl(issueUrl);
    const executables = await this.#resolveExecutables({ projectRoot: this.#projectRoot });
    const github =
      this.#testOnly?.github ??
      new GitHubCliIssueLifecycleAdapter({
        ghExecutable: executables.gh,
        cwd: this.#projectRoot,
      });
    const freezer = new ProductionIssueRunFreezer({
      projectRoot: this.#projectRoot,
      planPath,
      controllerTimeouts: CONTROLLER_TIMEOUTS,
      repositoryAdmission: new LocalGitRepositoryAdmission({
        gitExecutable: executables.git,
        ...(this.#testOnly === undefined
          ? {}
          : { testOnlyLocalRemotePath: this.#testOnly.localRemotePath }),
      }),
      githubAdmission: github,
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
    });
    const command = parseIssueLifecycleCommand({
      version: 1,
      kind: "run",
      commandId: this.#randomUuid(),
      issueUrl: issue.canonicalUrl,
      repositoryIdentity: issue.repositoryIdentity,
      planDigest: planFile.sha256,
      provider,
      model,
    });
    if (command.kind !== "run") throw new Error("doctor run command admission failed");
    const frozen = await freezer.freeze(command, this.#operation());
    return Object.freeze({
      status: "ready",
      repositoryIdentity: frozen.manifest.repository.identity,
      issueNumber: frozen.manifest.issue.number,
      baseBranch: frozen.manifest.base.branch,
      baseCommit: frozen.manifest.base.commit,
      planDigest: frozen.manifest.planDigest,
      implementationTemplateWorkflowDigest:
        frozen.manifest.implementationWorkflow.templateWorkflowDigest,
      reviewTemplateWorkflowDigest: frozen.manifest.reviewWorkflow.templateWorkflowDigest,
      acceptanceCriterionCount: frozen.manifest.acceptanceCriteria.length,
      verificationCommandCount: frozen.manifest.verification.length,
      hostedCheckCount: frozen.manifest.hostedChecks.length,
    });
  }

  async #runtimeForExistingRun(
    runId: string,
    requireExecutionReadiness = false,
  ): Promise<RuntimeAdapters> {
    const manifest = await this.#store.readManifest(runId);
    if (requireExecutionReadiness) {
      await this.#preflightExecution(
        manifest.implementationWorkflow.model.provider,
        manifest.implementationWorkflow.model.id,
      );
    }
    return await this.#runtime();
  }

  async #preflightExecution(provider: string, model: string): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(READINESS_TIMEOUT_MS);
    const signal =
      this.#signal === undefined ? timeoutSignal : AbortSignal.any([this.#signal, timeoutSignal]);
    await this.#inspectProviderConfiguration([Object.freeze({ provider, model })], signal);
    signal.throwIfAborted();
    await this.#inspectSandbox(this.#sandboxProfile, this.#projectRoot, signal);
    signal.throwIfAborted();
  }

  async #runtime(): Promise<RuntimeAdapters> {
    if (this.#runtimePromise === undefined) {
      const pending = this.#createRuntime();
      this.#runtimePromise = pending;
      void pending.catch(() => {
        if (this.#runtimePromise === pending) this.#runtimePromise = undefined;
      });
    }
    return await this.#runtimePromise;
  }

  async #createRuntime(): Promise<RuntimeAdapters> {
    const hostCollection = resolve(this.#hostRoot, "..");
    await ensureOwnedPrivateDirectory(this.#durableRoot);
    await ensureOwnedPrivateDirectory(this.#artifactRoot);
    await ensureOwnedPrivateDirectory(hostCollection);
    await ensureOwnedPrivateDirectory(this.#hostRoot);
    await ensureOwnedPrivateDirectory(join(this.#hostRoot, "worktrees"));
    const executables = await this.#resolveExecutables({ projectRoot: this.#projectRoot });
    return this.#composeRuntime(executables);
  }

  #composeRuntime(executables: GitHubIssueHostExecutables): RuntimeAdapters {
    const localGit = new LocalGitIssueEffects({
      gitExecutable: executables.git,
      privateRoot: this.#hostRoot,
      timeoutMs: GIT_OPERATION_TIMEOUT_MS,
      credentialBroker: new GitHubCliGitCredentialBroker({ ghExecutable: executables.gh }),
      ...(this.#testOnly === undefined
        ? {}
        : { testOnlyLocalRemotePath: this.#testOnly.localRemotePath }),
    });
    const github =
      this.#testOnly?.github ??
      new GitHubCliIssueLifecycleAdapter({
        ghExecutable: executables.gh,
        cwd: this.#projectRoot,
        timeoutMs: GITHUB_OPERATION_TIMEOUT_MS,
      });
    const host = new IssueLifecycleHost({
      store: this.#store,
      localGit,
      github,
      sourceRoot: this.#projectRoot,
      workspaceParent: join(this.#hostRoot, "worktrees"),
    });
    const verification = new LocalIssueVerification({
      git: localGit,
      workspaceProvider: host,
      privateStore: this.#store,
      sandbox:
        this.#testOnly?.commandSandbox ??
        createProductionCommandSandbox(this.#sandboxProfile, this.#projectRoot),
    });
    const reviewEvidence = new LocalIssueReviewEvidence({
      git: localGit,
      gitExecutable: executables.git,
      privateStore: this.#store,
      verification,
    });
    const workflows = new ProductionIssueWorkflowRunner({
      nestedRunRoot: join(this.#durableRoot, "nested-runs"),
      lifecycleStore: this.#store,
      workspaces: host,
      git: localGit,
      reviewEvidence,
      executor:
        this.#testOnly?.executor ??
        createProductionNodeExecutor(this.#sandboxProfile, this.#projectRoot),
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
      modelSessionStore: new JsonlModelSessionStore(join(this.#durableRoot, "model-sessions")),
      artifactStore: new LocalArtifactStore(this.#artifactRoot),
      effectReconciler: createProductionNodeEffectReconciler(),
      workspaceIsolator: createProductionWorkspaceIsolator(
        join(this.#durableRoot, "nested-runs"),
        [],
        this.#hostRoot,
        this.#hostRoot,
      ),
    });
    const runtimeDependencies: IssueControllerRuntimeDependencies = Object.freeze({
      repository: this.#store,
      workflows,
      verification,
      github: host,
      effects: host,
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
    });
    const repositoryAdmission = new LocalGitRepositoryAdmission({
      gitExecutable: executables.git,
      ...(this.#testOnly === undefined
        ? {}
        : { testOnlyLocalRemotePath: this.#testOnly.localRemotePath }),
    });
    return Object.freeze({
      runtimeDependencies,
      githubAdmission: github,
      repositoryAdmission,
    });
  }

  #createFreezer(
    planPath: string,
    repositoryAdmission: LocalGitRepositoryAdmission,
    githubAdmission: GitHubIssueAdmissionPort,
  ): ProductionIssueRunFreezer {
    return new ProductionIssueRunFreezer({
      projectRoot: this.#projectRoot,
      planPath,
      controllerTimeouts: CONTROLLER_TIMEOUTS,
      repositoryAdmission,
      githubAdmission,
      ...(this.#capabilitySnapshot === undefined
        ? {}
        : { capabilitySnapshot: this.#capabilitySnapshot }),
    });
  }

  async #readPlan(planPath: string): Promise<{
    readonly file: FrozenProjectFile;
    readonly plan: ReturnType<typeof parseGitHubIssuePlanText>;
  }> {
    const file = await this.#readSource(planPath);
    return Object.freeze({ file, plan: parseGitHubIssuePlanText(decodeText(file), planPath) });
  }

  async #readSource(path: string): Promise<FrozenProjectFile> {
    return await readFrozenProjectFile({
      projectRoot: this.#projectRoot,
      path,
      maxBytes: SOURCE_FILE_LIMIT_BYTES,
    });
  }

  #operation() {
    return {
      ...(this.#signal === undefined ? {} : { signal: this.#signal }),
      pollCancellation: async () => this.#signal?.throwIfAborted(),
    };
  }
}

async function inspectIssueSandbox(
  profile: FlowSandboxProfile,
  projectRoot: string,
  signal: AbortSignal,
): Promise<void> {
  if (profile === "native") {
    await inspectProductionNativeSandbox(projectRoot, signal);
    return;
  }
  await inspectPreparedPrimeRuntime(projectRoot, signal);
}

function decodeText(file: FrozenProjectFile): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(file.contentBase64, "base64"),
  );
}

function validationIssueContext(repositoryIdentity: string): string {
  return JSON.stringify({
    version: 1,
    purpose: "validate-implementation-template",
    repositoryIdentity,
  });
}

function validationReviewContext(
  repositoryIdentity: string,
  acceptanceCriteria: readonly string[],
): string {
  return JSON.stringify({
    version: 1,
    purpose: "validate-review-template",
    repositoryIdentity,
    acceptanceCriteria,
  });
}
