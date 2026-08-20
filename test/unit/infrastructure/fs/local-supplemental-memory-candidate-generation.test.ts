import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { completeSupplementalMemoryCandidateGeneration } from "../../../../src/domain/adaptation/supplemental-memory-candidate-generation.js";
import { MAX_TUNING_EVIDENCE_BYTES } from "../../../../src/domain/evaluation/tuning-evidence.js";
import { publishLocalPromptCandidate } from "../../../../src/infrastructure/fs/local-prompt-candidate-publisher.js";
import {
  admitLocalSupplementalMemoryCandidate,
  admitLocalSupplementalMemoryCandidateGenerationSources,
} from "../../../../src/infrastructure/fs/local-supplemental-memory-candidate.js";
import { supplementalMemoryCandidateGenerationFixture } from "../../../fixtures/supplemental-memory-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("local supplemental-memory candidate generation", () => {
  it("stably admits tuning evidence, publishes once, and reopens the generated candidate", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-generation-")));
    temporaryDirectories.push(root);
    const fixture = supplementalMemoryCandidateGenerationFixture();
    const evidencePath = join(root, "tuning-evidence.json");
    const outputPath = join(root, "generated-memory.candidate.json");
    await writeFile(evidencePath, JSON.stringify(fixture.evidence));

    const admittedSources = await admitLocalSupplementalMemoryCandidateGenerationSources(
      outputPath,
      [evidencePath],
    );
    expect(admittedSources).toMatchObject({
      root,
      outputPath,
      evidence: [
        {
          provenance: "tuning-evidence.json",
          sourcePath: evidencePath,
          packet: { evidenceDigest: fixture.evidence.evidenceDigest },
        },
      ],
    });

    const prepared = fixture.prepared;
    const source = completeSupplementalMemoryCandidateGeneration(
      prepared,
      JSON.stringify({ value: "Use the reviewed fixture before changing output." }),
      {
        inputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        costUsdMicros: 1,
      },
    );
    const sourceText = `${JSON.stringify(source, null, 2)}\n`;
    await admittedSources.revalidate();
    await publishLocalPromptCandidate(outputPath, sourceText, {
      beforePublish: admittedSources.revalidate,
    });

    expect(await readFile(outputPath, "utf8")).toBe(sourceText);
    const admittedCandidate = await admitLocalSupplementalMemoryCandidate(outputPath, {
      resolveBaseline: async () => fixture.baseline,
    });
    expect(admittedCandidate).toMatchObject({
      identity: {
        generation: { provider: "test", model: "deterministic" },
      },
      state: {
        supplementalMemory: [expect.objectContaining({ id: "reviewed-fixture" })],
      },
    });
  });

  it("rejects escaped, linked, and changed evidence without publishing output", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-generation-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-evidence-outside-")));
    temporaryDirectories.push(root, outside);
    const fixture = supplementalMemoryCandidateGenerationFixture();
    const outputPath = join(root, "generated-memory.candidate.json");
    const outsideEvidence = join(outside, "evidence.json");
    const linkedEvidence = join(root, "linked-evidence.json");
    const evidencePath = join(root, "tuning-evidence.json");
    const evidenceText = JSON.stringify(fixture.evidence);
    await writeFile(outsideEvidence, evidenceText);
    await writeFile(evidencePath, evidenceText);
    await symlink(outsideEvidence, linkedEvidence);

    await expect(
      admitLocalSupplementalMemoryCandidateGenerationSources(outputPath, [outsideEvidence]),
    ).rejects.toThrowError(/escape|path/i);
    await expect(
      admitLocalSupplementalMemoryCandidateGenerationSources(outputPath, [linkedEvidence]),
    ).rejects.toThrowError(/link|regular/i);

    const admitted = await admitLocalSupplementalMemoryCandidateGenerationSources(outputPath, [
      evidencePath,
    ]);
    await writeFile(evidencePath, `${evidenceText} `);
    await expect(admitted.revalidate()).rejects.toThrowError(/changed/);
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("accepts the exact evidence byte bound and rejects bound plus one", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-generation-")));
    temporaryDirectories.push(root);
    const fixture = supplementalMemoryCandidateGenerationFixture();
    const evidenceText = JSON.stringify(fixture.evidence);
    const exact = `${evidenceText}${" ".repeat(
      MAX_TUNING_EVIDENCE_BYTES - Buffer.byteLength(evidenceText, "utf8"),
    )}`;
    const exactPath = join(root, "exact-evidence.json");
    const overflowPath = join(root, "overflow-evidence.json");
    await writeFile(exactPath, exact);
    await writeFile(overflowPath, `${exact} `);

    await expect(
      admitLocalSupplementalMemoryCandidateGenerationSources(join(root, "exact.candidate.json"), [
        exactPath,
      ]),
    ).resolves.toMatchObject({ evidence: [{ packet: { kind: "flow.tuning-evidence/v1" } }] });
    await expect(
      admitLocalSupplementalMemoryCandidateGenerationSources(
        join(root, "overflow.candidate.json"),
        [overflowPath],
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("preserves cancellation after evidence read and rejects static-memory publication", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-generation-")));
    temporaryDirectories.push(root);
    const fixture = supplementalMemoryCandidateGenerationFixture();
    const evidencePath = join(root, "tuning-evidence.json");
    const outputPath = join(root, "generated-memory.candidate.json");
    await writeFile(evidencePath, JSON.stringify(fixture.evidence));
    const controller = new AbortController();
    const reason = new Error("operator cancelled evidence admission");

    await expect(
      admitLocalSupplementalMemoryCandidateGenerationSources(outputPath, [evidencePath], {
        signal: controller.signal,
        afterEvidenceRead: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    await expect(access(outputPath)).rejects.toThrow();

    const generated = completeSupplementalMemoryCandidateGeneration(
      fixture.prepared,
      JSON.stringify({ value: "Use the reviewed fixture." }),
      {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costUsdMicros: 0,
      },
    );
    const { generation: _generation, ...staticSource } = generated;
    await expect(
      publishLocalPromptCandidate(outputPath, JSON.stringify(staticSource)),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(access(outputPath)).rejects.toThrow();
  });
});
