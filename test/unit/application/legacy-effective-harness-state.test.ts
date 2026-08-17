import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  inspectLegacyEffectiveHarnessClosure,
  LegacyEffectiveHarnessStateError,
  materializeLegacyEffectiveHarnessState,
} from "../../../src/application/legacy-effective-harness-state.js";
import { createAgentSkillActivationSnapshot } from "../../../src/domain/adaptation/agent-skill-activation.js";
import { createAgentSkillPackageActivationSnapshot } from "../../../src/domain/adaptation/agent-skill-package-activation.js";
import { effectiveHarnessWorkflowSource } from "../../../src/domain/adaptation/effective-harness-state.js";
import { createPromptActivationSnapshot } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  calculatePromptCandidateIdentityDigest,
  type PromptCandidateIdentity,
} from "../../../src/domain/adaptation/prompt-candidate.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { createPolicyPackageSnapshot } from "../../../src/domain/capability/policy-packages.js";
import type { ToolPackageSnapshotInput } from "../../../src/domain/capability/tool-packages.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { agentSkillActivationInput } from "../../fixtures/agent-skill-activation.js";
import {
  agentSkillPackageActivationFixture,
  agentSkillPackageEvaluationProof,
} from "../../fixtures/agent-skill-package-activation.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";

const scopeDigest = "a".repeat(64);

describe("legacy effective harness state admission", () => {
  it("materializes every package-closed legacy activation without live discovery", () => {
    const promptInput = promptActivationInput();
    const skillInput = agentSkillActivationInput();
    const packageFixture = agentSkillPackageActivationFixture();
    const activations = [
      createPromptActivationSnapshot(promptInput),
      createAgentSkillActivationSnapshot(skillInput),
      createAgentSkillPackageActivationSnapshot({
        selection: "candidate",
        candidate: packageFixture.projected.identity,
        evaluation: agentSkillPackageEvaluationProof(),
        workflowSource: packageFixture.projected.workflow.source,
        skill: packageFixture.completed.package,
      }),
      createAgentSkillPackageActivationSnapshot({
        selection: "baseline",
        candidate: packageFixture.projected.identity,
        evaluation: agentSkillPackageEvaluationProof(),
        workflowSource: packageFixture.prompt.baselineText,
      }),
    ] as const;

    for (const activation of activations) {
      const closure = inspectLegacyEffectiveHarnessClosure({ scopeDigest, activation });

      expect(closure.kind).toBe("closed");
      if (closure.kind !== "closed") {
        throw new Error("closed activation was classified as live-dependent");
      }
      expect(closure.activationDigest).toBe(activation.activationDigest);
      expect(closure.state.workflowId).toBe(activation.workflowId);
      expect(closure.state.packages).toHaveLength(
        "skill" in activation && activation.skill ? 1 : 0,
      );
    }
  });

  it("requires exact supplemental packages before a live-dependent legacy state is composable", () => {
    const activation = toolDependentPromptActivation();
    const tool = toolPackageSnapshot();

    expect(inspectLegacyEffectiveHarnessClosure({ scopeDigest, activation })).toEqual({
      kind: "live-dependent",
      workflowId: activation.workflowId,
      activationDigest: activation.activationDigest,
    });

    const state = materializeLegacyEffectiveHarnessState({
      scopeDigest,
      activation,
      supplementalPackages: [tool],
    });

    expect(state.packages).toEqual([tool]);
    expect(effectiveHarnessWorkflowSource(state)).toBe(promptActivationSourceText(activation));
  });

  it("rejects missing, unrelated, duplicate, and policy supplemental closure", () => {
    const activation = toolDependentPromptActivation();
    const selected = toolPackageSnapshot();
    const unrelated = toolPackageSnapshot("unrelated", "unrelated_tool");
    const selectedSkill = agentSkillActivationInput().skill;
    const policy = createPolicyPackageSnapshot({
      kind: "policy-package",
      trust: "project-explicit",
      provenance: ".flow/policies/private-policy",
      manifest: { content: policyManifest() },
    });

    for (const packages of [[], [unrelated], [selected, unrelated]]) {
      expect(() =>
        materializeLegacyEffectiveHarnessState({
          scopeDigest,
          activation,
          supplementalPackages: packages,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<LegacyEffectiveHarnessStateError>>({
          code: "incomplete_closure",
        }),
      );
    }
    expect(() =>
      materializeLegacyEffectiveHarnessState({
        scopeDigest,
        activation,
        supplementalPackages: [selected, policy],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<LegacyEffectiveHarnessStateError>>({
        code: "invalid_supplement",
      }),
    );

    const skillActivation = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    expect(() =>
      materializeLegacyEffectiveHarnessState({
        scopeDigest,
        activation: skillActivation,
        supplementalPackages: [selectedSkill],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<LegacyEffectiveHarnessStateError>>({
        code: "invalid_supplement",
      }),
    );
  });

  it("keeps legacy parse and closure failures value-free", () => {
    const privateActivation = {
      ...toolDependentPromptActivation(),
      activationDigest: "PRIVATE_ACTIVATION",
    };

    try {
      materializeLegacyEffectiveHarnessState({
        scopeDigest,
        activation: privateActivation,
        supplementalPackages: [],
      });
      throw new Error("private activation unexpectedly materialized");
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyEffectiveHarnessStateError);
      expect((error as Error).message).not.toContain("PRIVATE");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

function toolDependentPromptActivation() {
  const base = promptActivationInput();
  const workflow = JSON.parse(base.source) as {
    metadata: { id: string };
    nodes: Array<{
      type: string;
      agent?: { toolPackages: Array<{ name: string; version: string }> };
    }>;
  };
  const agent = workflow.nodes.find((node) => node.type === "agent")?.agent;
  if (agent === undefined) {
    throw new Error("prompt fixture is missing its agent");
  }
  agent.toolPackages = [{ name: "project-report", version: "1.2.3" }];
  const source = JSON.stringify(workflow);
  const { candidateDigest: _discardedDigest, ...baseCandidate } = base.candidate;
  const candidateWithoutDigest: Omit<PromptCandidateIdentity, "candidateDigest"> = {
    ...baseCandidate,
    projectedWorkflow: {
      sourceSha256: sha256(source),
      workflowDigest: calculateWorkflowDigest(compileWorkflowText(source, "candidate.yaml")),
    },
  };
  const candidate: PromptCandidateIdentity = {
    ...candidateWithoutDigest,
    candidateDigest: calculatePromptCandidateIdentityDigest(candidateWithoutDigest),
  };
  return createPromptActivationSnapshot({ ...base, candidate, source });
}

function promptActivationSourceText(
  activation: ReturnType<typeof toolDependentPromptActivation>,
): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.from(activation.source.contentBase64, "base64"),
  );
}

function toolPackageSnapshot(name = "project-report", toolName = "project_report") {
  const input: ToolPackageSnapshotInput = {
    kind: "tool-package",
    apiVersion: "flow.synapti.ai/v1alpha1",
    name,
    version: "1.2.3",
    description: `Reusable ${name} tool.`,
    trust: "project-explicit",
    provenance: `.flow/tools/${name}`,
    definition: {
      tool: {
        name: toolName,
        description: `Run ${toolName}.`,
        inputs: [{ name: "path", description: "Path to inspect.", type: "string" }],
      },
      driver: {
        kind: "command",
        version: "v1",
        profile: "posix-printf-v1",
        executable: "/usr/bin/printf",
        args: ["%s", "{input:path}"],
        timeoutMs: 10_000,
      },
      permissions: ["process.execute"],
    },
    manifest: {
      content: Buffer.from(
        `apiVersion: flow.synapti.ai/v1alpha1\nkind: ToolPackage\nmetadata: { name: ${name}, version: 1.2.3, description: Reusable ${name} tool. }\nspec:\n  tool:\n    name: ${toolName}\n    description: Run ${toolName}.\n    inputs: [{ name: path, description: Path to inspect., type: string }]\n  driver:\n    kind: command\n    version: v1\n    profile: posix-printf-v1\n    executable: /usr/bin/printf\n    args: ["%s", "{input:path}"]\n    timeoutMs: 10000\n  permissions: [process.execute]\n`,
      ),
    },
  };
  const snapshot = createCapabilitySnapshot([], [], [input]);
  const tool = snapshot.packages[0];
  if (tool?.kind !== "tool-package") {
    throw new Error("tool fixture is missing its package");
  }
  return tool;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function policyManifest(): Buffer {
  return Buffer.from(`apiVersion: flow.synapti.ai/v1alpha1
kind: PolicyPackage
metadata:
  name: private-policy
  version: 1.0.0
  description: Current policy stays outside rollbackable state.
spec:
  commands:
    requireApproval: true
`);
}
