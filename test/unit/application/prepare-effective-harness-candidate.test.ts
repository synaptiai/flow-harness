import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  EffectiveHarnessCandidateAdmissionError,
  loadEffectiveHarnessCandidateBaseline,
  projectEffectiveHarnessCandidate,
} from "../../../src/application/prepare-effective-harness-candidate.js";
import { createAgentSkillActivationSnapshot } from "../../../src/domain/adaptation/agent-skill-activation.js";
import {
  calculateAgentSkillCandidateIdentityDigest,
  type ProjectedAgentSkillCandidate,
} from "../../../src/domain/adaptation/agent-skill-candidate.js";
import type { ProjectedAgentSkillPackageCandidate } from "../../../src/domain/adaptation/agent-skill-package-candidate.js";
import {
  createEffectiveHarnessState,
  effectiveHarnessWorkflowSource,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  calculatePromptCandidateIdentityDigest,
  type ProjectedPromptCandidate,
  parsePromptCandidateIdentity,
} from "../../../src/domain/adaptation/prompt-candidate.js";
import {
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
} from "../../../src/domain/adaptation/supplemental-memory-candidate.js";
import {
  type AgentSkillCapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import {
  createWorkflowPackageSnapshot,
  workflowPackageSource,
} from "../../../src/domain/capability/workflow-packages.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { agentSkillActivationInput } from "../../fixtures/agent-skill-activation.js";
import { agentSkillPackageActivationFixture } from "../../fixtures/agent-skill-package-activation.js";
import { childSpecialistCandidateFixture } from "../../fixtures/child-specialist-candidate.js";
import { modelRoutingCandidateFixture } from "../../fixtures/model-routing-candidate.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const scopeDigest = "a".repeat(64);

describe("effective harness candidate baseline admission", () => {
  it("captures one exact active head and its complete state", async () => {
    const activation = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    const store = activeStore(activation, {
      workflowId: activation.workflowId,
      generation: 7,
      activationDigest: activation.activationDigest,
      lastTransitionDigest: "b".repeat(64),
    });

    const baseline = await loadEffectiveHarnessCandidateBaseline({
      scopeDigest,
      workflowId: activation.workflowId,
      store,
    });

    expect(store.loadActive).toHaveBeenCalledTimes(1);
    expect(baseline.activation).toEqual(activation);
    expect(baseline.state.packages).toEqual([activation.skill]);
    expect(baseline.head).toMatchObject({
      scopeDigest,
      workflowId: activation.workflowId,
      generation: 7,
      activationDigest: activation.activationDigest,
      transitionDigest: "b".repeat(64),
      stateDigest: baseline.state.stateDigest,
      headDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects a snapshot that does not match the observed active head", async () => {
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const store = activeStore(activation, {
      workflowId: activation.workflowId,
      generation: 1,
      activationDigest: "c".repeat(64),
      lastTransitionDigest: "d".repeat(64),
    });

    const error = await loadEffectiveHarnessCandidateBaseline({
      scopeDigest,
      workflowId: activation.workflowId,
      store,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EffectiveHarnessCandidateAdmissionError);
    expect(error).toMatchObject({ code: "stale_baseline" });
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain(activation.activationDigest);
  });

  it("rejects cross-workflow substitution before state projection", async () => {
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const store = activeStore(activation, {
      workflowId: "different-workflow",
      generation: 1,
      activationDigest: activation.activationDigest,
      lastTransitionDigest: "d".repeat(64),
    });

    await expect(
      loadEffectiveHarnessCandidateBaseline({
        scopeDigest,
        workflowId: activation.workflowId,
        store,
      }),
    ).rejects.toBeInstanceOf(EffectiveHarnessCandidateAdmissionError);
  });

  it("preserves exact cancellation before and after the active-state read", async () => {
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const beforeReason = new Error("before active baseline");
    const before = AbortSignal.abort(beforeReason);
    const beforeStore = activeStore(activation, currentHead(activation));

    await expect(
      loadEffectiveHarnessCandidateBaseline({
        scopeDigest,
        workflowId: activation.workflowId,
        store: beforeStore,
        signal: before,
      }),
    ).rejects.toBe(beforeReason);
    expect(beforeStore.loadActive).not.toHaveBeenCalled();

    const afterReason = new Error("after active baseline");
    const controller = new AbortController();
    const afterStore = {
      loadActive: vi.fn(async () => {
        controller.abort(afterReason);
        return { snapshot: activation, head: currentHead(activation) };
      }),
    };
    await expect(
      loadEffectiveHarnessCandidateBaseline({
        scopeDigest,
        workflowId: activation.workflowId,
        store: afterStore,
        signal: controller.signal,
      }),
    ).rejects.toBe(afterReason);
  });

  it("rejects an unrelated supplemental package before candidate projection", async () => {
    const activation = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    const extra = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: "unused",
        description: "Unselected package.",
        metadata: {},
        requestedTools: [],
        trust: "project-explicit",
        provenance: ".flow/skills/unused",
        files: [{ path: "SKILL.md", content: Buffer.from("# Unused\n") }],
      },
    ]).packages[0];
    if (extra === undefined) {
      throw new Error("supplemental fixture is missing");
    }

    await expect(
      loadEffectiveHarnessCandidateBaseline({
        scopeDigest,
        workflowId: activation.workflowId,
        store: activeStore(activation, currentHead(activation)),
        supplementalPackages: [extra],
      }),
    ).rejects.toMatchObject({ code: "incomplete_closure" });
  });
});

describe("effective harness candidate projection", () => {
  it("composes one supplemental-memory entry while retaining prior effective state", () => {
    const fixture = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.workflowSource,
      packages: [fixture.skill],
    });
    const memory = memoryProjectionFor(baseline, "Remember the reviewed integration fixture.");

    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: { kind: "supplemental-memory", projection: memory },
    });

    expect(projected.delta).toEqual({
      surface: "supplemental-memory",
      candidateKind: "supplemental-memory-candidate",
      candidateDigest: memory.identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
      afterStateDigest: memory.state.stateDigest,
    });
    expect(projected.state).toEqual(memory.state);
    expect(effectiveHarnessWorkflowSource(projected.state)).toBe(
      effectiveHarnessWorkflowSource(baseline),
    );
    expect(projected.state.packages).toEqual(baseline.packages);
  });

  it("rebases one child-specialist axis while retaining prior effective state", () => {
    const fixture = childSpecialistCandidateFixture("instructions");
    const currentSource = JSON.parse(fixture.baselineText) as {
      metadata: { description?: string };
    };
    currentSource.metadata.description = "Previously activated harness description.";
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: JSON.stringify(currentSource),
      packages: fixture.packages,
    });

    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "child-specialist",
        projection: fixture.projected,
        baselineWorkflowSource: fixture.baselineText,
      },
    });

    expect(projected.delta).toEqual({
      surface: "child-specialist",
      candidateKind: "child-specialist-candidate",
      candidateDigest: fixture.projected.identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
      afterStateDigest: projected.state.stateDigest,
    });
    expect(projected.state.packages).toEqual(baseline.packages);
    const source = JSON.parse(effectiveHarnessWorkflowSource(projected.state)) as {
      metadata: { description?: string };
      nodes: { id: string; child?: { workflow?: string } }[];
    };
    expect(source.metadata.description).toBe("Previously activated harness description.");
    const selected = source.nodes.find((node) => node.id === "delegate-review");
    const child = JSON.parse(selected?.child?.workflow ?? "null") as {
      nodes: { id: string; agent?: { prompt?: string } }[];
    };
    expect(child.nodes.find((node) => node.id === "review")?.agent?.prompt).toBe(
      "Review the implementation and identify unsupported claims.",
    );
  });

  it("rebases one reviewed model route while retaining composed prompt and package state", () => {
    const skill = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: skill.workflowSource,
      packages: [skill.skill],
    });
    const routing = modelRoutingCandidateFixture(skill.workflowSource, "review");

    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "model-routing",
        projection: routing,
        baselineWorkflowSource: skill.workflowSource,
      },
    });

    expect(projected.delta).toEqual({
      surface: "model-routing",
      candidateKind: "model-routing-candidate",
      candidateDigest: routing.identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
      afterStateDigest: projected.state.stateDigest,
    });
    expect(projected.state.packages).toEqual(baseline.packages);
    expect(effectiveHarnessWorkflowSource(projected.state)).toContain('"provider":"openai"');
    const compiled = compileWorkflowText(
      effectiveHarnessWorkflowSource(projected.state),
      "projected-state.json",
    );
    expect(compiled.nodes.find((node) => node.id === "review")).toMatchObject({
      type: "agent",
      agent: {
        model: { provider: "openai", id: "gpt-5.4", thinking: "high" },
      },
    });
  });

  it("retains a skill through prompt projection and the prompt through skill projection", () => {
    const skill = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: skill.workflowSource,
      packages: [skill.skill],
    });
    const promptProjection = promptProjectionFor(baseline, "Use the refined review prompt.");

    expect(parsePromptCandidateIdentity(promptProjection.identity)).toEqual(
      promptProjection.identity,
    );
    expect(promptProjection.identity).toMatchObject({
      scope: { workflowId: baseline.workflowId },
      baseline: {
        sourceSha256: baseline.workflow.sha256,
        workflowDigest: baseline.workflow.workflowDigest,
      },
      projectedWorkflow: {
        sourceSha256: promptProjection.workflow.sourceSha256,
        workflowDigest: promptProjection.workflow.workflowDigest,
      },
    });
    expect(calculateWorkflowDigest(promptProjection.workflow.compiled)).toBe(
      promptProjection.workflow.workflowDigest,
    );
    const directState = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: promptProjection.workflow.source,
      packages: baseline.packages,
    });
    expect(directState.workflow.workflowDigest).toBe(promptProjection.workflow.workflowDigest);
    expect(directState.stateDigest).not.toBe(baseline.stateDigest);
    const normalizedPrompt = structuredClone(promptProjection.workflow.compiled);
    const normalizedNode = normalizedPrompt.nodes.find((node) => node.id === "review");
    const baselineCompiled = compileWorkflowText(
      effectiveHarnessWorkflowSource(baseline),
      "active-state.json",
    );
    const baselineNode = baselineCompiled.nodes.find((node) => node.id === "review");
    if (normalizedNode?.type !== "agent" || baselineNode?.type !== "agent") {
      throw new Error("review node is not an agent");
    }
    (normalizedNode.agent as { prompt: string }).prompt = baselineNode.agent.prompt;
    expect(normalizedPrompt).toEqual(baselineCompiled);
    expect(
      isDeepStrictEqual(
        JSON.parse(JSON.stringify(normalizedPrompt)),
        JSON.parse(JSON.stringify(baselineCompiled)),
      ),
    ).toBe(true);

    const afterPrompt = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "prompt",
        projection: promptProjection,
        baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
      },
    });

    expect(afterPrompt.delta).toEqual({
      surface: "prompt",
      candidateKind: "prompt-candidate",
      candidateDigest: promptProjection.identity.candidateDigest,
      beforeStateDigest: baseline.stateDigest,
      afterStateDigest: afterPrompt.state.stateDigest,
    });
    expect(afterPrompt.state.packages).toEqual(baseline.packages);
    expect(effectiveHarnessWorkflowSource(afterPrompt.state)).toContain(
      "Use the refined review prompt.",
    );

    const skillProjection = skillProjectionFor(baseline);
    const afterSkill = projectEffectiveHarnessCandidate({
      baseline: afterPrompt.state,
      candidate: {
        kind: "agent-skill-resource",
        projection: skillProjection,
        baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
      },
    });

    expect(effectiveHarnessWorkflowSource(afterSkill.state)).toBe(
      effectiveHarnessWorkflowSource(afterPrompt.state),
    );
    expect(afterSkill.state.packages).toHaveLength(1);
    expect(afterSkill.state.packages[0]).toEqual(
      skillProjection.candidateCapabilitySnapshot.packages[0],
    );
    expect(afterSkill.state.stateDigest).not.toBe(afterPrompt.state.stateDigest);
  });

  it("rejects a redigested prompt candidate that also changes immutable controls", () => {
    const skill = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: skill.workflowSource,
      packages: [skill.skill],
    });
    const projection = structuredClone(
      promptProjectionFor(baseline, "Use the refined review prompt."),
    ) as MutablePromptProjection;
    const workflow = JSON.parse(projection.workflow.source) as {
      budget: { maxCostUsd: number };
    };
    workflow.budget.maxCostUsd = 2;
    projection.workflow.source = JSON.stringify(workflow);
    projection.workflow.sourceSha256 = sha256(projection.workflow.source);
    projection.workflow.compiled = compileWorkflowText(
      projection.workflow.source,
      "candidate.yaml",
    );
    projection.workflow.workflowDigest = calculateWorkflowDigest(projection.workflow.compiled);
    const { candidateDigest: _discarded, ...identity } = projection.identity;
    projection.identity = {
      ...identity,
      projectedWorkflow: {
        sourceSha256: projection.workflow.sourceSha256,
        workflowDigest: projection.workflow.workflowDigest,
      },
      candidateDigest: calculatePromptCandidateIdentityDigest({
        ...identity,
        projectedWorkflow: {
          sourceSha256: projection.workflow.sourceSha256,
          workflowDigest: projection.workflow.workflowDigest,
        },
      }),
    };

    expect(() =>
      projectEffectiveHarnessCandidate({
        baseline,
        candidate: {
          kind: "prompt",
          projection,
          baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessCandidateAdmissionError>>({
        code: "surface_mismatch",
      }),
    );
  });

  it("adds one generated Agent Skill package without changing other controls", () => {
    const fixture = agentSkillPackageActivationFixture();
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.prompt.baselineText,
      packages: [],
    });

    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "agent-skill-package",
        projection: fixture.projected as ProjectedAgentSkillPackageCandidate,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });

    expect(projected.delta).toMatchObject({
      surface: "agent-skill-package",
      candidateKind: "agent-skill-package-candidate",
      candidateDigest: fixture.projected.identity.candidateDigest,
    });
    expect(projected.state.packages).toEqual([fixture.completed.package]);
    expect(effectiveHarnessWorkflowSource(projected.state)).toBe(fixture.projected.workflow.source);
  });

  it("preserves packaged-root identity while updating an Agent Skill resource", () => {
    const ordinaryBaseline = agentSkillActivationInput("baseline");
    const ordinaryCandidate = agentSkillActivationInput("candidate");
    const root = workflowPackage("adaptive-root", ordinaryBaseline.workflowSource);
    const rootPackage = { name: root.name, version: root.version, digest: root.digest };
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: workflowPackageSource(root),
      rootPackage,
      packages: [ordinaryBaseline.skill, root],
    });
    const compiled = compileWorkflowText(ordinaryBaseline.workflowSource, "baseline.workflow.yaml");
    const baselineCapabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [ordinaryBaseline.skill],
      digest: calculateCapabilitySnapshotDigest([ordinaryBaseline.skill]),
    }) as AgentSkillCapabilitySnapshot;
    const candidateCapabilitySnapshot = validateCapabilitySnapshot({
      version: 1,
      packages: [ordinaryCandidate.skill],
      digest: calculateCapabilitySnapshotDigest([ordinaryCandidate.skill]),
    }) as AgentSkillCapabilitySnapshot;
    const projection: ProjectedAgentSkillCandidate = {
      identity: ordinaryCandidate.candidate,
      workflow: {
        sourceSha256: sha256(ordinaryBaseline.workflowSource),
        workflowDigest: calculateWorkflowDigest(compiled),
        compiled,
      },
      baselineCapabilitySnapshot,
      candidateCapabilitySnapshot,
    };

    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "agent-skill-resource",
        projection,
        baselineWorkflowSource: ordinaryBaseline.workflowSource,
      },
    });

    expect(projected.state.rootPackage).toEqual(rootPackage);
    expect(projected.state.packages).toEqual([ordinaryCandidate.skill, root]);
  });

  it.each([
    ["prompt then generated package", ["prompt", "package"] as const],
    ["generated package then prompt", ["package", "prompt"] as const],
  ])("rebases only the declared surface for %s", (_label, order) => {
    const fixture = agentSkillPackageActivationFixture();
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.prompt.baselineText,
      packages: [],
    });
    const prompt = promptProjectionFor(
      baseline,
      "Use the refined implementation prompt.",
      "implement",
    );
    let state = baseline;

    for (const surface of order) {
      state = projectEffectiveHarnessCandidate({
        baseline: state,
        candidate:
          surface === "prompt"
            ? {
                kind: "prompt",
                projection: prompt,
                baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
              }
            : {
                kind: "agent-skill-package",
                projection: fixture.projected as ProjectedAgentSkillPackageCandidate,
                baselineWorkflowSource: fixture.prompt.baselineText,
              },
      }).state;
    }

    expect(effectiveHarnessWorkflowSource(state)).toContain(
      "Use the refined implementation prompt.",
    );
    expect(state.packages).toEqual([fixture.completed.package]);
  });

  it("rejects a stale second change to each already-changed surface", () => {
    const skill = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: skill.workflowSource,
      packages: [skill.skill],
    });
    const prompt = promptProjectionFor(baseline, "Use the refined review prompt.");
    const afterPrompt = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "prompt",
        projection: prompt,
        baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
      },
    }).state;
    expect(() =>
      projectEffectiveHarnessCandidate({
        baseline: afterPrompt,
        candidate: {
          kind: "prompt",
          projection: prompt,
          baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "surface_mismatch" }));

    const resource = skillProjectionFor(baseline);
    const afterResource = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "agent-skill-resource",
        projection: resource,
        baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
      },
    }).state;
    expect(() =>
      projectEffectiveHarnessCandidate({
        baseline: afterResource,
        candidate: {
          kind: "agent-skill-resource",
          projection: resource,
          baselineWorkflowSource: effectiveHarnessWorkflowSource(baseline),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "surface_mismatch" }));

    const fixture = agentSkillPackageActivationFixture();
    const packageBaseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.prompt.baselineText,
      packages: [],
    });
    const packageCandidate = {
      kind: "agent-skill-package" as const,
      projection: fixture.projected,
      baselineWorkflowSource: fixture.prompt.baselineText,
    };
    const afterPackage = projectEffectiveHarnessCandidate({
      baseline: packageBaseline,
      candidate: packageCandidate,
    }).state;
    expect(() =>
      projectEffectiveHarnessCandidate({ baseline: afterPackage, candidate: packageCandidate }),
    ).toThrowError(expect.objectContaining({ code: "surface_mismatch" }));
  });
});

function currentHead(activation: {
  readonly workflowId: string;
  readonly activationDigest: string;
}) {
  return {
    workflowId: activation.workflowId,
    generation: 1,
    activationDigest: activation.activationDigest,
    lastTransitionDigest: "b".repeat(64),
  };
}

function activeStore(
  activation: { readonly workflowId: string; readonly activationDigest: string },
  head: ReturnType<typeof currentHead>,
) {
  return { loadActive: vi.fn(async () => ({ snapshot: activation, head })) };
}

function promptProjectionFor(
  baseline: ReturnType<typeof createEffectiveHarnessState>,
  replacement: string,
  nodeId = "review",
): ProjectedPromptCandidate {
  const baselineSource = effectiveHarnessWorkflowSource(baseline);
  const sourceValue = JSON.parse(baselineSource) as {
    nodes: Array<{ id: string; type: string; agent?: { prompt: string } }>;
  };
  const agent = sourceValue.nodes.find((node) => node.type === "agent" && node.id === nodeId);
  if (agent?.agent === undefined) {
    throw new Error("baseline prompt fixture is missing its review agent");
  }
  const before = agent.agent.prompt;
  agent.agent.prompt = replacement;
  const source = JSON.stringify(sourceValue);
  const compiled = compileWorkflowText(source, "candidate.yaml");
  const identityWithoutDigest = {
    version: 1 as const,
    id: "better-review-prompt",
    candidateVersion: "1.0.0",
    scope: { kind: "workflow" as const, workflowId: baseline.workflowId },
    manifest: { provenance: "candidate.yaml", sourceSha256: "1".repeat(64) },
    baseline: {
      provenance: "active-state.json",
      sourceSha256: baseline.workflow.sha256,
      workflowDigest: baseline.workflow.workflowDigest,
    },
    evidence: [
      {
        provenance: "tuning.json",
        sourceSha256: "2".repeat(64),
        evidenceDigest: "3".repeat(64),
        planDigest: "4".repeat(64),
      },
    ],
    changes: [
      {
        nodeId,
        beforeSha256: sha256(before),
        afterSha256: sha256(replacement),
      },
    ],
    projectedWorkflow: {
      sourceSha256: sha256(source),
      workflowDigest: calculateWorkflowDigest(compiled),
    },
  };
  return {
    identity: {
      ...identityWithoutDigest,
      candidateDigest: calculatePromptCandidateIdentityDigest(identityWithoutDigest),
    },
    workflow: {
      source,
      sourceSha256: sha256(source),
      compiled,
      workflowDigest: calculateWorkflowDigest(compiled),
    },
  };
}

function memoryProjectionFor(
  baseline: ReturnType<typeof createEffectiveHarnessState>,
  content: string,
) {
  const sourceText = JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SupplementalMemoryCandidate",
    metadata: { id: "remember-integration", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-memory",
      workflowId: baseline.workflowId,
      childPath: [],
      agentNodeId: "review",
      entryId: "reviewed-integration",
    },
    baseline: {
      stateDigest: baseline.stateDigest,
      workflowDigest: baseline.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(baseline.packages),
    },
    change: { kind: "add", value: content },
  });
  return projectSupplementalMemoryCandidate({
    manifestProvenance: "memory.candidate.json",
    sourceSha256: sha256(sourceText),
    source: parseSupplementalMemoryCandidateText(sourceText, "memory.candidate.json"),
    baseline,
  });
}

function skillProjectionFor(
  baseline: ReturnType<typeof createEffectiveHarnessState>,
): ProjectedAgentSkillCandidate {
  const fixture = agentSkillActivationInput();
  const baselineSkill = baseline.packages.find(
    (item) => item.kind === "agent-skill" && item.name === fixture.skill.name,
  );
  if (baselineSkill?.kind !== "agent-skill") {
    throw new Error("effective baseline is missing its review skill");
  }
  const candidateSkill = fixture.skill;
  const baselineSnapshot = validateCapabilitySnapshot({
    version: 1,
    packages: [baselineSkill],
    digest: calculateCapabilitySnapshotDigest([baselineSkill]),
  }) as AgentSkillCapabilitySnapshot;
  const candidateSnapshot = validateCapabilitySnapshot({
    version: 1,
    packages: [candidateSkill],
    digest: calculateCapabilitySnapshotDigest([candidateSkill]),
  }) as AgentSkillCapabilitySnapshot;
  const { candidateDigest: _discarded, ...fixtureIdentity } = fixture.candidate;
  const identityWithoutDigest = {
    ...fixtureIdentity,
    baseline: {
      workflow: {
        provenance: "active-state.json",
        sourceSha256: baseline.workflow.sha256,
        workflowDigest: baseline.workflow.workflowDigest,
      },
      skill: {
        name: baselineSkill.name,
        provenance: baselineSkill.provenance,
        packageDigest: baselineSkill.digest,
        capabilityDigest: baselineSnapshot.digest,
      },
    },
    projectedSkill: {
      packageDigest: candidateSkill.digest,
      capabilityDigest: candidateSnapshot.digest,
    },
  };
  const source = effectiveHarnessWorkflowSource(baseline);
  const compiled = compileWorkflowText(source, "active-state.json");
  return {
    identity: {
      ...identityWithoutDigest,
      candidateDigest: calculateAgentSkillCandidateIdentityDigest(identityWithoutDigest),
    },
    workflow: {
      sourceSha256: baseline.workflow.sha256,
      workflowDigest: baseline.workflow.workflowDigest,
      compiled,
    },
    baselineCapabilitySnapshot: baselineSnapshot,
    candidateCapabilitySnapshot: candidateSnapshot,
  };
}

type MutablePromptProjection = {
  -readonly [Key in keyof ProjectedPromptCandidate]: Key extends "workflow"
    ? {
        -readonly [Field in keyof ProjectedPromptCandidate["workflow"]]: ProjectedPromptCandidate["workflow"][Field];
      }
    : ProjectedPromptCandidate[Key];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workflowPackage(name: string, workflow: string) {
  const indented = workflow
    .trim()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return createWorkflowPackageSnapshot({
    kind: "workflow-package",
    trust: "project-explicit",
    provenance: `.flow/workflows/${name}`,
    manifest: {
      content: Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: WorkflowPackage
metadata:
  name: ${name}
  version: 1.0.0
  description: Packaged effective root.
spec:
  workflow: |-
${indented}
`),
    },
  });
}
