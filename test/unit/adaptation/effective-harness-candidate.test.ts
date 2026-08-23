import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectEffectiveHarnessCandidate } from "../../../src/application/prepare-effective-harness-candidate.js";
import {
  type ChildSpecialistCandidateIdentity,
  calculateChildSpecialistCandidateDigest,
} from "../../../src/domain/adaptation/child-specialist-candidate.js";
import {
  calculateEffectiveHarnessCandidateDigest,
  createEffectiveHarnessCandidateArtifact,
  EffectiveHarnessCandidateError,
  parseEffectiveHarnessCandidateArtifact,
  projectPhaseRoutingEvaluationState,
} from "../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  calculateEffectiveHarnessStateDigest,
  compileEffectiveHarnessState,
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
  effectiveHarnessWorkflowSource,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import { calculateModelRoutingCandidateDigest } from "../../../src/domain/adaptation/model-routing-candidate.js";
import {
  calculatePromptCandidateIdentityDigest,
  type PromptCandidateIdentity,
} from "../../../src/domain/adaptation/prompt-candidate.js";
import {
  parseSupplementalMemoryCandidateText,
  projectSupplementalMemoryCandidate,
} from "../../../src/domain/adaptation/supplemental-memory-candidate.js";
import {
  calculateCapabilitySnapshotDigest,
  createCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { createWorkflowPackageSnapshot } from "../../../src/domain/capability/workflow-packages.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { agentSkillActivationInput } from "../../fixtures/agent-skill-activation.js";
import { agentSkillPackageActivationFixture } from "../../fixtures/agent-skill-package-activation.js";
import { childSpecialistCandidateFixture } from "../../fixtures/child-specialist-candidate.js";
import { modelRoutingCandidateFixture } from "../../fixtures/model-routing-candidate.js";
import { phaseRoutingCandidateFixture } from "../../fixtures/phase-routing-candidate.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const scopeDigest = "a".repeat(64);

describe("effective harness candidate artifacts", () => {
  it("stores and reparses one exact supplemental-memory surface", () => {
    const fixture = agentSkillActivationInput("baseline");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.workflowSource,
      packages: [fixture.skill],
    });
    const content = "Remember the reviewed integration fixture.";
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
    const memory = projectSupplementalMemoryCandidate({
      manifestProvenance: "memory.candidate.json",
      sourceSha256: sha256(sourceText),
      source: parseSupplementalMemoryCandidateText(sourceText, "memory.candidate.json"),
      baseline,
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest,
        workflowId: baseline.workflowId,
        generation: 2,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baseline.stateDigest,
      }),
      baselineState: baseline,
      candidateState: memory.state,
      candidate: memory.identity,
    });

    expect(parseEffectiveHarnessCandidateArtifact(structuredClone(artifact))).toEqual(artifact);
    expect(artifact).toMatchObject({
      surface: "supplemental-memory",
      candidate: {
        kind: "supplemental-memory-candidate",
        scope: { agentNodeId: "review", entryId: "reviewed-integration" },
        change: {
          kind: "add",
          before: null,
          after: {
            bytes: Buffer.byteLength(content, "utf8"),
            sha256: sha256(content),
          },
        },
      },
    });
  });

  it("stores and reparses one exact child-specialist surface", () => {
    const fixture = childSpecialistCandidateFixture("skills");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.baselineText,
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
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest,
        workflowId: baseline.workflowId,
        generation: 2,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baseline.stateDigest,
      }),
      baselineState: baseline,
      candidateState: projected.state,
      candidate: fixture.projected.identity,
    });

    expect(parseEffectiveHarnessCandidateArtifact(structuredClone(artifact))).toEqual(artifact);
    expect(artifact).toMatchObject({
      surface: "child-specialist",
      candidate: {
        kind: "child-specialist-candidate",
        scope: { childNodeId: "delegate-review", agentNodeId: "review" },
        change: {
          kind: "skills",
          before: ["review-checklist"],
          after: ["review-checklist", "security-checklist"],
        },
      },
    });
  });

  it.each([
    [
      "parent metadata",
      (document: ChildSpecialistMutationDocument) => {
        document.root.metadata.description = "PRIVATE_PARENT_METADATA";
      },
    ],
    [
      "parent budget",
      (document: ChildSpecialistMutationDocument) => {
        document.root.budget.maxModelTokens += 1;
      },
    ],
    [
      "sibling child instructions",
      (document: ChildSpecialistMutationDocument) => {
        childAgent(document.child, "security-reference").prompt = "PRIVATE_SIBLING_PROMPT";
      },
    ],
    [
      "target model",
      (document: ChildSpecialistMutationDocument) => {
        childAgent(document.child, "review").model.id = "private-model";
      },
    ],
    [
      "target tools",
      (document: ChildSpecialistMutationDocument) => {
        childAgent(document.child, "review").tools.push("edit");
      },
    ],
    [
      "child result schema",
      (document: ChildSpecialistMutationDocument) => {
        childResult(document.child).schema.maxLength += 1;
      },
    ],
  ] as const)("rejects a fully redigested child-specialist %s substitution", (_label, mutate) => {
    const fixture = childSpecialistCandidateFixture("instructions");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.baselineText,
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
    const changedRoot = JSON.parse(
      effectiveHarnessWorkflowSource(projected.state),
    ) as ChildSpecialistWorkflowDocument;
    const selectedChild = changedRoot.nodes.find((node) => node.id === "delegate-review")?.child;
    if (selectedChild?.workflow === undefined) {
      throw new Error("child-specialist mutation fixture has no embedded child");
    }
    const changedChild = JSON.parse(selectedChild.workflow) as ChildSpecialistChildDocument;
    mutate({ root: changedRoot, child: changedChild });
    selectedChild.workflow = JSON.stringify(changedChild);
    const changedState = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: JSON.stringify(changedRoot),
      packages: fixture.packages,
    });
    const { candidateDigest: _candidateDigest, ...identity } = fixture.projected.identity;
    const changedIdentity = {
      ...identity,
      projectedWorkflow: {
        sourceSha256: changedState.workflow.sha256,
        workflowDigest: changedState.workflow.workflowDigest,
      },
    };

    expect(() =>
      createEffectiveHarnessCandidateArtifact({
        baselineHead: createEffectiveHarnessHeadIdentity({
          scopeDigest,
          workflowId: baseline.workflowId,
          generation: 2,
          activationDigest: "b".repeat(64),
          transitionDigest: "c".repeat(64),
          stateDigest: baseline.stateDigest,
        }),
        baselineState: baseline,
        candidateState: changedState,
        candidate: {
          ...changedIdentity,
          candidateDigest: calculateChildSpecialistCandidateDigest(changedIdentity),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "surface_mismatch" }));
  });

  it.each([
    [
      "baseline workflow source hash",
      (identity: MutableChildSpecialistIdentity) => {
        identity.baseline.workflow.sourceSha256 = "0".repeat(64);
      },
    ],
    [
      "baseline workflow digest",
      (identity: MutableChildSpecialistIdentity) => {
        identity.baseline.workflow.workflowDigest = "0".repeat(64);
      },
    ],
    [
      "baseline child source hash",
      (identity: MutableChildSpecialistIdentity) => {
        identity.baseline.child.sourceSha256 = "0".repeat(64);
      },
    ],
    [
      "baseline child workflow digest",
      (identity: MutableChildSpecialistIdentity) => {
        identity.baseline.child.workflowDigest = "0".repeat(64);
      },
    ],
    [
      "baseline package closure digest",
      (identity: MutableChildSpecialistIdentity) => {
        identity.baseline.packageClosureDigest = "0".repeat(64);
      },
    ],
    [
      "projected workflow source hash",
      (identity: MutableChildSpecialistIdentity) => {
        identity.projectedWorkflow.sourceSha256 = "0".repeat(64);
      },
    ],
    [
      "projected workflow digest",
      (identity: MutableChildSpecialistIdentity) => {
        identity.projectedWorkflow.workflowDigest = "0".repeat(64);
      },
    ],
    [
      "baseline instruction byte count",
      (identity: MutableChildSpecialistIdentity) => {
        if (identity.change.kind !== "instructions") throw new Error("expected instructions");
        identity.change.before.bytes += 1;
      },
    ],
    [
      "candidate instruction byte count",
      (identity: MutableChildSpecialistIdentity) => {
        if (identity.change.kind !== "instructions") throw new Error("expected instructions");
        identity.change.after.bytes += 1;
      },
    ],
  ] as const)("rejects a redigested child-specialist %s identity", (_label, mutate) => {
    const fixture = childSpecialistCandidateFixture("instructions");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: fixture.baselineText,
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
    const artifact = structuredClone(
      createEffectiveHarnessCandidateArtifact({
        baselineHead: createEffectiveHarnessHeadIdentity({
          scopeDigest,
          workflowId: baseline.workflowId,
          generation: 2,
          activationDigest: "b".repeat(64),
          transitionDigest: "c".repeat(64),
          stateDigest: baseline.stateDigest,
        }),
        baselineState: baseline,
        candidateState: projected.state,
        candidate: fixture.projected.identity,
      }),
    );
    const identity = artifact.candidate as MutableChildSpecialistIdentity;
    mutate(identity);
    const { candidateDigest: _candidateDigest, ...identityContent } = identity;
    identity.candidateDigest = calculateChildSpecialistCandidateDigest(identityContent);
    (artifact as unknown as { artifactDigest: string }).artifactDigest =
      calculateEffectiveHarnessCandidateDigest(artifact);

    expect(() => parseEffectiveHarnessCandidateArtifact(artifact)).toThrowError(
      expect.objectContaining({ code: "surface_mismatch" }),
    );
  });

  it("stores and reparses one exact model-routing surface", () => {
    const source = promptActivationInput({ selection: "baseline" }).source;
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: source,
      packages: [],
    });
    const routing = modelRoutingCandidateFixture(source);
    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "model-routing",
        projection: routing,
        baselineWorkflowSource: source,
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest,
        workflowId: baseline.workflowId,
        generation: 2,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baseline.stateDigest,
      }),
      baselineState: baseline,
      candidateState: projected.state,
      candidate: routing.identity,
    });

    expect(parseEffectiveHarnessCandidateArtifact(structuredClone(artifact))).toEqual(artifact);
    expect(artifact).toMatchObject({
      surface: "model-routing",
      candidate: {
        kind: "model-routing-candidate",
        route: {
          before: { provider: "test", id: "deterministic", thinking: "medium" },
          after: { provider: "openai", id: "gpt-5.4", thinking: "high" },
        },
      },
    });
  });

  it("stores and reparses one exact phase-routing surface", () => {
    const source = promptActivationInput({ selection: "baseline" }).source;
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: source,
      packages: [],
    });
    const routing = phaseRoutingCandidateFixture(source);
    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: {
        kind: "phase-routing",
        projection: routing,
        baselineWorkflowSource: source,
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest,
        workflowId: baseline.workflowId,
        generation: 2,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baseline.stateDigest,
      }),
      baselineState: baseline,
      candidateState: projected.state,
      candidate: routing.identity,
    });

    expect(parseEffectiveHarnessCandidateArtifact(structuredClone(artifact))).toEqual(artifact);
    expect(artifact).toMatchObject({
      surface: "phase-routing",
      candidate: {
        kind: "phase-routing-candidate",
        profiles: {
          before: { fallback: "deny", selectionRule: "exact-target-v1" },
          after: { fallback: "deny", selectionRule: "exact-target-v1" },
        },
      },
      candidateState: {
        phaseRoutingProfile: {
          profileDigest: routing.identity.profiles.after.profileDigest,
        },
      },
    });
    const evaluationBaseline = projectPhaseRoutingEvaluationState(artifact, "baseline");
    const evaluationCandidate = projectPhaseRoutingEvaluationState(artifact, "candidate");
    expect(evaluationBaseline).toMatchObject({
      scopeDigest: artifact.baselineState.scopeDigest,
      workflow: artifact.baselineState.workflow,
      packages: artifact.baselineState.packages,
      phaseRoutingProfile: {
        profileDigest: routing.identity.profiles.before.profileDigest,
      },
    });
    expect(evaluationBaseline.stateDigest).not.toBe(artifact.baselineState.stateDigest);
    expect(projectPhaseRoutingEvaluationState(artifact, "baseline")).toEqual(evaluationBaseline);
    expect(evaluationCandidate).toEqual(artifact.candidateState);
  });

  it("rejects fully redigested model-routing state outside the declared route", () => {
    const beforeSkill = agentSkillActivationInput("baseline");
    const afterSkill = agentSkillActivationInput("candidate");
    const source = beforeSkill.workflowSource;
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: source,
      packages: [beforeSkill.skill],
    });
    const routing = modelRoutingCandidateFixture(source, "review");
    const projected = projectEffectiveHarnessCandidate({
      baseline,
      candidate: { kind: "model-routing", projection: routing, baselineWorkflowSource: source },
    });
    const baselineHead = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baseline.workflowId,
      generation: 2,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    });
    const packageChanged = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: effectiveHarnessWorkflowSource(projected.state),
      packages: [afterSkill.skill],
    });
    expect(() =>
      createEffectiveHarnessCandidateArtifact({
        baselineHead,
        baselineState: baseline,
        candidateState: packageChanged,
        candidate: routing.identity,
      }),
    ).toThrowError(expect.objectContaining({ code: "surface_mismatch" }));

    const workflow = JSON.parse(effectiveHarnessWorkflowSource(projected.state)) as {
      nodes: { id: string; agent?: { prompt?: string } }[];
    };
    const target = workflow.nodes.find((node) => node.id === routing.identity.scope.nodeId);
    if (target?.agent === undefined) throw new Error("routing fixture has no target agent");
    target.agent.prompt = "PRIVATE_NON_ROUTE_PROMPT";
    const promptChanged = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: JSON.stringify(workflow),
      packages: [beforeSkill.skill],
    });
    const { candidateDigest: _candidateDigest, ...identityContent } = routing.identity;
    const changedIdentityContent = {
      ...identityContent,
      projectedWorkflow: {
        sourceSha256: promptChanged.workflow.sha256,
        workflowDigest: promptChanged.workflow.workflowDigest,
      },
    };
    const changedIdentity = {
      ...changedIdentityContent,
      candidateDigest: calculateModelRoutingCandidateDigest(changedIdentityContent),
    };
    const error = (() => {
      try {
        createEffectiveHarnessCandidateArtifact({
          baselineHead,
          baselineState: baseline,
          candidateState: promptChanged,
          candidate: changedIdentity,
        });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({ code: "surface_mismatch" });
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE_NON_ROUTE_PROMPT");
  });

  it("stores one exact baseline head, complete state pair, and reviewed candidate", () => {
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
        projection: fixture.projected,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });
    const baselineHead = createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baseline.workflowId,
      generation: 4,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    });

    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead,
      baselineState: baseline,
      candidateState: projected.state,
      candidate: fixture.projected.identity,
    });

    expect(parseEffectiveHarnessCandidateArtifact(structuredClone(artifact))).toEqual(artifact);
    expect(artifact).toMatchObject({
      version: 1,
      kind: "effective-harness-candidate",
      scopeDigest,
      workflowId: baseline.workflowId,
      surface: "agent-skill-package",
      candidate: {
        kind: "agent-skill-package-candidate",
        candidateDigest: fixture.projected.identity.candidateDigest,
      },
      baselineHead,
      baselineState: { stateDigest: baseline.stateDigest },
      candidateState: { stateDigest: projected.state.stateDigest },
      artifactDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(artifact)).toBe(true);
  });

  it("rejects a redigested candidate state that contradicts the reviewed package", () => {
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
        projection: fixture.projected,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });
    const artifact = structuredClone(
      createEffectiveHarnessCandidateArtifact({
        baselineHead: createEffectiveHarnessHeadIdentity({
          scopeDigest,
          workflowId: baseline.workflowId,
          generation: 1,
          activationDigest: "b".repeat(64),
          transitionDigest: "c".repeat(64),
          stateDigest: baseline.stateDigest,
        }),
        baselineState: baseline,
        candidateState: projected.state,
        candidate: fixture.projected.identity,
      }),
    );
    const original = fixture.completed.package;
    const replacement = createCapabilitySnapshot([
      {
        kind: "agent-skill",
        name: original.name,
        description: original.description,
        ...(original.license === undefined ? {} : { license: original.license }),
        ...(original.compatibility === undefined ? {} : { compatibility: original.compatibility }),
        metadata: original.metadata,
        requestedTools: original.requestedTools,
        trust: original.trust,
        provenance: original.provenance,
        files: [{ path: "SKILL.md", content: Buffer.from("# Substituted\n") }],
      },
    ]).packages[0];
    if (replacement === undefined) {
      throw new Error("replacement fixture is missing");
    }
    const mutableState = artifact.candidateState as unknown as {
      packages: typeof artifact.candidateState.packages;
      stateDigest: string;
    };
    mutableState.packages = [replacement];
    mutableState.stateDigest = calculateEffectiveHarnessStateDigest(artifact.candidateState);
    (artifact as unknown as { artifactDigest: string }).artifactDigest =
      calculateEffectiveHarnessCandidateDigest(artifact);

    expect(() => parseEffectiveHarnessCandidateArtifact(artifact)).toThrowError(
      expect.objectContaining<Partial<EffectiveHarnessCandidateError>>({
        code: "surface_mismatch",
      }),
    );
  });

  it("rejects baseline-head and scope substitution without a private cause", () => {
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
        projection: fixture.projected,
        baselineWorkflowSource: fixture.prompt.baselineText,
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest,
        workflowId: baseline.workflowId,
        generation: 1,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baseline.stateDigest,
      }),
      baselineState: baseline,
      candidateState: projected.state,
      candidate: fixture.projected.identity,
    });

    for (const mutate of [
      (value: MutableCandidateArtifact) => {
        (value.baselineHead as unknown as { stateDigest: string }).stateDigest = "d".repeat(64);
      },
      (value: MutableCandidateArtifact) => {
        (value as unknown as { scopeDigest: string }).scopeDigest = "e".repeat(64);
      },
    ]) {
      const changed = structuredClone(artifact);
      mutate(changed);
      (changed as unknown as { artifactDigest: string }).artifactDigest =
        calculateEffectiveHarnessCandidateDigest(changed);
      const error = (() => {
        try {
          parseEffectiveHarnessCandidateArtifact(changed);
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(EffectiveHarnessCandidateError);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("validates prompt changes through the retained workflow-package closure", () => {
    const child = workflowPackage("child", childWorkflow());
    const baselineSource = packagedParentWorkflow("Implement the task carefully.");
    const candidateSource = packagedParentWorkflow("Implement and verify the task carefully.");
    const baseline = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: baselineSource,
      packages: [child],
    });
    const candidateState = createEffectiveHarnessState({
      scopeDigest,
      workflowSource: candidateSource,
      packages: [child],
    });
    const identityWithoutDigest: Omit<PromptCandidateIdentity, "candidateDigest"> = {
      version: 1,
      id: "packaged-prompt",
      candidateVersion: "1.0.0",
      scope: { kind: "workflow", workflowId: baseline.workflowId },
      manifest: { provenance: "candidate.yaml", sourceSha256: "1".repeat(64) },
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: baseline.workflow.sha256,
        workflowDigest: calculateWorkflowDigest(compileEffectiveHarnessState(baseline)),
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
          nodeId: "implement",
          beforeSha256: sha256("Implement the task carefully."),
          afterSha256: sha256("Implement and verify the task carefully."),
        },
      ],
      projectedWorkflow: {
        sourceSha256: candidateState.workflow.sha256,
        workflowDigest: calculateWorkflowDigest(compileEffectiveHarnessState(candidateState)),
      },
    };
    const candidate: PromptCandidateIdentity = {
      ...identityWithoutDigest,
      candidateDigest: calculatePromptCandidateIdentityDigest(identityWithoutDigest),
    };

    expect(() =>
      createEffectiveHarnessCandidateArtifact({
        baselineHead: createEffectiveHarnessHeadIdentity({
          scopeDigest,
          workflowId: baseline.workflowId,
          generation: 1,
          activationDigest: "b".repeat(64),
          transitionDigest: "c".repeat(64),
          stateDigest: baseline.stateDigest,
        }),
        baselineState: baseline,
        candidateState,
        candidate,
      }),
    ).not.toThrow();
  });
});

interface ChildSpecialistWorkflowDocument {
  metadata: { description?: string };
  budget: { maxModelTokens: number };
  nodes: Array<{
    id: string;
    child?: { workflow?: string };
  }>;
}

interface ChildSpecialistChildDocument {
  nodes: Array<{
    id: string;
    agent?: { prompt: string; model: { id: string }; tools: string[] };
    result?: { schema: { maxLength: number } };
  }>;
}

interface ChildSpecialistMutationDocument {
  readonly root: ChildSpecialistWorkflowDocument;
  readonly child: ChildSpecialistChildDocument;
}

function childAgent(child: ChildSpecialistChildDocument, id: string) {
  const agent = child.nodes.find((node) => node.id === id)?.agent;
  if (agent === undefined) throw new Error("child-specialist mutation fixture has no Agent node");
  return agent;
}

function childResult(child: ChildSpecialistChildDocument) {
  const result = child.nodes.find((node) => node.id === "publish")?.result;
  if (result === undefined) throw new Error("child-specialist mutation fixture has no result node");
  return result;
}

type MutableCandidateArtifact = ReturnType<typeof createEffectiveHarnessCandidateArtifact>;

type MutableChildSpecialistIdentity = DeepMutable<ChildSpecialistCandidateIdentity>;

type DeepMutable<Value> = Value extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
    : Value;

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
  description: Reusable ${name} workflow.
spec:
  workflow: |-
${indented}
`),
    },
  });
}

function packagedParentWorkflow(prompt: string): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "packaged-parent" },
    budget: {
      maxNodeStarts: 8,
      maxModelTokens: 1_000,
      maxCostUsd: 1,
      maxExecutionMs: 60_000,
      maxArtifactBytes: 10_000,
    },
    nodes: [
      {
        id: "implement",
        type: "agent",
        dependsOn: [],
        agent: {
          prompt,
          model: { provider: "test", id: "deterministic" },
          tools: [],
          skills: [],
        },
      },
      {
        id: "child",
        type: "child",
        dependsOn: ["implement"],
        child: {
          resultNodeId: "publish",
          package: { name: "child", version: "1.0.0" },
        },
      },
    ],
  });
}

function childWorkflow(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: child }
budget:
  maxNodeStarts: 2
  maxModelTokens: 100
  maxCostUsd: 1
  maxExecutionMs: 60000
  maxArtifactBytes: 10000
nodes:
  - id: collect
    type: command
    command: { executable: /usr/bin/true }
  - id: publish
    type: result
    dependsOn: [collect]
    result:
      source: { nodeId: collect, field: command.stdout }
      schema: { type: boolean }
`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
