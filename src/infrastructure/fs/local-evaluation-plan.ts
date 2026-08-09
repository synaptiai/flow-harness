import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { PromptCandidateIdentity } from "../../domain/adaptation/prompt-candidate.js";
import {
  calculateEvaluationPlanDigest,
  calculateEvaluationVerifierDigest,
  createEvaluationSchedule,
  type EvaluationFilesystemAssertion,
  type EvaluationPlanSource,
  type EvaluationTrialScheduleItem,
  MAX_EVALUATION_PLAN_BYTES,
  parseEvaluationPlanText,
} from "../../domain/evaluation/plan.js";
import { compileWorkflowText } from "../../domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../domain/workflow/digest.js";
import type { CompiledRunBudget, CompiledWorkflow } from "../../domain/workflow/types.js";
import { admitLocalPromptCandidate } from "./local-prompt-candidate.js";

export const MAX_EVALUATION_FIXTURE_ENTRIES = 4_096;
export const MAX_EVALUATION_FIXTURE_BYTES = 256 * 1024 * 1024;
export const MAX_EVALUATION_WORKFLOW_BYTES = 1_048_576;

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

export interface AdmittedEvaluationProfile {
  readonly id: string;
  readonly adapter: "flow-workflow-v1";
  readonly workflow: {
    readonly sourceKind: "file" | "prompt-candidate-projection";
    readonly sourcePath: string | null;
    readonly provenance: string;
    readonly source: string;
    readonly sourceSha256: string;
    readonly workflowDigest: string;
    readonly compiled: CompiledWorkflow;
  };
  readonly candidate?: PromptCandidateIdentity & { readonly selectionProvenance: string };
}

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
  candidate: NonNullable<AdmittedEvaluationProfile["candidate"]>,
): { readonly provenance: string; readonly identity: PromptCandidateIdentity } {
  const { selectionProvenance, ...identity } = candidate;
  return Object.freeze({ provenance: selectionProvenance, identity: Object.freeze(identity) });
}

interface FixtureScanState {
  entryCount: number;
  logicalBytes: number;
  readonly digest: ReturnType<typeof createHash>;
  readonly files: Map<string, string>;
}

interface StableFile {
  readonly content: Buffer;
  readonly sha256: string;
}

export async function admitLocalEvaluationPlan(planPath: string): Promise<AdmittedEvaluationPlan> {
  const absolutePlanPath = resolve(planPath);
  const planRoot = await realpath(dirname(absolutePlanPath));
  const canonicalPlanPath = join(planRoot, basename(absolutePlanPath));
  const planFile = await stableReadFile(
    canonicalPlanPath,
    MAX_EVALUATION_PLAN_BYTES,
    "evaluation plan",
  );
  const source = parseEvaluationPlanText(planFile.content.toString("utf8"), basename(planPath));

  const tasks = await Promise.all(
    source.suite.tasks.map(async (task): Promise<AdmittedEvaluationTask> => {
      const fixturePath = await resolveAdmittedPath(planRoot, task.fixture, "directory");
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

  const admittedProfiles = await Promise.all(
    source.profiles.map(async (profile): Promise<AdmittedEvaluationProfile> => {
      if ("workflow" in profile) {
        const workflowPath = await resolveAdmittedPath(planRoot, profile.workflow, "file");
        const workflowFile = await stableReadFile(
          workflowPath,
          MAX_EVALUATION_WORKFLOW_BYTES,
          `workflow "${profile.id}"`,
        );
        const workflowSource = workflowFile.content.toString("utf8");
        let compiled: CompiledWorkflow;
        try {
          compiled = compileWorkflowText(workflowSource, profile.workflow);
        } catch (error) {
          throw new EvaluationAdmissionError(
            "invalid_workflow",
            `profile "${profile.id}" workflow cannot be compiled: ${boundedMessage(error)}`,
            { cause: error },
          );
        }
        assertWorkflowControls(profile.id, compiled, source.controls);
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

      const candidatePath = await resolveAdmittedPath(planRoot, profile.candidate, "file");
      let admittedCandidate: Awaited<ReturnType<typeof admitLocalPromptCandidate>>;
      try {
        admittedCandidate = await admitLocalPromptCandidate(candidatePath);
      } catch (error) {
        throw new EvaluationAdmissionError(
          "invalid_workflow",
          `profile "${profile.id}" prompt candidate cannot be admitted: ${boundedMessage(error)}`,
          { cause: error },
        );
      }
      assertWorkflowControls(profile.id, admittedCandidate.workflow.compiled, source.controls);
      return Object.freeze({
        id: profile.id,
        adapter: profile.adapter,
        workflow: Object.freeze({
          sourceKind: "prompt-candidate-projection" as const,
          sourcePath: null,
          provenance: profile.candidate,
          source: admittedCandidate.workflow.source,
          sourceSha256: admittedCandidate.workflow.sourceSha256,
          workflowDigest: admittedCandidate.workflow.workflowDigest,
          compiled: admittedCandidate.workflow.compiled,
        }),
        candidate: Object.freeze({
          ...admittedCandidate.identity,
          selectionProvenance: profile.candidate,
        }),
      });
    }),
  );
  const profiles = admittedProfiles as [AdmittedEvaluationProfile, AdmittedEvaluationProfile];
  assertCandidateComparison(profiles, source.comparison);

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
    profiles: profiles.map((profile) => ({
      id: profile.id,
      adapter: profile.adapter,
      workflow: {
        provenance: profile.workflow.provenance,
        sourceSha256: profile.workflow.sourceSha256,
        workflowDigest: profile.workflow.workflowDigest,
        ...(profile.workflow.sourceKind === "prompt-candidate-projection"
          ? { sourceKind: profile.workflow.sourceKind }
          : {}),
      },
      ...(profile.candidate === undefined
        ? {}
        : {
            candidate: projectEvaluationCandidateIdentity(profile.candidate),
          }),
    })),
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
  const instructionSha256 = state.files.get(instructionPath);
  if (instructionSha256 === undefined) {
    throw new EvaluationAdmissionError(
      "invalid_source",
      `fixture instruction "${instructionPath}" is missing or is not a regular file`,
    );
  }
  return Object.freeze({
    digest: state.digest.digest("hex"),
    entryCount: state.entryCount,
    logicalBytes: state.logicalBytes,
    instructionPath,
    instructionSha256,
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
    const file = await stableReadFile(
      absolutePath,
      MAX_EVALUATION_FIXTURE_BYTES,
      `fixture entry "${relativePath}"`,
    );
    state.files.set(relativePath, file.sha256);
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

async function resolveAdmittedPath(
  root: string,
  provenance: string,
  expectedKind: "file" | "directory",
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
    (expectedKind === "directory" && !final.isDirectory())
  ) {
    throw new EvaluationAdmissionError(
      "invalid_source",
      `path "${provenance}" is not a regular ${expectedKind}`,
    );
  }
  return candidate;
}

async function stableReadFile(path: string, maxBytes: number, label: string): Promise<StableFile> {
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

function assertCandidateComparison(
  profiles: readonly [AdmittedEvaluationProfile, AdmittedEvaluationProfile],
  comparison: EvaluationPlanSource["comparison"],
): void {
  const candidateProfiles = profiles.filter((profile) => profile.candidate !== undefined);
  if (candidateProfiles.length === 0) {
    return;
  }
  const baseline = profiles.find((profile) => profile.id === comparison.baselineProfileId);
  const candidate = profiles.find((profile) => profile.id === comparison.candidateProfileId);
  if (
    candidateProfiles.length !== 1 ||
    baseline === undefined ||
    candidate === undefined ||
    baseline.candidate !== undefined ||
    candidate.candidate === undefined
  ) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "a prompt candidate source must be selected only on the comparison candidate profile",
    );
  }
  if (
    candidate.candidate.baseline.sourceSha256 !== baseline.workflow.sourceSha256 ||
    candidate.candidate.baseline.workflowDigest !== baseline.workflow.workflowDigest
  ) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      "the prompt candidate must overlay the exact comparison baseline workflow identity",
    );
  }
}

function assertWorkflowControls(
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
  assertClosedWorkflowCapabilities(profileId, workflow);
  const models = workflowModels(workflow);
  if (models.length === 0) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" requires at least one model-bearing node controlled by the evaluation plan`,
    );
  }
  for (const model of models) {
    if (
      model.provider !== controls.model.provider ||
      model.id !== controls.model.id ||
      model.thinking !== controls.model.thinking
    ) {
      throw new EvaluationAdmissionError(
        "invalid_workflow",
        `profile "${profileId}" workflow model "${model.provider}/${model.id}/${model.thinking}" does not match evaluation controls`,
      );
    }
  }
}

function assertClosedWorkflowCapabilities(profileId: string, workflow: CompiledWorkflow): void {
  if (workflow.sourcePackage !== undefined) {
    throw new EvaluationAdmissionError(
      "invalid_workflow",
      `profile "${profileId}" workflow packages are not captured by evaluation plan version 1`,
    );
  }
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      if (node.agent.skills.length > 0 || node.agent.toolPackages.length > 0) {
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
      assertClosedWorkflowCapabilities(profileId, node.child.workflow);
    }
  }
}

function workflowModels(
  workflow: CompiledWorkflow,
): readonly { readonly provider: string; readonly id: string; readonly thinking: string }[] {
  const models: Array<{
    readonly provider: string;
    readonly id: string;
    readonly thinking: string;
  }> = [];
  for (const node of workflow.nodes) {
    if (node.type === "agent") {
      models.push(node.agent.model);
    } else if (
      node.type === "verifier" &&
      (node.verifier.kind === "model" || node.verifier.kind === "packaged-model")
    ) {
      models.push(node.verifier.model);
    } else if (node.type === "child") {
      models.push(...workflowModels(node.child.workflow));
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
