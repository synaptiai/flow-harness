export function projectPublicRunOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => projectPublicRunOutput(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  if (isNodeEvidenceEvent(value)) {
    return projectNodeEvidenceOwner(value);
  }
  if (isRunState(value)) {
    return projectRunState(value);
  }
  const projected = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "capabilitySnapshot" && isRecord(item)
        ? projectCapabilitySnapshot(item)
        : projectPublicRunOutput(item),
    ]),
  );
  return value.type === "run_started" && value.workProfile === undefined
    ? { ...projected, workProfile: "standard" }
    : projected;
}

function projectNodeEvidenceOwner(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "evidence" && isRecord(item) && item.kind === "agent"
        ? projectAgentEvidence(item)
        : projectPublicRunOutput(item),
    ]),
  );
}

function projectRunState(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "capabilitySnapshot" && isRecord(item)) {
        return [key, projectCapabilitySnapshot(item)];
      }
      if (key === "nodes" && isRecord(item)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(item).map(([nodeId, node]) => [
              nodeId,
              isRecord(node) ? projectNodeEvidenceOwner(node) : projectPublicRunOutput(node),
            ]),
          ),
        ];
      }
      return [key, projectPublicRunOutput(item)];
    }),
  );
}

function projectAgentEvidence(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "semanticReceipts" && Array.isArray(item)
        ? item.map((receipt) => projectSemanticReceipt(receipt))
        : projectPublicRunOutput(item),
    ]),
  );
}

function projectSemanticReceipt(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.result)) {
    return null;
  }
  const projected = pick(value, [
    "version",
    "sequence",
    "requestDigest",
    "projectDigest",
    "sourceDigest",
    "languageServerDigest",
    "sandbox",
    "resultDigest",
    "digest",
  ]);
  projected.operation = value.request.operation;
  projected.itemCount = semanticResultItemCount(value.result);
  return projected;
}

function semanticResultItemCount(value: Readonly<Record<string, unknown>>): number {
  if (value.operation === "diagnostics") {
    return Array.isArray(value.diagnostics) ? value.diagnostics.length : 0;
  }
  if (value.operation === "definition" || value.operation === "references") {
    return Array.isArray(value.locations) ? value.locations.length : 0;
  }
  return value.operation === "hover" && value.hover !== null ? 1 : 0;
}

function projectCapabilitySnapshot(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "packages") {
        return [key, projectPackages(item)];
      }
      if (key === "activations") {
        return [key, projectActivations(item)];
      }
      if (key === "effectiveHarness") {
        return [key, projectEffectiveHarness(item)];
      }
      if (key === "languageServer") {
        return [key, projectLanguageServer(item)];
      }
      if (key === "goalWorkspace") {
        return [key, projectGoalWorkspace(item)];
      }
      return [key, item];
    }),
  );
}

function projectGoalWorkspace(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== "goal-workspace-revision") {
    return null;
  }
  const projected = pick(value, [
    "version",
    "kind",
    "revision",
    "previousDigest",
    "at",
    "objective",
    "digest",
  ]);
  projected.facts = projectGoalEntries(value.facts);
  projected.invariants = projectGoalEntries(value.invariants);
  projected.verifiedFacts = projectGoalVerifiedFacts(value.verifiedFacts);
  projected.openQuestions = projectGoalEntries(value.openQuestions);
  projected.nextAction = isRecord(value.nextAction) ? pick(value.nextAction, ["id", "text"]) : null;
  return projected;
}

function projectGoalEntries(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((entry) => (isRecord(entry) ? pick(entry, ["id", "text"]) : null))
    : null;
}

function projectGoalVerifiedFacts(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((fact) => {
        if (!isRecord(fact)) return null;
        const projected = pick(fact, ["id", "text"]);
        projected.evidence = Array.isArray(fact.evidence)
          ? fact.evidence.map((reference) =>
              isRecord(reference)
                ? pick(reference, ["runId", "nodeId", "attempt", "sequence", "eventDigest"])
                : null,
            )
          : null;
        return projected;
      })
    : null;
}

function projectLanguageServer(value: unknown): unknown {
  if (!isRecord(value)) {
    return null;
  }
  const projected = pick(value, [
    "version",
    "kind",
    "name",
    "protocol",
    "languages",
    "containmentProfile",
    "requestTimeoutMs",
    "digest",
  ]);
  if (isRecord(value.executable)) {
    projected.executable = pick(value.executable, ["sha256", "bytes"]);
  }
  if (isRecord(value.manifest)) {
    projected.manifest = pick(value.manifest, ["provenance", "sha256", "bytes"]);
  }
  return projected;
}

function projectEffectiveHarness(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== "effective-harness-runtime") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "workflow") {
        return [key, omitContentBase64(item)];
      }
      if (key === "supplementalMemory" && Array.isArray(item)) {
        return [key, item.map((entry) => omitContentBase64(entry))];
      }
      if (key === "supplementalMemoryRelationships") {
        return [key, projectSupplementalMemoryRelationships(item)];
      }
      return [key, item];
    }),
  );
}

function projectSupplementalMemoryRelationships(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.assessment)) return null;
  const projected = pick(value.assessment, [
    "relationshipCount",
    "evidenceReferenceCount",
    "unresolvedContradictionCount",
    "relationshipSetDigest",
  ]);
  if (Object.hasOwn(value.assessment, "digest")) {
    projected.assessmentDigest = value.assessment.digest;
  }
  return projected;
}

function projectPackages(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((item) =>
        isRecord(item) && item.kind === "agent-skill" ? projectAgentSkillPackage(item) : item,
      )
    : value;
}

function projectActivations(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((item) =>
        isRecord(item) &&
        (item.kind === "agent-skill-activation" || item.kind === "agent-skill-package-activation")
          ? projectAgentSkillActivation(item)
          : item,
      )
    : value;
}

function projectAgentSkillPackage(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "files" && Array.isArray(item) ? item.map((file) => omitContentBase64(file)) : item,
    ]),
  );
}

function projectAgentSkillActivation(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "workflow") {
        return [key, omitContentBase64(item)];
      }
      if (key === "skill" && isRecord(item)) {
        return [key, projectAgentSkillPackage(item)];
      }
      return [key, item];
    }),
  );
}

function omitContentBase64(value: unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "contentBase64"))
    : value;
}

function pick(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeEvidenceEvent(value: Readonly<Record<string, unknown>>): boolean {
  return value.type === "node_succeeded" || value.type === "node_failed";
}

function isRunState(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.runId === "string" &&
    typeof value.workflowId === "string" &&
    typeof value.lastSequence === "number" &&
    isRecord(value.nodes)
  );
}
