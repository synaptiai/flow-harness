import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import {
  createPromptActivationSnapshot,
  promptActivationSource,
} from "../../../src/domain/adaptation/prompt-activation.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../src/domain/workflow/digest.js";
import { admitLocalEffectiveHarnessCandidate } from "../../../src/infrastructure/fs/local-effective-harness-candidate.js";
import { LocalPromptActivationStore } from "../../../src/infrastructure/fs/local-prompt-activation-store.js";
import { promptActivationInput } from "../../fixtures/prompt-activation.js";
import { promptCandidateTuningEvidence } from "../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("supplemental-memory candidate generation CLI", () => {
  it("generates one inert candidate from the active harness without public content disclosure", async () => {
    const fixture = await localFixture();
    const privateValue = "PRIVATE_GENERATED_MEMORY_VALUE";
    const executor = generationExecutor(privateValue);
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor }),
      output.stderr.join("\n"),
    ).toBe(0);

    const sourceText = await readFile(fixture.outputPath, "utf8");
    const source = JSON.parse(sourceText);
    expect(source).toMatchObject({
      kind: "SupplementalMemoryCandidate",
      metadata: { id: "generated-memory", version: "1.0.0" },
      scope: {
        workflowId: "adaptive-workflow",
        childPath: [],
        agentNodeId: "implement",
        entryId: "reviewed-fixture",
      },
      change: { kind: "add", value: privateValue },
      generation: {
        provider: "test",
        model: "deterministic",
        operation: "add",
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const publicOutput = output.stdout.join("\n");
    expect(JSON.parse(publicOutput)).toMatchObject({
      generated: true,
      output: fixture.outputPath,
      candidate: {
        kind: "supplemental-memory-candidate",
        id: "generated-memory",
        version: "1.0.0",
        operation: "add",
        provider: "test",
        model: "deterministic",
      },
    });
    expectContentFree(publicOutput, privateValue, fixture.privateEvidenceCanary);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    await expect(access(join(fixture.root, ".flow", "effective-harness"))).rejects.toThrow();

    const validation = capture();
    expect(
      await main(["candidate", "validate", fixture.outputPath], validation.io, {
        cwd: fixture.root,
      }),
      validation.stderr.join("\n"),
    ).toBe(0);
    expect(JSON.parse(validation.stdout.join("\n"))).toMatchObject({
      valid: true,
      candidate: {
        kind: "supplemental-memory-candidate",
        generation: { provider: "test", model: "deterministic" },
      },
    });
    expectContentFree(validation.stdout.join("\n"), privateValue, fixture.privateEvidenceCanary);

    const composition = capture();
    expect(
      await main(["candidate", "compose", fixture.outputPath], composition.io, {
        cwd: fixture.root,
      }),
      composition.stderr.join("\n"),
    ).toBe(0);
    const composed = JSON.parse(composition.stdout.join("\n"));
    expect(composed).toMatchObject({
      composed: true,
      candidate: {
        surface: "supplemental-memory",
        candidate: {
          kind: "supplemental-memory-candidate",
          generation: { provider: "test", model: "deterministic" },
        },
      },
      staged: {
        path: expect.stringMatching(/^\.flow\/effective-harness\/artifacts\/[a-f0-9]{64}\.json$/),
      },
    });
    expectContentFree(composition.stdout.join("\n"), privateValue, fixture.privateEvidenceCanary);
    await Promise.all([rm(fixture.outputPath), rm(fixture.evidencePath)]);
    const staged = await admitLocalEffectiveHarnessCandidate(
      join(fixture.root, composed.staged.path),
    );
    expect(staged.artifact.candidate).toMatchObject({
      kind: "supplemental-memory-candidate",
      generation: { provider: "test", model: "deterministic" },
    });
    expect(staged.artifact.candidateState.supplementalMemory).toEqual([
      expect.objectContaining({
        id: "reviewed-fixture",
        contentBase64: Buffer.from(privateValue).toString("base64"),
      }),
    ]);
  });

  it("rejects mixed candidate authority before model execution or publication", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor("Unused private value.");
    const output = capture();

    expect(
      await main([...generationArgs(fixture), "--allow-nodes", "implement"], output.io, {
        cwd: fixture.root,
        executor,
      }),
    ).toBe(2);
    expect(output.stderr.join("\n")).toContain("candidate generation mode requires exactly one");
    expect(executor.execute).not.toHaveBeenCalled();
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(access(join(fixture.root, ".flow", "effective-harness"))).rejects.toThrow();
  });

  it("preserves late cancellation and publishes no candidate or activation", async () => {
    const fixture = await localFixture();
    const cancellation = new AbortController();
    const reason = new Error("operator cancelled memory generation");
    const executor: NodeExecutor = {
      execute: vi.fn<NodeExecutor["execute"]>(async () => {
        cancellation.abort(reason);
        const text = JSON.stringify({ value: "PRIVATE_CANCELLED_MEMORY" });
        return { status: "succeeded", evidence: generationEvidence(text) };
      }),
    };
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, {
        cwd: fixture.root,
        executor,
        signal: cancellation.signal,
      }),
    ).toBe(1);
    expect(output.stderr).toEqual([reason.message]);
    expect(output.stdout).toEqual([]);
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(access(join(fixture.root, ".flow", "effective-harness"))).rejects.toThrow();
  });

  it("rejects an active-harness change during generation before publication", async () => {
    const fixture = await localFixture();
    const executor: NodeExecutor = {
      execute: vi.fn<NodeExecutor["execute"]>(async () => {
        const store = new LocalPromptActivationStore(fixture.root);
        const snapshot = createPromptActivationSnapshot(
          promptActivationInput({ candidateId: "changed-instructions", prompt: "Changed prompt." }),
        );
        const baselineSnapshot = createPromptActivationSnapshot(
          promptActivationInput({
            candidateId: "changed-instructions",
            prompt: "Changed prompt.",
            selection: "baseline",
          }),
        );
        const activation = { snapshot, baselineSnapshot, actor: "operator:concurrent" };
        const preview = await store.previewActivate(activation);
        await store.applyActivate({ ...activation, expectedDigest: preview.proposalDigest });
        const text = JSON.stringify({ value: "PRIVATE_STALE_MEMORY" });
        return { status: "succeeded", evidence: generationEvidence(text) };
      }),
    };
    const output = capture();

    expect(await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor })).toBe(1);
    expect(output.stderr.join("\n")).toContain("effective harness changed during generation");
    expect(output.stdout).toEqual([]);
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });
});

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-cli-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".flow"));
  await writeFile(
    join(root, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
  );
  const snapshot = createPromptActivationSnapshot(promptActivationInput());
  const baselineSnapshot = createPromptActivationSnapshot(
    promptActivationInput({ selection: "baseline" }),
  );
  const store = new LocalPromptActivationStore(root);
  const activation = { snapshot, baselineSnapshot, actor: "operator:test" };
  const preview = await store.previewActivate(activation);
  await store.applyActivate({ ...activation, expectedDigest: preview.proposalDigest });
  const privateEvidenceCanary = "PRIVATE_MEMORY_TUNING_EVIDENCE";
  const evidence = promptCandidateTuningEvidence(
    calculateWorkflowDigest(compileWorkflowText(promptActivationSource(snapshot))),
  );
  const evidencePath = join(root, `${privateEvidenceCanary}.json`);
  const outputPath = join(root, "generated-memory.candidate.json");
  await writeFile(evidencePath, JSON.stringify(evidence));
  return { root, evidencePath, outputPath, privateEvidenceCanary };
}

function generationArgs(fixture: Awaited<ReturnType<typeof localFixture>>): string[] {
  return [
    "candidate",
    "generate",
    "adaptive-workflow",
    fixture.evidencePath,
    "--output",
    fixture.outputPath,
    "--id",
    "generated-memory",
    "--version",
    "1.0.0",
    "--memory-entry",
    "reviewed-fixture",
    "--memory-agent",
    "implement",
    "--memory-operation",
    "add",
    "--provider",
    "test",
    "--model",
    "deterministic",
  ];
}

function generationExecutor(
  value: string,
): NodeExecutor & { execute: ReturnType<typeof vi.fn<NodeExecutor["execute"]>> } {
  return {
    execute: vi.fn<NodeExecutor["execute"]>(async (node) => {
      if (node.type !== "agent") throw new Error("generation used a non-agent node");
      expect(node.agent.tools).toEqual([]);
      expect(node.agent.skills).toEqual([]);
      expect(node.agent.toolPackages).toEqual([]);
      const text = JSON.stringify({ value });
      return { status: "succeeded", evidence: generationEvidence(text) };
    }),
  };
}

function generationEvidence(text: string): AgentEvidence {
  return {
    kind: "agent",
    provider: "test",
    model: "deterministic",
    text,
    textHash: sha256(text),
    textTruncated: false,
    durationMs: 5,
    usage: {
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      costUsdMicros: 10,
    },
    activity: { turns: 1, toolCalls: 0, toolErrors: 0 },
    policyDecisions: [],
    effectReceipts: [],
  };
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

function expectContentFree(output: string, ...canaries: readonly string[]): void {
  expect(output).not.toContain("contentBase64");
  for (const canary of canaries) {
    expect(output).not.toContain(canary);
    expect(output).not.toContain(Buffer.from(canary).toString("base64"));
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
