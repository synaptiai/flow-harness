import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeExecutor } from "../../../src/application/ports.js";
import { type CliIo, main } from "../../../src/cli/main.js";
import type { AgentEvidence } from "../../../src/domain/run/events.js";
import {
  agentSkillCandidateGenerationFixture,
  agentSkillGenerationWorkflowText,
  selectedResourceText,
  sha256,
  unrelatedResourceCanary,
} from "../../fixtures/agent-skill-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Agent Skill candidate generation CLI", () => {
  it("generates one auditable ordinary Agent Skill candidate without activation", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();

    expect(
      await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor }),
      output.stderr.join("\n"),
    ).toBe(0);

    const sourceText = await readFile(fixture.outputPath, "utf8");
    const source = JSON.parse(sourceText);
    expect(source).toMatchObject({
      kind: "AgentSkillCandidate",
      metadata: { id: "generated-review", version: "1.0.0" },
      scope: { skillName: "review" },
      changes: {
        resources: [
          {
            path: "references/checklist.md",
            expectedSha256: sha256(selectedResourceText),
            value: "# Review checklist\n\nCheck correctness, security, and evidence.\n",
          },
        ],
      },
      generation: {
        provider: "test",
        model: "deterministic",
        requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const publicOutput = output.stdout.join("\n");
    expect(JSON.parse(publicOutput)).toMatchObject({
      generated: true,
      output: "generated.agent-skill-candidate.yaml",
      candidate: {
        kind: "agent-skill-candidate",
        id: "generated-review",
        version: "1.0.0",
        skill: "review",
        provider: "test",
        model: "deterministic",
        limits: {
          candidates: 1,
          turns: 1,
          maxInputBytes: 1_048_576,
          maxOutputBytes: 65_536,
          maxOutputTokens: 8_192,
          timeoutMs: 300_000,
        },
        usage: {
          inputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
          costUsdMicros: 10,
        },
        changes: ["references/checklist.md"],
      },
    });
    expect(publicOutput).not.toContain(unrelatedResourceCanary);
    expect(publicOutput).not.toContain(Buffer.from(unrelatedResourceCanary).toString("base64"));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    await expect(access(join(fixture.root, ".flow", "activations"))).rejects.toThrow();
    await expect(access(join(fixture.root, ".flow", "evaluations"))).rejects.toThrow();

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
        kind: "agent-skill-candidate",
        generation: {
          provider: "test",
          model: "deterministic",
          requestDigest: source.generation.requestDigest,
        },
      },
    });
  });

  it("keeps unrelated package resources and private paths out of model input and public output", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const output = capture();

    expect(await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor })).toBe(0);
    const modelInput =
      executor.execute.mock.calls[0]?.[0].type === "agent"
        ? executor.execute.mock.calls[0][0].agent.prompt
        : "";
    expect(JSON.parse(modelInput)).toMatchObject({
      targets: [{ path: "references/checklist.md", value: selectedResourceText }],
    });
    expect(modelInput).not.toContain(unrelatedResourceCanary);
    expect(modelInput).not.toContain(fixture.root);
    expect(modelInput).not.toContain("private-customer-tuning.json");
    expect(output.stdout.join("\n")).not.toContain(selectedResourceText);
  });

  it("rejects mixed or incomplete generation modes before model execution", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    for (const extra of [
      ["--allow-nodes", "review"],
      ["--skill", "review"],
      ["--allow-resources", "references/checklist.md"],
    ]) {
      const base = generationArgs(fixture);
      if (extra[0] === "--allow-nodes") {
        base.push(...extra);
      } else if (extra[0] === "--skill") {
        base.splice(base.indexOf("--allow-resources"), 2);
      } else {
        base.splice(base.indexOf("--skill"), 2);
      }
      const output = capture();
      expect(await main(base, output.io, { cwd: fixture.root, executor })).toBe(2);
      expect(output.stderr.join("\n")).toMatch(/generation mode|requires/i);
    }
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each([
    "--allow-nodes",
    "--allow-resources",
    "--id",
    "--max-output-tokens",
    "--model",
    "--output",
    "--provider",
    "--skill",
    "--thinking",
    "--timeout-ms",
    "--version",
  ])("rejects repeated %s before model execution", async (flag) => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const args = generationArgs(fixture);
    const index = args.indexOf(flag);
    if (index < 0) {
      args.push(flag, "duplicate-one", flag, "duplicate-two");
    } else {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error("generation fixture is missing its repeated option value");
      }
      args.push(flag, value);
    }
    const output = capture();

    expect(await main(args, output.io, { cwd: fixture.root, executor })).toBe(2);
    expect(output.stderr[0]).toMatch(new RegExp(`^${flag} may be specified only once\\n`));
    expect(executor.execute).not.toHaveBeenCalled();
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("reports an existing private output with a fixed value-free stage", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor();
    const privateOutputPath = join(fixture.root, "PRIVATE_EXISTING_CANDIDATE.yaml");
    await writeFile(privateOutputPath, "PRIVATE_EXISTING_CONTENT", "utf8");
    const output = capture();

    expect(
      await main(generationArgs({ ...fixture, outputPath: privateOutputPath }), output.io, {
        cwd: fixture.root,
        executor,
      }),
    ).toBe(1);
    expect(output.stderr).toEqual(["output_exists: candidate output already exists"]);
    expect(output.stderr.join("\n")).not.toContain("PRIVATE");
    expect(output.stderr.join("\n")).not.toContain(fixture.root);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("publishes no output when a selected resource changes after model execution", async () => {
    const fixture = await localFixture();
    const executor = generationExecutor(async () => {
      await writeFile(
        join(fixture.root, ".flow", "skills", "review", "references", "checklist.md"),
        `${selectedResourceText}drift\n`,
        "utf8",
      );
    });
    const output = capture();

    expect(await main(generationArgs(fixture), output.io, { cwd: fixture.root, executor })).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/changed/);
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });
});

function generationExecutor(
  afterInput?: () => Promise<void>,
): NodeExecutor & { execute: ReturnType<typeof vi.fn<NodeExecutor["execute"]>> } {
  return {
    execute: vi.fn<NodeExecutor["execute"]>(async (node) => {
      if (node.type !== "agent") {
        throw new Error("Agent Skill generation used a non-agent node");
      }
      expect(node.agent.tools).toEqual([]);
      expect(node.agent.skills).toEqual([]);
      expect(node.agent.toolPackages).toEqual([]);
      await afterInput?.();
      const text = JSON.stringify({
        changes: [
          {
            path: "references/checklist.md",
            value: "# Review checklist\n\nCheck correctness, security, and evidence.\n",
          },
        ],
      });
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

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-agent-skill-cli-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".flow", "skills", "review"), { recursive: true });
  await writeFile(
    join(root, ".flow", "config.yaml"),
    "apiVersion: flow.synapti.ai/v1alpha1\nkind: FlowProjectConfig\n",
    "utf8",
  );
  const { input, skill } = agentSkillCandidateGenerationFixture();
  const baselinePath = join(root, "baseline.workflow.yaml");
  const evidencePath = join(root, "private-customer-tuning.json");
  const outputPath = join(root, "generated.agent-skill-candidate.yaml");
  await writeFile(baselinePath, agentSkillGenerationWorkflowText, "utf8");
  await writeFile(evidencePath, `${JSON.stringify(input.evidence[0]?.packet)}\n`, "utf8");
  for (const file of skill.files) {
    const destination = join(root, skill.provenance, file.path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, Buffer.from(file.contentBase64, "base64"));
  }
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
    "generated-review",
    "--version",
    "1.0.0",
    "--skill",
    "review",
    "--allow-resources",
    "references/checklist.md",
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
