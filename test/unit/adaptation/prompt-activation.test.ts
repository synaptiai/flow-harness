import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  calculatePromptActivationDigest,
  createPromptActivationSnapshot,
  MAX_PROMPT_ACTIVATION_SOURCE_BYTES,
  parsePromptActivationLocator,
  parsePromptActivationSnapshot,
} from "../../../src/domain/adaptation/prompt-activation.js";
import { calculatePromptCandidateIdentityDigest } from "../../../src/domain/adaptation/prompt-candidate.js";
import { validateCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import { bindWorkflowCapabilities } from "../../../src/domain/capability/workflow-capabilities.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import {
  baselinePromptActivationSource,
  projectedPromptActivationSource,
  promptActivationInput,
} from "../../fixtures/prompt-activation.js";

describe("prompt activation snapshots", () => {
  it("parses only an exact active workflow locator", () => {
    expect(parsePromptActivationLocator("activation:adaptive-workflow")).toEqual({
      workflowId: "adaptive-workflow",
    });
    expect(parsePromptActivationLocator("workflow.yaml")).toBeNull();
    expect(parsePromptActivationLocator("workflow:release-check@1.0.0")).toBeNull();

    for (const value of [
      "activation:",
      "activation:Adaptive",
      "activation:adaptive-workflow@1.0.0",
      "activation:adaptive_workflow",
    ]) {
      expect(() => parsePromptActivationLocator(value)).toThrow(/activation:<workflow-id>/);
    }
  });

  it("creates one deterministic snapshot for an exact evaluated projection", () => {
    const input = promptActivationInput();

    const first = createPromptActivationSnapshot(input);
    const second = createPromptActivationSnapshot(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      kind: "prompt-activation",
      selection: "candidate",
      workflowId: "adaptive-workflow",
      candidateId: "better-instructions",
      candidateVersion: "1.0.0",
      source: {
        bytes: Buffer.byteLength(projectedPromptActivationSource, "utf8"),
        sha256: sha256(projectedPromptActivationSource),
        contentBase64: Buffer.from(projectedPromptActivationSource, "utf8").toString("base64"),
      },
    });
    expect(first.activationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a separate exact baseline selection", () => {
    const activation = createPromptActivationSnapshot(
      promptActivationInput({ selection: "baseline" }),
    );

    expect(activation).toMatchObject({
      selection: "baseline",
      workflowId: "adaptive-workflow",
      source: {
        bytes: Buffer.byteLength(baselinePromptActivationSource, "utf8"),
        sha256: sha256(baselinePromptActivationSource),
      },
    });
    expect(activation.source.sha256).toBe(activation.candidate.baseline.sourceSha256);
    expect(activation.activationDigest).not.toBe(
      createPromptActivationSnapshot(promptActivationInput()).activationDigest,
    );
  });

  it("rejects a redigested source that contradicts its compiled workflow digest", () => {
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const tampered = structuredClone(snapshot) as DeepMutable<typeof snapshot>;
    const changedSource = projectedPromptActivationSource.replace(
      "verify the result",
      "publish the result",
    );
    const changedPrompt = "Read TASK.md and publish the result.";

    tampered.source.bytes = Buffer.byteLength(changedSource, "utf8");
    tampered.source.sha256 = sha256(changedSource);
    tampered.source.contentBase64 = Buffer.from(changedSource, "utf8").toString("base64");
    tampered.candidate.projectedWorkflow.sourceSha256 = tampered.source.sha256;
    const change = requiredFirst(tampered.candidate.changes, "candidate change");
    change.afterSha256 = sha256(changedPrompt);
    const { candidateDigest: _candidateDigest, ...candidateContent } = tampered.candidate;
    tampered.candidate.candidateDigest = calculatePromptCandidateIdentityDigest(candidateContent);
    tampered.activationDigest = calculatePromptActivationDigest(tampered);

    expect(() => parsePromptActivationSnapshot(tampered)).toThrowError(/workflow digest/);
  });

  it("names the baseline selection when its compiled workflow digest changes", () => {
    const snapshot = createPromptActivationSnapshot(
      promptActivationInput({ selection: "baseline" }),
    );
    const tampered = structuredClone(snapshot) as DeepMutable<typeof snapshot>;
    const changedSource = baselinePromptActivationSource.replace(
      "Implement the task.",
      "Implement and verify the task.",
    );

    tampered.source.bytes = Buffer.byteLength(changedSource, "utf8");
    tampered.source.sha256 = sha256(changedSource);
    tampered.source.contentBase64 = Buffer.from(changedSource, "utf8").toString("base64");
    tampered.candidate.baseline.sourceSha256 = tampered.source.sha256;
    const change = requiredFirst(tampered.candidate.changes, "candidate change");
    change.beforeSha256 = sha256("Implement and verify the task.");
    const { candidateDigest: _candidateDigest, ...candidateContent } = tampered.candidate;
    tampered.candidate.candidateDigest = calculatePromptCandidateIdentityDigest(candidateContent);
    tampered.activationDigest = calculatePromptActivationDigest(tampered);

    expect(() => parsePromptActivationSnapshot(tampered)).toThrowError(/baseline selection/);
  });

  it("rejects comparison pairs that cannot fit in the declared trial count", () => {
    const snapshot = createPromptActivationSnapshot(promptActivationInput());
    const tampered = structuredClone(snapshot) as DeepMutable<typeof snapshot>;

    tampered.evaluation.scheduledTrials = 2;
    tampered.evaluation.committedTrials = 2;
    tampered.activationDigest = calculatePromptActivationDigest(tampered);

    expect(() => parsePromptActivationSnapshot(tampered)).toThrowError(/trial count/);
  });

  it("rejects incomplete proof, malformed source bytes, and outer digest changes", () => {
    const snapshot = createPromptActivationSnapshot(promptActivationInput());

    const incomplete = structuredClone(snapshot) as DeepMutable<typeof snapshot>;
    incomplete.evaluation.committedTrials -= 1;
    incomplete.activationDigest = calculatePromptActivationDigest(incomplete);
    expect(() => parsePromptActivationSnapshot(incomplete)).toThrowError(/must be complete/);

    const malformed = structuredClone(snapshot) as DeepMutable<typeof snapshot>;
    malformed.source.contentBase64 = "%";
    expect(() => parsePromptActivationSnapshot(malformed)).toThrowError(/canonical base64/);

    const redigested = structuredClone(snapshot) as DeepMutable<typeof snapshot>;
    redigested.activationDigest = "f".repeat(64);
    expect(() => parsePromptActivationSnapshot(redigested)).toThrowError(/digest does not match/);
  });

  it("rejects activation source content above the durable limit", () => {
    expect(() =>
      createPromptActivationSnapshot({
        ...promptActivationInput(),
        source: "x".repeat(MAX_PROMPT_ACTIVATION_SOURCE_BYTES + 1),
      }),
    ).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
  });

  it("accepts a valid activation source at the exact durable limit", () => {
    const input = promptActivationInput();
    const source = `${input.source}${" ".repeat(
      MAX_PROMPT_ACTIVATION_SOURCE_BYTES - Buffer.byteLength(input.source, "utf8"),
    )}`;
    const candidateWithoutDigest = {
      ...input.candidate,
      projectedWorkflow: {
        ...input.candidate.projectedWorkflow,
        sourceSha256: sha256(source),
      },
    };
    const { candidateDigest: _candidateDigest, ...candidateContent } = candidateWithoutDigest;

    const snapshot = createPromptActivationSnapshot({
      ...input,
      candidate: {
        ...candidateWithoutDigest,
        candidateDigest: calculatePromptCandidateIdentityDigest(candidateContent),
      },
      source,
    });

    expect(snapshot.source.bytes).toBe(MAX_PROMPT_ACTIVATION_SOURCE_BYTES);
    expect(validateCapabilitySnapshot(activationCapabilitySnapshot(snapshot))).toMatchObject({
      activations: [{ activationDigest: snapshot.activationDigest }],
    });
  });

  it("persists one activation without a selected capability package", () => {
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const snapshot = activationCapabilitySnapshot(activation);

    expect(validateCapabilitySnapshot(snapshot)).toEqual(snapshot);
  });

  it("binds an activation snapshot to the exact compiled root workflow", () => {
    const activation = createPromptActivationSnapshot(promptActivationInput());
    const snapshot = activationCapabilitySnapshot(activation);
    const workflow = compileWorkflowText(projectedPromptActivationSource, "active prompt workflow");

    expect(bindWorkflowCapabilities(workflow, snapshot)).toEqual(snapshot);

    const baselineActivation = createPromptActivationSnapshot(
      promptActivationInput({ selection: "baseline" }),
    );
    const baselineSnapshot = activationCapabilitySnapshot(baselineActivation);
    const baselineWorkflow = compileWorkflowText(
      baselinePromptActivationSource,
      "baseline prompt workflow",
    );
    expect(bindWorkflowCapabilities(baselineWorkflow, baselineSnapshot)).toEqual(baselineSnapshot);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function activationCapabilitySnapshot(
  activation: ReturnType<typeof createPromptActivationSnapshot>,
) {
  const packages: never[] = [];
  const activations = [activation];
  return {
    version: 1 as const,
    packages,
    activations,
    digest: sha256(
      JSON.stringify({
        version: 1,
        packages,
        activations: [
          {
            workflowId: activation.workflowId,
            candidateId: activation.candidateId,
            candidateVersion: activation.candidateVersion,
            digest: activation.activationDigest,
          },
        ],
      }),
    ),
  };
}

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function requiredFirst<Item>(items: readonly Item[], label: string): Item {
  const item = items[0];
  if (item === undefined) {
    throw new Error(`${label} fixture is missing`);
  }
  return item;
}
