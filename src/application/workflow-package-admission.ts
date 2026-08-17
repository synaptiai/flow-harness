import { agentSkillActivationWorkflow } from "../domain/adaptation/agent-skill-activation.js";
import { agentSkillPackageActivationWorkflow } from "../domain/adaptation/agent-skill-package-activation.js";
import {
  parsePromptActivationLocator,
  promptActivationSource,
} from "../domain/adaptation/prompt-activation.js";
import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../domain/capability/agent-skills.js";
import {
  parseWorkflowPackageLocator,
  validateWorkflowPackageSnapshot,
  type WorkflowPackageSnapshot,
  workflowPackageIdentityKey,
  workflowPackageSource,
} from "../domain/capability/workflow-packages.js";
import {
  compileWorkflowText,
  type ResolvedWorkflowPackage,
  type WorkflowPackageReference,
  type WorkflowPackageResolver,
} from "../domain/workflow/compiler.js";
import type {
  CompiledWorkflow,
  CompiledWorkflowPackageReference,
} from "../domain/workflow/types.js";

export const MAX_ADMITTED_WORKFLOW_PACKAGES = 32;

export type WorkflowAdmissionSource =
  | {
      readonly kind: "inline";
      readonly content: string;
      readonly sourceName: string;
    }
  | {
      readonly kind: "package";
      readonly snapshot: WorkflowPackageSnapshot;
    };

export interface WorkflowPackageAdmissionInput {
  readonly source: WorkflowAdmissionSource;
  readonly loadPackage: (reference: WorkflowPackageReference) => Promise<WorkflowPackageSnapshot>;
}

export interface AdmittedWorkflow {
  readonly workflow: CompiledWorkflow;
  readonly source: string;
  readonly sourceName: string;
  readonly capabilitySnapshot?: CapabilitySnapshot;
  readonly rootPackage?: CompiledWorkflowPackageReference;
}

export interface CompileWorkflowFromSnapshotInput {
  readonly source: string;
  readonly sourceName: string;
  readonly capabilitySnapshot?: CapabilitySnapshot;
}

export function compileWorkflowFromSnapshot(
  input: CompileWorkflowFromSnapshotInput,
): CompiledWorkflow {
  const snapshot =
    input.capabilitySnapshot === undefined
      ? undefined
      : validateCapabilitySnapshot(input.capabilitySnapshot);
  const activationLocator = parsePromptActivationLocator(input.sourceName);
  if (activationLocator !== null) {
    const selected =
      snapshot?.activations?.filter((item) => item.workflowId === activationLocator.workflowId) ??
      [];
    const exactActivation = selected[0];
    if (selected.length !== 1 || exactActivation === undefined) {
      throw new Error(
        `capability snapshot does not contain one exact activation for workflow "${activationLocator.workflowId}"`,
      );
    }
    const activationSource =
      exactActivation.kind === "agent-skill-activation"
        ? agentSkillActivationWorkflow(exactActivation)
        : exactActivation.kind === "agent-skill-package-activation"
          ? agentSkillPackageActivationWorkflow(exactActivation)
          : promptActivationSource(exactActivation);
    if (activationSource !== input.source) {
      throw new Error(
        `activation for workflow "${activationLocator.workflowId}" source does not match its exact snapshot`,
      );
    }
  }
  const locator = parseWorkflowPackageLocator(input.sourceName);
  let sourcePackage: CompiledWorkflowPackageReference | undefined;
  if (locator !== null) {
    const selected = snapshot?.packages.find(
      (item): item is WorkflowPackageSnapshot =>
        item.kind === "workflow-package" &&
        item.name === locator.name &&
        item.version === locator.version,
    );
    if (selected === undefined) {
      throw new Error(
        `capability snapshot does not contain packaged root "${locator.name}@${locator.version}"`,
      );
    }
    if (workflowPackageSource(selected) !== input.source) {
      throw new Error(
        `packaged root "${locator.name}@${locator.version}" source does not match its exact manifest`,
      );
    }
    sourcePackage = Object.freeze({
      name: selected.name,
      version: selected.version,
      digest: selected.digest,
    });
  }
  return compileWorkflowText(input.source, input.sourceName, {
    packageResolver: createSnapshotWorkflowPackageResolver(snapshot),
    ...(sourcePackage === undefined ? {} : { sourcePackage }),
  });
}

export async function admitWorkflowPackages(
  input: WorkflowPackageAdmissionInput,
): Promise<AdmittedWorkflow> {
  const selected = new Map<string, WorkflowPackageSnapshot>();
  let source: string;
  let sourceName: string;
  let rootPackage: CompiledWorkflowPackageReference | undefined;
  if (input.source.kind === "inline") {
    source = input.source.content;
    sourceName = input.source.sourceName;
  } else {
    const snapshot = validateWorkflowPackageSnapshot(input.source.snapshot);
    selected.set(workflowPackageIdentityKey(snapshot), snapshot);
    source = workflowPackageSource(snapshot);
    sourceName = `workflow:${snapshot.name}@${snapshot.version}`;
    rootPackage = Object.freeze({
      name: snapshot.name,
      version: snapshot.version,
      digest: snapshot.digest,
    });
  }

  let preview: CompiledWorkflow;
  while (true) {
    let missing: WorkflowPackageReference | undefined;
    const resolver = createCaptureResolver(selected, (reference) => {
      missing = reference;
    });
    try {
      preview = compileWorkflowText(source, sourceName, {
        packageResolver: resolver,
        ...(rootPackage === undefined ? {} : { sourcePackage: rootPackage }),
      });
    } catch (error) {
      if (missing === undefined) {
        throw error;
      }
      const reference = missing;
      if (selected.size >= MAX_ADMITTED_WORKFLOW_PACKAGES) {
        throw new Error(
          `workflow package admission exceeds ${MAX_ADMITTED_WORKFLOW_PACKAGES} exact packages`,
        );
      }
      const nameCollision = [...selected.values()].find((item) => item.name === reference.name);
      if (nameCollision !== undefined) {
        throw new Error(
          `workflow package "${reference.name}" cannot select both versions "${nameCollision.version}" and "${reference.version}"`,
        );
      }
      const loaded = validateWorkflowPackageSnapshot(await input.loadPackage(reference));
      if (loaded.name !== reference.name || loaded.version !== reference.version) {
        throw new Error(
          `workflow package loader returned "${loaded.name}@${loaded.version}" for requested "${reference.name}@${reference.version}"`,
        );
      }
      selected.set(workflowPackageIdentityKey(loaded), loaded);
      continue;
    }
    break;
  }

  if (selected.size === 0) {
    return Object.freeze({ workflow: preview, source, sourceName });
  }
  const capabilitySnapshot = workflowCapabilitySnapshot([...selected.values()]);
  const workflow = compileWorkflowText(source, sourceName, {
    packageResolver: createSnapshotWorkflowPackageResolver(capabilitySnapshot),
    ...(rootPackage === undefined ? {} : { sourcePackage: rootPackage }),
  });
  return Object.freeze({
    workflow,
    source,
    sourceName,
    capabilitySnapshot,
    ...(rootPackage === undefined ? {} : { rootPackage }),
  });
}

export function createSnapshotWorkflowPackageResolver(
  snapshot: CapabilitySnapshot | undefined,
): WorkflowPackageResolver {
  const packages =
    snapshot === undefined
      ? []
      : validateCapabilitySnapshot(snapshot).packages.filter(
          (item): item is WorkflowPackageSnapshot => item.kind === "workflow-package",
        );
  const byIdentity = new Map(
    packages.map((item) => [workflowPackageIdentityKey(item), resolvedPackage(item)]),
  );
  return Object.freeze({
    resolve(reference: WorkflowPackageReference): ResolvedWorkflowPackage {
      const resolved = byIdentity.get(workflowPackageIdentityKey(reference));
      if (resolved === undefined) {
        throw new Error(
          `capability snapshot does not contain workflow package "${reference.name}@${reference.version}"`,
        );
      }
      return resolved;
    },
  });
}

function createCaptureResolver(
  selected: ReadonlyMap<string, WorkflowPackageSnapshot>,
  onMissing: (reference: WorkflowPackageReference) => void,
): WorkflowPackageResolver {
  return {
    resolve(reference): ResolvedWorkflowPackage {
      const snapshot = selected.get(workflowPackageIdentityKey(reference));
      if (snapshot === undefined) {
        onMissing(Object.freeze({ ...reference }));
        throw new Error(
          `workflow package "${reference.name}@${reference.version}" requires capture`,
        );
      }
      return resolvedPackage(snapshot);
    },
  };
}

function resolvedPackage(snapshot: WorkflowPackageSnapshot): ResolvedWorkflowPackage {
  return Object.freeze({
    name: snapshot.name,
    version: snapshot.version,
    digest: snapshot.digest,
    source: workflowPackageSource(snapshot),
  });
}

function workflowCapabilitySnapshot(
  packages: readonly WorkflowPackageSnapshot[],
): CapabilitySnapshot {
  const sorted = [...packages].sort((left, right) =>
    compareStrings(workflowPackageIdentityKey(left), workflowPackageIdentityKey(right)),
  );
  return validateCapabilitySnapshot({
    version: 1,
    packages: sorted,
    digest: calculateCapabilitySnapshotDigest(sorted),
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
