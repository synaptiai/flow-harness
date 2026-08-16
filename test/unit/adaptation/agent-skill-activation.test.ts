import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  AgentSkillActivationError,
  agentSkillActivationWorkflow,
  calculateAgentSkillActivationDigest,
  createAgentSkillActivationSnapshot,
  parseAgentSkillActivationSnapshot,
} from "../../../src/domain/adaptation/agent-skill-activation.js";
import { MAX_PROMPT_ACTIVATION_SOURCE_BYTES } from "../../../src/domain/adaptation/prompt-activation.js";
import {
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../../src/domain/capability/agent-skills.js";
import { bindWorkflowCapabilities } from "../../../src/domain/capability/workflow-capabilities.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import {
  agentSkillActivationInput,
  agentSkillActivationWorkflowSource,
} from "../../fixtures/agent-skill-activation.js";

describe("Agent Skill activation snapshots", () => {
  it("stores one deterministic candidate package with the unchanged evaluated workflow", () => {
    const input = agentSkillActivationInput();

    const first = createAgentSkillActivationSnapshot(input);
    const second = createAgentSkillActivationSnapshot(input);

    expect(first).toEqual(second);
    expect(parseAgentSkillActivationSnapshot(structuredClone(first))).toEqual(first);
    expect(first).toMatchObject({
      version: 1,
      kind: "agent-skill-activation",
      selection: "candidate",
      workflowId: "adaptive-skill-workflow",
      candidateId: "better-review",
      candidateVersion: "1.0.0",
      workflow: {
        bytes: Buffer.byteLength(agentSkillActivationWorkflowSource, "utf8"),
        sha256: sha256(agentSkillActivationWorkflowSource),
        contentBase64: Buffer.from(agentSkillActivationWorkflowSource).toString("base64"),
      },
      skill: {
        kind: "agent-skill",
        name: "review",
        digest: input.candidate.projectedSkill.packageDigest,
      },
    });
    expect(agentSkillActivationWorkflow(first)).toBe(agentSkillActivationWorkflowSource);
    expect(first.activationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores a distinct exact baseline package for rollback", () => {
    const candidate = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    const baseline = createAgentSkillActivationSnapshot(agentSkillActivationInput("baseline"));

    expect(baseline).toMatchObject({
      selection: "baseline",
      skill: {
        name: "review",
        digest: baseline.candidate.baseline.skill.packageDigest,
      },
    });
    expect(baseline.activationDigest).not.toBe(candidate.activationDigest);
    expect(baseline.workflow).toEqual(candidate.workflow);
  });

  it("binds the selected package and activation to one durable capability snapshot", () => {
    const activation = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    const packages = [activation.skill];
    const activations = [activation];
    const snapshot = validateCapabilitySnapshot({
      version: 1,
      packages,
      activations,
      digest: calculateCapabilitySnapshotDigest(packages, activations),
    });
    const workflow = compileWorkflowText(
      agentSkillActivationWorkflowSource,
      "activation:adaptive-skill-workflow",
    );

    expect(snapshot).toMatchObject({
      packages: [{ digest: activation.skill.digest }],
      activations: [{ activationDigest: activation.activationDigest }],
    });
    expect(bindWorkflowCapabilities(workflow, snapshot)).toEqual(snapshot);
  });

  it("rejects a durable activation without its exact selected package", () => {
    const activation = createAgentSkillActivationSnapshot(agentSkillActivationInput());
    expect(() =>
      validateCapabilitySnapshot({
        version: 1,
        packages: [],
        activations: [activation],
        digest: calculateCapabilitySnapshotDigest([], [activation]),
      }),
    ).toThrow(/does not match its selected capability package/i);

    const baseline = createAgentSkillActivationSnapshot(agentSkillActivationInput("baseline"));
    expect(() =>
      validateCapabilitySnapshot({
        version: 1,
        packages: [baseline.skill],
        activations: [activation],
        digest: calculateCapabilitySnapshotDigest([baseline.skill], [activation]),
      }),
    ).toThrow(/does not match its selected capability package/i);
  });

  it.each([
    {
      name: "workflow bytes",
      mutate: (snapshot: MutableActivation) => {
        snapshot.workflow.contentBase64 = Buffer.from("PRIVATE_WORKFLOW").toString("base64");
      },
      code: "identity_mismatch",
    },
    {
      name: "canonical workflow encoding",
      mutate: (snapshot: MutableActivation) => {
        snapshot.workflow.contentBase64 = `${snapshot.workflow.contentBase64}=`;
      },
      code: "invalid_source",
    },
    {
      name: "candidate identity",
      mutate: (snapshot: MutableActivation) => {
        snapshot.candidate.id = "private-candidate";
      },
      code: "identity_mismatch",
    },
    {
      name: "evaluation proof",
      mutate: (snapshot: MutableActivation) => {
        snapshot.evaluation.reportDigest = "f".repeat(64);
      },
      code: "identity_mismatch",
    },
    {
      name: "selected package content",
      mutate: (snapshot: MutableActivation) => {
        const file = snapshot.skill.files[0];
        if (file !== undefined) {
          file.contentBase64 = Buffer.from("PRIVATE_SKILL").toString("base64");
        }
      },
      code: "invalid_schema",
    },
    {
      name: "activation digest",
      mutate: (snapshot: MutableActivation) => {
        snapshot.activationDigest = "f".repeat(64);
      },
      code: "identity_mismatch",
    },
  ])("rejects a $name substitution without disclosing its value", ({ mutate, code }) => {
    const snapshot = structuredClone(
      createAgentSkillActivationSnapshot(agentSkillActivationInput()),
    ) as MutableActivation;
    mutate(snapshot);

    try {
      parseAgentSkillActivationSnapshot(snapshot);
      throw new Error("mutated Agent Skill activation unexpectedly parsed");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentSkillActivationError);
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain("PRIVATE");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([
    {
      name: "top-level workflow identity",
      mutate: (snapshot: MutableActivation) => {
        snapshot.workflowId = "private-workflow";
      },
    },
    {
      name: "top-level candidate id",
      mutate: (snapshot: MutableActivation) => {
        snapshot.candidateId = "private-candidate";
      },
    },
    {
      name: "top-level candidate version",
      mutate: (snapshot: MutableActivation) => {
        snapshot.candidateVersion = "2.0.0";
      },
    },
    {
      name: "valid package from the wrong selection",
      mutate: (snapshot: MutableActivation) => {
        snapshot.skill = structuredClone(
          createAgentSkillActivationSnapshot(agentSkillActivationInput("baseline")).skill,
        ) as MutableActivation["skill"];
      },
    },
  ])("rejects a redigested $name substitution", ({ mutate }) => {
    const snapshot = structuredClone(
      createAgentSkillActivationSnapshot(agentSkillActivationInput()),
    ) as MutableActivation;
    mutate(snapshot);
    snapshot.activationDigest = calculateAgentSkillActivationDigest(snapshot);

    expect(() => parseAgentSkillActivationSnapshot(snapshot)).toThrowError(
      expect.objectContaining({ code: "identity_mismatch" }),
    );
  });

  it("accepts the exact workflow byte limit and rejects one byte above it", () => {
    expect(() =>
      createAgentSkillActivationSnapshot(
        agentSkillActivationInput("candidate", {
          sourceBytes: MAX_PROMPT_ACTIVATION_SOURCE_BYTES,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createAgentSkillActivationSnapshot(
        agentSkillActivationInput("candidate", {
          sourceBytes: MAX_PROMPT_ACTIVATION_SOURCE_BYTES + 1,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
  });
});

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
      : Value;

type MutableActivation = DeepMutable<ReturnType<typeof createAgentSkillActivationSnapshot>>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
