import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import {
  promptCandidateGenerationFixture,
  promptCandidateWorkflowText,
  sha256,
} from "../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("prompt candidate generation CLI", () => {
  it("generates one auditable candidate and does not activate it", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor }),
      output.stderr.join("\n"),
    ).toBe(0);

    const source = JSON.parse(await readFile(fixture.outputPath, "utf8"));
    expect(source).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PromptCandidate",
      metadata: { id: "generated-instructions", version: "1.0.0" },
      generation: {
        provider: "test",
        model: "deterministic",
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      changes: {
        prompts: [
          {
            nodeId: "implement",
            value: "Read TASK.md and verify the result.",
          },
        ],
      },
    });
    expect(JSON.parse(output.stdout.join("\n"))).toMatchObject({
      generated: true,
      output: fixture.outputPath,
      candidate: {
        id: "generated-instructions",
        version: "1.0.0",
        provider: "test",
        model: "deterministic",
        changes: ["implement"],
      },
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    await expect(access(join(fixture.root, ".flow", "activations"))).rejects.toThrow();

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
        id: "generated-instructions",
        generation: {
          provider: "test",
          model: "deterministic",
          requestDigest: source.generation.requestDigest,
          responseDigest: source.generation.responseDigest,
        },
      },
    });
  });

  it("keeps private workflow and evaluation data out of the model input", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor }),
      output.stderr.join("\n"),
    ).toBe(0);

    const modelInput =
      executor.execute.mock.calls[0]?.[0].type === "agent"
        ? executor.execute.mock.calls[0][0].agent.prompt
        : "";
    expect(modelInput).toContain("Implement the task.");
    expect(modelInput).not.toContain("private-review");
    expect(modelInput).not.toContain("Review the private result.");
    expect(modelInput).not.toContain("private-holdout-task");
    expect(modelInput).not.toContain("SECRET.md");
    expect(modelInput).not.toContain("private-run");
    expect(modelInput).not.toContain("private-customer-alpha-tuning-evidence.json");
  });

  it("requires the normal evaluation gate before activation", async () => {
    const fixture = await localFixture();
    const generated = capture();
    expect(
      await main(generationArgs(fixture), generated.io, {
        cwd: fixture.root,
        executor: generationExecutor(),
      }),
      generated.stderr.join("\n"),
    ).toBe(0);

    const activation = capture();
    expect(
      await main(
        [
          "candidate",
          "activate",
          fixture.outputPath,
          "--evaluation",
          "missing-evaluation",
          "--evaluations-dir",
          join(fixture.root, "evaluations"),
          "--actor",
          "operator:test",
          "--dry-run",
        ],
        activation.io,
        { cwd: fixture.root },
      ),
    ).toBe(1);
    expect(activation.stderr.join("\n")).toMatch(/not found|missing/i);
    await expect(access(join(fixture.root, ".flow", "activations"))).rejects.toThrow();
  });

  it("preserves an existing output before it calls the model", async () => {
    const fixture = await localFixture();
    await writeFile(fixture.outputPath, "operator-owned\n", "utf8");
    const executor = generationExecutor();
    const output = capture();

    expect(await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor })).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/exists/);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(await readFile(fixture.outputPath, "utf8")).toBe("operator-owned\n");
  });

  it("publishes no output after source drift or invalid model output", async () => {
    const changed = await localFixture();
    const driftExecutor = generationExecutor(async () => {
      await writeFile(changed.baselinePath, `${promptCandidateWorkflowText()}\n`, "utf8");
    });
    const driftOutput = capture();
    expect(
      await main(generationArgs(changed), driftOutput.io, {
        cwd: changed.root,
        executor: driftExecutor,
      }),
    ).toBe(1);
    expect(driftOutput.stderr.join("\n")).toMatch(/changed/);
    await expect(access(changed.outputPath)).rejects.toThrow();

    const invalid = await localFixture();
    const invalidOutput = capture();
    expect(
      await main(generationArgs(invalid), invalidOutput.io, {
        cwd: invalid.root,
        executor: generationExecutor(undefined, "{}"),
      }),
    ).toBe(1);
    expect(invalidOutput.stderr.join("\n")).toMatch(/changes/);
    await expect(access(invalid.outputPath)).rejects.toThrow();
  });

  it("publishes no output when cancellation wins after model execution", async () => {
    const fixture = await localFixture();
    const controller = new AbortController();
    const executor = generationExecutor(async () => {
      controller.abort(new Error("candidate generation was cancelled"));
    });
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, {
        cwd: fixture.root,
        executor,
        signal: controller.signal,
      }),
    ).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/cancelled/);
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("rejects duplicate evidence before it calls the model", async () => {
    const fixture = await localFixture();
    const duplicatePath = join(fixture.root, "same-packet-under-another-name.json");
    await writeFile(duplicatePath, await readFile(fixture.evidencePath));
    const args = generationArgs(fixture);
    args.splice(4, 0, duplicatePath);
    const executor = generationExecutor();
    const output = capture();

    expect(await main(args, output.io, { cwd: fixture.root, executor })).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/source identities|evidence digests/i);
    expect(executor.execute).not.toHaveBeenCalled();
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });
});

function generationExecutor(
  afterInput?: () => Promise<void>,
  response = JSON.stringify({
    changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
  }),
): NodeExecutor & { execute: ReturnType<typeof vi.fn<NodeExecutor["execute"]>> } {
  return {
    execute: vi.fn<NodeExecutor["execute"]>(async (node) => {
      if (node.type !== "agent") {
        throw new Error("prompt generation used a non-agent node");
      }
      expect(node.agent.tools).toEqual([]);
      expect(node.agent.skills).toEqual([]);
      expect(node.agent.toolPackages).toEqual([]);
      await afterInput?.();
      return { status: "succeeded", evidence: generationEvidence(response) };
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

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-candidate-cli-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".flow"));
  await writeFile(
    join(root, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
    "utf8",
  );
  const baselinePath = join(root, "baseline.workflow.yaml");
  const evidencePath = join(root, "private-customer-alpha-tuning-evidence.json");
  const outputPath = join(root, "generated.prompt-candidate.yaml");
  const generation = promptCandidateGenerationFixture();
  await writeFile(baselinePath, promptCandidateWorkflowText(), "utf8");
  await writeFile(evidencePath, `${JSON.stringify(generation.evidence)}\n`, "utf8");
  return { root, baselinePath, evidencePath, outputPath };
}

function generationArgs(fixture: Awaited<ReturnType<typeof localFixture>>): string[] {
  return [
    "candidate",
    "generate",
    fixture.baselinePath,
    fixture.evidencePath,
    "--output",
    fixture.outputPath,
    "--id",
    "generated-instructions",
    "--version",
    "1.0.0",
    "--allow-nodes",
    "implement",
    "--provider",
    "test",
    "--model",
    "deterministic",
  ];
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
