import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectEffectiveHarnessCandidate } from "../../../src/application/prepare-effective-harness-candidate.js";
import {
  calculateEffectiveHarnessCandidateDigest,
  createEffectiveHarnessCandidateArtifact,
  EffectiveHarnessCandidateError,
  parseEffectiveHarnessCandidateArtifact,
} from "../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  calculateEffectiveHarnessStateDigest,
  compileEffectiveHarnessState,
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../src/domain/adaptation/effective-harness-state.js";
import {
  calculatePromptCandidateIdentityDigest,
  type PromptCandidateIdentity,
} from "../../../src/domain/adaptation/prompt-candidate.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { createWorkflowPackageSnapshot } from "../../../src/domain/capability/workflow-packages.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { agentSkillPackageActivationFixture } from "../../fixtures/agent-skill-package-activation.js";
import { modelRoutingCandidateFixture } from "../../fixtures/model-routing-candidate.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const scopeDigest = "a".repeat(64);

describe("effective harness candidate artifacts", () => {
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

type MutableCandidateArtifact = ReturnType<typeof createEffectiveHarnessCandidateArtifact>;

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
