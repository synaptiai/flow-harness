import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentSkillCandidateIdentity } from "../../domain/adaptation/agent-skill-candidate.js";
import type { AgentSkillPackageCandidateIdentity } from "../../domain/adaptation/agent-skill-package-candidate.js";
import type { ChildSpecialistCandidateIdentity } from "../../domain/adaptation/child-specialist-candidate.js";
import type { EffectiveHarnessCandidateSurface } from "../../domain/adaptation/effective-harness-candidate.js";
import {
  compileEffectiveHarnessState,
  type EffectiveHarnessState,
  effectiveHarnessWorkflowSource,
} from "../../domain/adaptation/effective-harness-state.js";
import type { ModelRoutingCandidateIdentity } from "../../domain/adaptation/model-routing-candidate.js";
import type { PromptCandidateIdentity } from "../../domain/adaptation/prompt-candidate.js";
import type { SupplementalMemoryCandidateIdentity } from "../../domain/adaptation/supplemental-memory-candidate.js";
import type {
  AgentSkillCapabilitySnapshot,
  CapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import {
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../domain/capability/agent-skills.js";
import { bindWorkflowCapabilities } from "../../domain/capability/workflow-capabilities.js";
import {
  type ExternalHarnessIdentity,
  parseExternalHarnessIdentity,
} from "../../domain/evaluation/external-harness.js";
import {
  calculateEvaluationPlanDigest,
  calculateEvaluationVerifierDigest,
  createEvaluationSchedule,
  type EvaluationFilesystemAssertion,
  type EvaluationPlanSource,
  type EvaluationProfileSource,
  type EvaluationTrialScheduleItem,
  MAX_EVALUATION_INSTRUCTION_BYTES,
  MAX_EVALUATION_PLAN_BYTES,
  parseEvaluationPlanText,
} from "../../domain/evaluation/plan.js";
import { compileWorkflowText } from "../../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../domain/workflow/digest.js";
import type { CompiledRunBudget, CompiledWorkflow } from "../../domain/workflow/types.js";
import { admitLocalAdaptationCandidate } from "./local-adaptation-candidate.js";
import { admitLocalEffectiveHarnessCandidate } from "./local-effective-harness-candidate.js";

export const MAX_EVALUATION_FIXTURE_ENTRIES = 4_096;
export const MAX_EVALUATION_FIXTURE_BYTES = 256 * 1024 * 1024;
export const MAX_EVALUATION_WORKFLOW_BYTES = 1_048_576;
export { MAX_EVALUATION_INSTRUCTION_BYTES } from "../../domain/evaluation/plan.js";

export type EvaluationAdmissionErrorCode =
  | "invalid_path"
  | "invalid_source"
  | "invalid_workflow"
  | "limit_exceeded"
  | "source_changed"
  | "unsupported_entry";

export class EvaluationAdmissionError extends Error {
  override readonly name = "EvaluationAdmissionError";

  constructor(
    readonly code: EvaluationAdmissionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export interface EvaluationFixtureSnapshot {
  readonly digest: string;
  readonly entryCount: number;
  readonly logicalBytes: number;
  readonly instructionPath: string;
  readonly instructionSha256: string;
}

export interface AdmittedEvaluationTask {
  readonly id: string;
  readonly partition: "tuning" | "regression" | "holdout";
  readonly fixture: EvaluationFixtureSnapshot & {
    readonly sourceCwd: string;
    readonly provenance: string;
  };
  readonly verifier: {
    readonly kind: "filesystem-v1";
    readonly digest: string;
    readonly assertions: readonly EvaluationFilesystemAssertion[];
  };
}

export interface AdmittedFlowEvaluationProfile {
  readonly id: string;
  readonly adapter: "flow-workflow-v1";
  readonly workflow: {
    readonly sourceKind:
      | "file"
      | "prompt-candidate-projection"
      | "agent-skill-candidate-projection"
      | "agent-skill-package-candidate-projection"
      | "effective-harness-baseline"
      | "effective-harness-candidate-projection";
    readonly sourcePath: string | null;
    readonly provenance: string;
    readonly source: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
    readonly compiled: CompiledWorkflow;
  };
  readonly candidate?: (
    | PromptCandidateIdentity
    | AgentSkillCandidateIdentity
    | AgentSkillPackageCandidateIdentity
    | ModelRoutingCandidateIdentity
    | ChildSpecialistCandidateIdentity
    | SupplementalMemoryCandidateIdentity
  ) & {
    readonly selectionProvenance: string;
  };
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly baselineCapabilitySnapshot?: AgentSkillCapabilitySnapshot;
  readonly effectiveHarness?: {
    readonly selection: "baseline" | "candidate";
    readonly artifactDigest: string;
    readonly stateDigest: string;
    readonly baselineHeadDigest: string;
    readonly workflowSha256: string;
    readonly workflowDigest: string;
    readonly packageDigests: readonly string[];
    readonly surface: EffectiveHarnessCandidateSurface;
    readonly candidateDigest: string;
  };
  readonly effectiveHarnessState?: EffectiveHarnessState;
}

export type AdmittedExternalEvaluationProfile = {
  [Adapter in ExternalHarnessIdentity["adapter"]]: {
    readonly id: string;
    readonly adapter: Adapter;
    readonly harness: Extract<ExternalHarnessIdentity, { readonly adapter: Adapter }>;
  };
}[ExternalHarnessIdentity["adapter"]];

export type AdmittedEvaluationProfile =
  | AdmittedFlowEvaluationProfile
  | AdmittedExternalEvaluationProfile;

export interface AdmittedEvaluationPlan {
  readonly apiVersion: EvaluationPlanSource["apiVersion"];
  readonly id: string;
  readonly planDigest: string;
  readonly sourcePath: string;
  readonly suite: {
    readonly id: string;
    readonly version: string;
    readonly tasks: readonly AdmittedEvaluationTask[];
  };
  readonly profiles: readonly [AdmittedEvaluationProfile, AdmittedEvaluationProfile];
  readonly controls: EvaluationPlanSource["controls"];
  readonly seeds: readonly number[];
  readonly order: EvaluationPlanSource["order"];
  readonly comparison: EvaluationPlanSource["comparison"];
  readonly schedule: readonly EvaluationTrialScheduleItem[];
}

export function projectEvaluationCandidateIdentity(
  candidate: NonNullable<AdmittedFlowEvaluationProfile["candidate"]>,
): {
  readonly provenance: string;
  readonly identity:
    | PromptCandidateIdentity
    | AgentSkillCandidateIdentity
    | AgentSkillPackageCandidateIdentity
    | ModelRoutingCandidateIdentity
    | ChildSpecialistCandidateIdentity
    | SupplementalMemoryCandidateIdentity;
} {
  const { selectionProvenance, ...identity } = candidate;
  return Object.freeze({ provenance: selectionProvenance, identity: Object.freeze(identity) });
}

interface FixtureScanState {
  entryCount: number;
  logicalBytes: number;
  readonly digest: ReturnType<typeof createHash>;
  readonly files: Map<string, { readonly sha256: string; readonly size: number }>;
}

export interface StableEvaluationFile {
  readonly content: Buffer;
  readonly sha256: string;
}

type ExternalProfileSource = Exclude<
  EvaluationProfileSource,
  { readonly adapter: "flow-workflow-v1" }
>;

export interface LocalEvaluationPlanDependencies {
  readonly resolveExternalHarnessIdentity: (
    profile: ExternalProfileSource,
  ) => Promise<ExternalHarnessIdentity>;
  readonly signal?: AbortSignal;
  /** @internal Deterministic nested-candidate cancellation seam. */
  readonly afterCandidatePathValidation?: (provenance: string) => void | Promise<void>;
}

export async function admitLocalEvaluationPlan(
  planPath: string,
  dependencies?: Partial<LocalEvaluationPlanDependencies>,
): Promise<AdmittedEvaluationPlan> {
  dependencies?.signal?.throwIfAborted();
  const absolutePlanPath = resolve(planPath);
  const planRoot = await realpath(dirname(absolutePlanPath));
  dependencies?.signal?.throwIfAborted();
  const canonicalPlanPath = join(planRoot, basename(absolutePlanPath));
  const planFile = await stableReadEvaluationFile(
    canonicalPlanPath,
    MAX_EVALUATION_PLAN_BYTES,
    "evaluation plan",
  );
  dependencies?.signal?.throwIfAborted();
  const source = parseEvaluationPlanText(planFile.content.toString("utf8"), basename(planPath));

  const tasks = await Promise.all(
    source.suite.tasks.map(async (task): Promise<AdmittedEvaluationTask> => {
      const fixturePath = await resolveAdmittedEvaluationPath(planRoot, task.fixture, "directory");
      const snapshot = await observeEvaluationFixture(fixturePath, task.instruction);
      const verifierDigest = calculateEvaluationVerifierDigest(
        task.verifier.kind,
        task.verifier.assertions,
      );
      return Object.freeze({
        id: task.id,
        partition: task.partition,
        fixture: Object.freeze({
          sourceCwd: fixturePath,
          provenance: task.fixture,
          ...snapshot,
        }),
        verifier: Object.freeze({
          kind: task.verifier.kind,
          digest: verifierDigest,
          assertions: task.verifier.assertions,
        }),
      });
    }),
  );
  dependencies?.signal?.throwIfAborted();

  const admittedProfiles = await Promise.all(
    source.profiles.map(async (profile): Promise<AdmittedEvaluationProfile> => {
      dependencies?.signal?.throwIfAborted();
      if (profile.adapter !== "flow-workflow-v1") {
        const resolver = dependencies?.resolveExternalHarnessIdentity;
        if (resolver === undefined) {
          throw new EvaluationAdmissionError(
            "invalid_workflow",
            `profile "${profile.id}" requires a trusted external harness registry`,
          );
        }
        let harness: ExternalHarnessIdentity;
        try {
          harness = parseExternalHarnessIdentity(await resolver(profile));
          dependencies?.signal?.throwIfAborted();
        } catch (error) {
          dependencies?.signal?.throwIfAborted();
          throw new EvaluationAdmissionError(
            "invalid_workflow",
            `profile "${profile.id}" external harness identity is invalid: ${boundedMessage(error)}`,
            { cause: error },
          );
        }
        if (
          harness.adapter !== profile.adapter ||
          harness.harness.config !== profile.harness.config
        ) {
          throw new EvaluationAdmissionError(
            "invalid_workflow",
            `profile "${profile.id}" external harness identity contradicts its source selection`,
          );
        }
        if (harness.adapter === "pi-native-v1") {
          return Object.freeze({ id: profile.id, adapter: harness.adapter, harness });
        }
        if (harness.adapter === "omp-native-v1") {
          return Object.freeze({ id: profile.id, adapter: harness.adapter, harness });
        }
        return Object.freeze({ id: profile.id, adapter: harness.adapter, harness });
      }
      if ("workflow" in profile) {
        const workflowPath = await resolveAdmittedEvaluationPath(
          planRoot,
          profile.workflow,
          "file",
        );
        dependencies?.signal?.throwIfAborted();
        const workflowFile = await stableReadEvaluationFile(
          workflowPath,
          MAX_EVALUATION_WORKFLOW_BYTES,
          `workflow "${profile.id}"`,
        );
        dependencies?.signal?.throwIfAborted();
        const workflowSource = workflowFile.content.toString("utf8");
        let compiled: CompiledWorkflow;
        try {
          compiled = compileWorkflowText(workflowSource, profile.workflow);
        } catch (error) {
          dependencies?.signal?.throwIfAborted();
          throw new EvaluationAdmissionError(
            "invalid_workflow",
            `profile "${profile.id}" workflow cannot be compiled: ${boundedMessage(error)}`,
            { cause: error },
          );
        }
        assertEvaluationWorkflowControls(profile.id, compiled, source.controls);
        return Object.freeze({
          id: profile.id,
          adapter: profile.adapter,
          workflow: Object.freeze({
            sourceKind: "file" as const,
            sourcePath: workflowPath,
            provenance: profile.workflow,
            source: workflowSource,
            sourceSha256: workflowFile.sha256,
            workflowDigest: calculateWorkflowDigest(compiled),
            compiled,
          }),
        });
      }

      if ("effectiveCandidate" in profile) {
        const candidatePath = await resolveAdmittedEvaluationPath(
          planRoot,
          profile.effectiveCandidate,
          "file",
        );
        dependencies?.signal?.throwIfAborted();
        let admitted: Awaited<ReturnType<typeof admitLocalEffectiveHarnessCandidate>>;
        try {
          admitted = await admitLocalEffectiveHarnessCandidate(candidatePath, {
            ...(dependencies?.signal === undefined ? {} : { signal: dependencies.signal }),
          });
        } catch (error) {
          dependencies?.signal?.throwIfAborted();
          throw new EvaluationAdmissionError(
            "invalid_workflow",
            `profile "${profile.id}" effective harness candidate cannot be admitted`,
            { cause: error },
          );
        }
        dependencies?.signal?.throwIfAborted();
        const artifact = admitted.artifact;
        const state =
          profile.selection === "baseline" ? artifact.baselineState : artifact.candidateState;
        const workflowSource = effectiveHarnessWorkflowSource(state);
        const compiled = compileEffectiveHarnessState(state);
        assertEvaluationWorkflowControls(profile.id, compiled, source.controls);
        return Object.freeze({
          id: profile.id,
          adapter: profile.adapter,
          workflow: Object.freeze({
            sourceKind:
              profile.selection === "baseline"
                ? ("effective-harness-baseline" as const)
                : ("effective-harness-candidate-projection" as const),
            sourcePath: null,
            provenance: profile.effectiveCandidate,
            source: workflowSource,
            sourceSha256: state.workflow.sha256,
            workflowDigest: state.workflow.workflowDigest,
            compiled,
          }),
          ...(profile.selection === "candidate"
            ? {
                candidate: Object.freeze({
                  ...artifact.candidate,
                  selectionProvenance: profile.effectiveCandidate,
                }),
              }
            : {}),
          ...(state.packages.length === 0
            ? {}
            : { capabilitySnapshot: capabilitySnapshotForState(state) }),
          effectiveHarness: Object.freeze({
            selection: profile.selection,
            artifactDigest: artifact.artifactDigest,
            stateDigest: state.stateDigest,
            baselineHeadDigest: artifact.baselineHead.headDigest,
            workflowId: state.workflowId,
            workflowSha256: state.workflow.sha256,
            workflowDigest: state.workflow.workflowDigest,
            packageDigests: Object.freeze(state.packages.map((item) => item.digest)),
            surface: artifact.surface,
            candidateDigest: artifact.candidate.candidateDigest,
          }),
          effectiveHarnessState: state,
        });
      }

      const candidatePath = await resolveAdmittedEvaluationPath(
        planRoot,
        profile.candidate,
        "entry",
      );
      dependencies?.signal?.throwIfAborted();
      let admittedCandidate: Awaited<ReturnType<typeof admitLocalAdaptationCandidate>>;
      try {
        admittedCandidate = await admitLocalAdaptationCandidate(candidatePath, {
          ...(dependencies?.signal === undefined ? {} : { signal: dependencies.signal }),
          ...(dependencies?.afterCandidatePathValidation === undefined
            ? {}
            : {
                afterAgentSkillPathValidation: dependencies.afterCandidatePathValidation,
              }),
        });
        dependencies?.signal?.throwIfAborted();
      } catch (error) {
        dependencies?.signal?.throwIfAborted();
        throw new EvaluationAdmissionError(
          "invalid_workflow",
          `profile "${profile.id}" candidate cannot be admitted: ${boundedMessage(error)}`,
          { cause: error },
        );
      }
      if (admittedCandidate.kind === "effective-harness-candidate") {
        throw new EvaluationAdmissionError(
          "invalid_workflow",
          `profile "${profile.id}" effective harness artifact requires the effectiveCandidate field`,
        );
      }
      if (admittedCandidate.kind === "supplemental-memory-candidate") {
        throw new EvaluationAdmissionError(
          "invalid_workflow",
          `profile "${profile.id}" supplemental-memory candidate requires the effectiveCandidate field`,
        );
      }
      if (admittedCandidate.kind === "agent-skill-candidate") {
        const skillCandidate = admittedCandidate.candidate;
        assertEvaluationWorkflowControls(
          profile.id,
          skillCandidate.workflow.compiled,
          source.controls,
        );
        return Object.freeze({
          id: profile.id,
          adapter: profile.adapter,
          workflow: Object.freeze({
            sourceKind: "agent-skill-candidate-projection" as const,
            sourcePath: null,
            provenance: profile.candidate,
            source: skillCandidate.baseline.workflow.sourceText,
            sourceSha256: skillCandidate.workflow.sourceSha256,
            workflowDigest: skillCandidate.workflow.workflowDigest,
            compiled: skillCandidate.workflow.compiled,
          }),
          candidate: Object.freeze({
            ...skillCandidate.identity,
            selectionProvenance: profile.candidate,
          }),
          capabilitySnapshot: skillCandidate.candidateCapabilitySnapshot,
          baselineCapabilitySnapshot: skillCandidate.baselineCapabilitySnapshot,
        });
      }
      if (admittedCandidate.kind === "agent-skill-package-candidate") {
        const packageCandidate = admittedCandidate.candidate;
        assertEvaluationWorkflowControls(
          profile.id,
          packageCandidate.workflow.compiled,
          source.controls,
        );
        return Object.freeze({
          id: profile.id,
          adapter: profile.adapter,
          workflow: Object.freeze({
            sourceKind: "agent-skill-package-candidate-projection" as const,
            sourcePath: null,
            provenance: profile.candidate,
            source: packageCandidate.workflow.source,
            sourceSha256: packageCandidate.workflow.sourceSha256,
            workflowDigest: packageCandidate.workflow.workflowDigest,
            compiled: packageCandidate.workflow.compiled,
          }),
          candidate: Object.freeze({
            ...packageCandidate.identity,
            selectionProvenance: profile.candidate,
          }),
          capabilitySnapshot: packageCandidate.candidateCapabilitySnapshot,
        });
      }
      const promptCandidate = admittedCandidate.candidate;
      assertEvaluationWorkflowControls(
        profile.id,
        promptCandidate.workflow.compiled,
        source.controls,
      );
      return Object.freeze({
        id: profile.id,
        adapter: profile.adapter,
        workflow: Object.freeze({
          sourceKind: "prompt-candidate-projection" as const,
          sourcePath: null,
          provenance: profile.candidate,
          source: promptCandidate.workflow.source,
          sourceSha256: promptCandidate.workflow.sourceSha256,
          workflowDigest: promptCandidate.workflow.workflowDigest,
          compiled: promptCandidate.workflow.compiled,
        }),
        candidate: Object.freeze({
          ...promptCandidate.identity,
          selectionProvenance: profile.candidate,
        }),
      });
    }),
  );
  dependencies?.signal?.throwIfAborted();
  const profiles = bindCandidateComparison(
    admittedProfiles as [AdmittedEvaluationProfile, AdmittedEvaluationProfile],
    source.comparison,
    source.controls,
  );
  for (const profile of profiles) {
    if (profile.adapter === "flow-workflow-v1") {
      assertClosedEvaluationWorkflowCapabilities(
        profile.id,
        profile.workflow.compiled,
        profile.capabilitySnapshot,
      );
    }
  }

  const planDigest = calculateEvaluationPlanDigest({
    version: 1,
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    suite: {
      id: source.suite.id,
      version: source.suite.version,
      tasks: tasks.map((task) => ({
        id: task.id,
        partition: task.partition,
        fixture: {
          provenance: task.fixture.provenance,
          digest: task.fixture.digest,
          entryCount: task.fixture.entryCount,
          logicalBytes: task.fixture.logicalBytes,
          instructionPath: task.fixture.instructionPath,
          instructionSha256: task.fixture.instructionSha256,
        },
        verifier: {
          kind: task.verifier.kind,
          digest: task.verifier.digest,
          assertionCount: task.verifier.assertions.length,
        },
      })),
    },
    profiles: profiles.map((profile) => {
      if (profile.adapter === "pi-native-v1") {
        return { id: profile.id, adapter: profile.adapter, harness: profile.harness };
      }
      if (profile.adapter === "omp-native-v1") {
        return { id: profile.id, adapter: profile.adapter, harness: profile.harness };
      }
      if (profile.adapter === "prime-agent-native-v1") {
        return { id: profile.id, adapter: profile.adapter, harness: profile.harness };
      }
      return {
        id: profile.id,
        adapter: profile.adapter,
        workflow: {
          provenance: profile.workflow.provenance,
          sourceSha256: profile.workflow.sourceSha256,
          workflowDigest: profile.workflow.workflowDigest,
          ...(profile.workflow.sourceKind !== "file"
            ? { sourceKind: profile.workflow.sourceKind }
            : {}),
        },
        ...(profile.capabilitySnapshot === undefined
          ? {}
          : {
              capabilitySnapshotDigest: profile.capabilitySnapshot.digest,
              capabilityPackageDigests: profile.capabilitySnapshot.packages.map(
                (item) => item.digest,
              ),
            }),
        ...(profile.candidate === undefined
          ? {}
          : {
              candidate: projectEvaluationCandidateIdentity(profile.candidate),
            }),
        ...(profile.effectiveHarness === undefined
          ? {}
          : { effectiveHarness: profile.effectiveHarness }),
      };
    }),
    controls: source.controls,
    seeds: source.seeds,
    order: source.order,
    comparison: source.comparison,
  });
  const schedule = createEvaluationSchedule(
    planDigest,
    tasks.map((task) => task.id),
    profiles.map((profile) => profile.id),
    source.seeds,
  );
  dependencies?.signal?.throwIfAborted();

  return Object.freeze({
    apiVersion: source.apiVersion,
    id: source.metadata.id,
    planDigest,
    sourcePath: canonicalPlanPath,
    suite: Object.freeze({
      id: source.suite.id,
      version: source.suite.version,
      tasks: Object.freeze(tasks),
    }),
    profiles: Object.freeze(profiles),
    controls: source.controls,
    seeds: source.seeds,
    order: source.order,
    comparison: source.comparison,
    schedule,
  });
}

export async function observeEvaluationFixture(
  sourceCwd: string,
  instructionPath: string,
): Promise<EvaluationFixtureSnapshot> {
  const root = await realpath(sourceCwd);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new EvaluationAdmissionError(
      "invalid_source",
      `fixture "${sourceCwd}" is not a directory`,
    );
  }
  const state: FixtureScanState = {
    entryCount: 0,
    logicalBytes: 0,
    digest: createHash("sha256"),
    files: new Map(),
  };
  await scanFixtureDirectory(root, "", state);
  const instruction = state.files.get(instructionPath);
  if (instruction === undefined) {
    throw new EvaluationAdmissionError(
      "invalid_source",
      `fixture instruction "${instructionPath}" is missing or is not a regular file`,
    );
  }
  if (instruction.size > MAX_EVALUATION_INSTRUCTION_BYTES) {
    throw new EvaluationAdmissionError(
      "limit_exceeded",
      `fixture instruction "${instructionPath}" exceeds ${MAX_EVALUATION_INSTRUCTION_BYTES} bytes`,
    );
  }
  return Object.freeze({
    digest: state.digest.digest("hex"),
    entryCount: state.entryCount,
    logicalBytes: state.logicalBytes,
    instructionPath,
    instructionSha256: instruction.sha256,
  });
}

async function scanFixtureDirectory(
  root: string,
  relativeDirectory: string,
  state: FixtureScanState,
): Promise<void> {
  const directoryPath = relativeDirectory === "" ? root : join(root, relativeDirectory);
  const beforeDirectory = await lstat(directoryPath);
  const directory = await opendir(directoryPath);
  const names: string[] = [];
  for await (const entry of directory) {
    names.push(entry.name);
  }
  names.sort(compareStrings);

  for (const name of names) {
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (name === ".flow") {
      throw new EvaluationAdmissionError(
        "unsupported_entry",
        `fixture entry "${relativePath}" cannot be reproduced by evaluation isolation`,
      );
    }
    const absolutePath = join(root, relativePath);
    const before = await lstat(absolutePath);
    state.entryCount += 1;
    enforceFixtureLimits(state);
    if (before.isSymbolicLink()) {
      throw new EvaluationAdmissionError(
        "unsupported_entry",
        `fixture entry "${relativePath}" is a symbolic link`,
      );
    }
    const mode = before.mode & 0o777;
    if (before.isDirectory()) {
      state.digest.update(`directory\0${relativePath}\0${mode}\0`);
      await scanFixtureDirectory(root, relativePath, state);
      continue;
    }
    if (!before.isFile()) {
      throw new EvaluationAdmissionError(
        "unsupported_entry",
        `fixture entry "${relativePath}" is not a regular file or directory`,
      );
    }
    state.logicalBytes += before.size;
    enforceFixtureLimits(state);
    const file = await stableReadEvaluationFile(
      absolutePath,
      MAX_EVALUATION_FIXTURE_BYTES,
      `fixture entry "${relativePath}"`,
    );
    state.files.set(relativePath, Object.freeze({ sha256: file.sha256, size: before.size }));
    state.digest.update(`file\0${relativePath}\0${mode}\0${before.size}\0${file.sha256}\0`);
  }

  const afterDirectory = await lstat(directoryPath);
  if (!sameFileIdentity(beforeDirectory, afterDirectory)) {
    throw new EvaluationAdmissionError(
      "source_changed",
      `fixture directory "${relativeDirectory || "."}" changed during admission`,
    );
  }
}

export async function resolveAdmittedEvaluationPath(
  root: string,
  provenance: string,
  expectedKind: "file" | "directory" | "entry",
): Promise<string> {
  const candidate = resolve(root, provenance);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new EvaluationAdmissionError(
      "invalid_path",
      `path "${provenance}" escapes or aliases the evaluation plan root`,
    );
  }
  let current = root;
  for (const segment of provenance.split("/")) {
    current = join(current, segment);
    let entry: Stats;
    try {
      entry = await lstat(current);
    } catch (error) {
      throw new EvaluationAdmissionError(
        "invalid_source",
        `path "${provenance}" cannot be admitted: ${boundedMessage(error)}`,
        { cause: error },
      );
    }
    if (entry.isSymbolicLink()) {
      throw new EvaluationAdmissionError(
        "invalid_path",
        `path "${provenance}" contains a symbolic link`,
      );
    }
  }
  const final = await lstat(candidate);
  if (
    (expectedKind === "file" && !final.isFile()) ||
    (expectedKind === "directory" && !final.isDirectory()) ||
    (expectedKind === "entry" && !final.isFile() && !final.isDirectory())
  ) {
    throw new EvaluationAdmissionError(
      "invalid_source",
      `path "${provenance}" is not an admitted ${expectedKind}`,
    );
  }
  return candidate;
}

export async function stableReadEvaluationFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<StableEvaluationFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new EvaluationAdmissionError(
      "invalid_source",
      `${label} cannot be opened without following links: ${boundedMessage(error)}`,
      { cause: error },
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new EvaluationAdmissionError("invalid_source", `${label} is not a regular file`);
    }
    if (before.size > maxBytes) {
      throw new EvaluationAdmissionError("limit_exceeded", `${label} exceeds ${maxBytes} bytes`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (content.byteLength !== before.size || !sameFileIdentity(before, after)) {
      throw new EvaluationAdmissionError("source_changed", `${label} changed while it was read`);
    }
    return Object.freeze({
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

function bindCandidateComparison(
  profiles: readonly [AdmittedEvaluationProfile, AdmittedEvaluationProfile],
  comparison: EvaluationPlanSource["comparison"],
  controls: EvaluationPlanSource["controls"],
): [AdmittedEvaluationProfile, AdmittedEvaluationProfile] {
  const effectiveProfiles = profiles.filter(
    (profile): profile is AdmittedFlowEvaluationProfile =>
      profile.adapter === "flow-workflow-v1" && profile.effectiveHarness !== undefined,
  );
  if (effectiveProfiles.length > 0) {
    const baseline = profiles.find((profile) => profile.id === comparison.baselineProfileId);
    const candidate = profiles.find((profile) => profile.id === comparison.candidateProfileId);
    if (
      effectiveProfiles.length !== 2 ||
      baseline === undefined ||
      candidate === undefined ||
      baseline.adapter !== "flow-workflow-v1" ||
      candidate.adapter !== "flow-workflow-v1" ||
      baseline.effectiveHarness?.selection !== "baseline" ||
      candidate.effectiveHarness?.selection !== "candidate" ||
      baseline.candidate !== undefined ||
      candidate.candidate === undefined ||
      baseline.effectiveHarnessState === undefined ||
      candidate.effectiveHarnessState === undefined ||
      baseline.workflow.provenance !== candidate.workflow.provenance ||
      baseline.effectiveHarness.artifactDigest !== candidate.effectiveHarness.artifactDigest ||
      baseline.effectiveHarness.baselineHeadDigest !==
        candidate.effectiveHarness.baselineHeadDigest ||
      baseline.effectiveHarness.surface !== candidate.effectiveHarness.surface ||
      baseline.effectiveHarness.candidateDigest !== candidate.effectiveHarness.candidateDigest ||
      baseline.effectiveHarness.stateDigest !== baseline.effectiveHarnessState.stateDigest ||
      candidate.effectiveHarness.stateDigest !== candidate.effectiveHarnessState.stateDigest ||
      candidate.effectiveHarness.candidateDigest !== candidate.candidate.candidateDigest
    ) {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        "effective harness comparison profiles must select one exact baseline and candidate pair",
      );
    }
    assertEffectiveModelRoutes(baseline, candidate, controls);
    return [...profiles];
  }
  const candidateProfiles = profiles.filter(
    (profile): profile is AdmittedFlowEvaluationProfile =>
      profile.adapter === "flow-workflow-v1" && profile.candidate !== undefined,
  );
  if (candidateProfiles.length === 0) {
    return [...profiles];
  }
  const baseline = profiles.find((profile) => profile.id === comparison.baselineProfileId);
  const candidate = profiles.find((profile) => profile.id === comparison.candidateProfileId);
  if (
    candidateProfiles.length !== 1 ||
    baseline === undefined ||
    candidate === undefined ||
    baseline.adapter !== "flow-workflow-v1" ||
    candidate.adapter !== "flow-workflow-v1" ||
    baseline.candidate !== undefined ||
    candidate.candidate === undefined
  ) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "a candidate source must be selected only on the comparison candidate profile",
    );
  }
  if (!("kind" in candidate.candidate)) {
    if (
      candidate.candidate.baseline.sourceSha256 !== baseline.workflow.sourceSha256 ||
      candidate.candidate.baseline.workflowDigest !== baseline.workflow.workflowDigest
    ) {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        "the prompt candidate must overlay the exact comparison baseline workflow identity",
      );
    }
    return [...profiles];
  }
  if (candidate.candidate.kind === "agent-skill-package-candidate") {
    if (
      candidate.candidate.baseline.workflow.sourceSha256 !== baseline.workflow.sourceSha256 ||
      candidate.candidate.baseline.workflow.workflowDigest !== baseline.workflow.workflowDigest ||
      candidate.candidate.projectedWorkflow.sourceSha256 !== candidate.workflow.sourceSha256 ||
      candidate.candidate.projectedWorkflow.workflowDigest !== candidate.workflow.workflowDigest ||
      baseline.capabilitySnapshot !== undefined ||
      candidate.capabilitySnapshot === undefined ||
      candidate.candidate.package.capabilityDigest !== candidate.capabilitySnapshot.digest ||
      candidate.capabilitySnapshot.packages.length !== 1 ||
      candidate.capabilitySnapshot.packages[0]?.digest !== candidate.candidate.package.packageDigest
    ) {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        "the Agent Skill package candidate must bind the exact baseline and projected package identities",
      );
    }
    return [...profiles];
  }
  if (candidate.candidate.kind === "supplemental-memory-candidate") {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "a supplemental-memory candidate requires the effectiveCandidate field",
    );
  }
  if (
    candidate.candidate.baseline.workflow.sourceSha256 !== baseline.workflow.sourceSha256 ||
    candidate.candidate.baseline.workflow.workflowDigest !== baseline.workflow.workflowDigest ||
    candidate.workflow.sourceSha256 !== baseline.workflow.sourceSha256 ||
    candidate.workflow.workflowDigest !== baseline.workflow.workflowDigest ||
    candidate.baselineCapabilitySnapshot === undefined ||
    candidate.capabilitySnapshot === undefined
  ) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "the Agent Skill candidate must preserve the exact comparison workflow and skill identities",
    );
  }
  return profiles.map((profile) =>
    profile === baseline
      ? Object.freeze({
          ...profile,
          capabilitySnapshot: candidate.baselineCapabilitySnapshot,
        })
      : profile,
  ) as [AdmittedEvaluationProfile, AdmittedEvaluationProfile];
}

function assertEffectiveModelRoutes(
  baseline: AdmittedFlowEvaluationProfile,
  candidate: AdmittedFlowEvaluationProfile,
  controls: EvaluationPlanSource["controls"],
): void {
  const routes = controls.modelRoutes;
  const surface = candidate.effectiveHarness?.surface;
  if (routes === undefined) {
    if (surface === "model-routing") {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        "model-routing comparison requires two explicit profile routes",
      );
    }
    return;
  }
  const identity = candidate.candidate;
  const [baselineRoute, candidateRoute] = routes;
  if (
    surface !== "model-routing" ||
    baseline.effectiveHarness?.surface !== "model-routing" ||
    identity === undefined ||
    !("kind" in identity) ||
    identity.kind !== "model-routing-candidate" ||
    baselineRoute.profileId !== baseline.id ||
    candidateRoute.profileId !== candidate.id ||
    baselineRoute.nodeId !== identity.scope.nodeId ||
    candidateRoute.nodeId !== identity.scope.nodeId ||
    !isDeepStrictEqual(baselineRoute.route, identity.route.before) ||
    !isDeepStrictEqual(candidateRoute.route, identity.route.after)
  ) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "model-routing controls must bind the exact effective candidate route identities",
    );
  }
}

function capabilitySnapshotForState(state: EffectiveHarnessState): CapabilitySnapshot {
  return validateCapabilitySnapshot({
    version: 1,
    packages: state.packages,
    digest: calculateCapabilitySnapshotDigest(state.packages),
  });
}

export function assertEvaluationWorkflowControls(
  profileId: string,
  workflow: CompiledWorkflow,
  controls: EvaluationPlanSource["controls"],
): void {
  if (!sameBudget(workflow.budget, controls.budget)) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" workflow budget must exactly match evaluation controls`,
    );
  }
  const models = workflowModels(workflow);
  if (models.length === 0) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" requires at least one model-bearing node controlled by the evaluation plan`,
    );
  }
  const configuredRoute = controls.modelRoutes?.find((item) => item.profileId === profileId);
  if (controls.modelRoutes !== undefined && configuredRoute === undefined) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" has no explicit model route`,
    );
  }
  let selectedTargets = 0;
  for (const model of models) {
    const selected =
      configuredRoute !== undefined && model.rootAgent && model.nodeId === configuredRoute.nodeId;
    if (selected) selectedTargets += 1;
    const expected = selected ? configuredRoute.route : controls.model;
    if (
      model.route.provider !== expected.provider ||
      model.route.id !== expected.id ||
      model.route.thinking !== expected.thinking
    ) {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        `profile "${profileId}" workflow model does not match evaluation controls`,
      );
    }
  }
  if (configuredRoute !== undefined && selectedTargets !== 1) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" model route must select one exact root agent node`,
    );
  }
}

export function assertClosedEvaluationWorkflowCapabilities(
  profileId: string,
  workflow: CompiledWorkflow,
  capabilitySnapshot?: CapabilitySnapshot,
): void {
  if (
    capabilitySnapshot?.packages.some((item) => item.kind !== "agent-skill") === true ||
    (capabilitySnapshot?.activations?.length ?? 0) > 0
  ) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" contains capability types not admitted by Agent Skill evaluation`,
    );
  }
  assertClosedWorkflowStructure(profileId, workflow, capabilitySnapshot !== undefined);
  try {
    bindWorkflowCapabilities(workflow, capabilitySnapshot);
  } catch (error) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" capability snapshot does not bind its workflow`,
      { cause: error },
    );
  }
}

function assertClosedWorkflowStructure(
  profileId: string,
  workflow: CompiledWorkflow,
  permitsAgentSkills: boolean,
): void {
  if (workflow.sourcePackage !== undefined) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" workflow packages are not captured by evaluation plan version 1`,
    );
  }
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      if (
        (!permitsAgentSkills && node.agent.skills.length > 0) ||
        node.agent.toolPackages.length > 0
      ) {
        throw new EvaluationAdmissionError(
          "invalid_workflow",
          `profile "${profileId}" Agent Skills and tool capability packages are not captured by evaluation plan version 1`,
        );
      }
      if (node.agent.recovery !== undefined) {
        throw new EvaluationAdmissionError(
          "invalid_workflow",
          `profile "${profileId}" agent recovery contradicts the evaluation zero-retry control`,
        );
      }
    } else if (
      node.type === "verifier" &&
      (node.verifier.kind === "packaged-command" || node.verifier.kind === "packaged-model")
    ) {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        `profile "${profileId}" verifier capability packages are not captured by evaluation plan version 1`,
      );
    } else if (node.type === "child") {
      assertClosedWorkflowStructure(profileId, node.child.workflow, permitsAgentSkills);
    }
  }
}

function workflowModels(
  workflow: CompiledWorkflow,
  rootAgent = true,
): readonly {
  readonly nodeId: string;
  readonly rootAgent: boolean;
  readonly route: { readonly provider: string; readonly id: string; readonly thinking: string };
}[] {
  const models: Array<{
    readonly nodeId: string;
    readonly rootAgent: boolean;
    readonly route: { readonly provider: string; readonly id: string; readonly thinking: string };
  }> = [];
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      models.push({ nodeId: node.id, rootAgent, route: node.agent.model });
    } else if (
      node.type === "verifier" &&
      (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
    ) {
      models.push({ nodeId: node.id, rootAgent: false, route: node.verifier.model });
    } else if (node.type === "child") {
      models.push(...workflowModels(node.child.workflow, false));
    }
  }
  return models;
}

function sameBudget(
  actual: CompiledRunBudget | undefined,
  expected: EvaluationPlanSource["controls"]["budget"],
): boolean {
  return (
    actual?.maxNodeStarts === expected.maxNodeStarts &&
    actual.maxModelTokens === expected.maxModelTokens &&
    actual.maxCostUsdMicros === expected.maxCostUsdMicros &&
    actual.maxExecutionMs === expected.maxExecutionMs &&
    actual.maxArtifactBytes === expected.maxArtifactBytes
  );
}

function enforceFixtureLimits(state: FixtureScanState): void {
  if (
    state.entryCount > MAX_EVALUATION_FIXTURE_ENTRIES ||
    state.logicalBytes > MAX_EVALUATION_FIXTURE_BYTES
  ) {
    throw new EvaluationAdmissionError(
      "limit_exceeded",
      `fixture exceeds ${MAX_EVALUATION_FIXTURE_ENTRIES} entries or ${MAX_EVALUATION_FIXTURE_BYTES} bytes`,
    );
  }
}

function sameFileIdentity(
  left: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  },
  right: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_024);
}
