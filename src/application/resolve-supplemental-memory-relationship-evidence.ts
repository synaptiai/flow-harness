import {
  compileEffectiveHarnessState,
  type EffectiveHarnessState,
} from "../domain/adaptation/effective-harness-state.js";
import type { SupplementalMemoryCandidateSource } from "../domain/adaptation/supplemental-memory-candidate.js";
import type { RunEvidenceReference } from "../domain/evidence/run-evidence-reference.js";
import {
  resolveRunEvidenceReferences,
  RunEvidenceAdmissionError,
  type RunEvidenceReader,
} from "./resolve-run-evidence-reference.js";

export async function resolveSupplementalMemoryRelationshipEvidence(
  source: SupplementalMemoryCandidateSource,
  baseline: EffectiveHarnessState,
  runReader: RunEvidenceReader,
  signal?: AbortSignal,
): Promise<readonly RunEvidenceReference[]> {
  const locators = source.relationships?.add.flatMap((relationship) => relationship.evidence) ?? [];
  if (locators.length === 0) return Object.freeze([]);
  signal?.throwIfAborted();

  let selected = compileEffectiveHarnessState(baseline);
  for (const childNodeId of source.scope.childPath) {
    const node = selected.nodes.find((item) => item.id === childNodeId);
    if (node?.type !== "child" || node.child.workflow.sourcePackage !== undefined) {
      throw new RunEvidenceAdmissionError("evidence_unavailable");
    }
    selected = node.child.workflow;
  }
  if (selected.nodes.find((node) => node.id === source.scope.agentNodeId)?.type !== "agent") {
    throw new RunEvidenceAdmissionError("evidence_unavailable");
  }

  return await resolveRunEvidenceReferences(locators, runReader, {
    ...(signal === undefined ? {} : { signal }),
    acceptEvent: (event, locator) =>
      locator.nodeId === source.scope.agentNodeId &&
      (event.type === "node_succeeded" || event.type === "node_failed") &&
      event.workflowId === selected.id &&
      event.nodeId === source.scope.agentNodeId,
  });
}
