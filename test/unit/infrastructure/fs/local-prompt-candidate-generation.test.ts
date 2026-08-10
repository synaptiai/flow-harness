import {
  access,
  link,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { completePromptCandidateGeneration } from "../../../../src/domain/adaptation/prompt-candidate-generation.js";
import { admitLocalPromptCandidateGenerationSources } from "../../../../src/infrastructure/fs/local-prompt-candidate.js";
import {
  LocalPromptCandidatePublisherError,
  publishLocalPromptCandidate,
} from "../../../../src/infrastructure/fs/local-prompt-candidate-publisher.js";
import {
  promptCandidateGenerationFixture,
  promptCandidateWorkflowText,
} from "../../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local prompt candidate generation", () => {
  it("admits stable baseline and tuning sources relative to the output", async () => {
    const fixture = await localFixture();

    const admitted = await admitLocalPromptCandidateGenerationSources(
      fixture.outputPath,
      fixture.baselinePath,
      [fixture.evidencePath],
    );

    expect(admitted).toMatchObject({
      outputPath: fixture.outputPath,
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourcePath: fixture.baselinePath,
        sourceText: promptCandidateWorkflowText(),
      },
      evidence: [
        {
          provenance: "tuning-evidence.json",
          sourcePath: fixture.evidencePath,
          packet: { kind: "flow.tuning-evidence/v1" },
        },
      ],
    });
    await expect(admitted.revalidate()).resolves.toBeUndefined();
  });

  it("rejects linked, escaped, and changed generation sources", async () => {
    const fixture = await localFixture();
    const linkedBaseline = join(fixture.root, "linked.workflow.yaml");
    await symlink(fixture.baselinePath, linkedBaseline);
    await expect(
      admitLocalPromptCandidateGenerationSources(fixture.outputPath, linkedBaseline, [
        fixture.evidencePath,
      ]),
    ).rejects.toThrowError(/symbolic link/);

    const outside = await mkdtemp(join(tmpdir(), "flow-generation-outside-"));
    temporaryDirectories.push(outside);
    const outsideEvidence = join(outside, "evidence.json");
    await writeFile(outsideEvidence, await readFile(fixture.evidencePath));
    await expect(
      admitLocalPromptCandidateGenerationSources(fixture.outputPath, fixture.baselinePath, [
        outsideEvidence,
      ]),
    ).rejects.toThrowError(/escapes/);

    const admitted = await admitLocalPromptCandidateGenerationSources(
      fixture.outputPath,
      fixture.baselinePath,
      [fixture.evidencePath],
    );
    await writeFile(fixture.baselinePath, `${promptCandidateWorkflowText()}\n`);
    await expect(admitted.revalidate()).rejects.toThrowError(/changed/);
  });

  it("rejects invalid UTF-8 source bytes", async () => {
    const invalidBaseline = await localFixture();
    await writeFile(invalidBaseline.baselinePath, Buffer.from([0xc3, 0x28]));
    await expect(
      admitLocalPromptCandidateGenerationSources(
        invalidBaseline.outputPath,
        invalidBaseline.baselinePath,
        [invalidBaseline.evidencePath],
      ),
    ).rejects.toThrowError(/UTF-8/);

    const invalidEvidence = await localFixture();
    await writeFile(invalidEvidence.evidencePath, Buffer.from([0xc3, 0x28]));
    await expect(
      admitLocalPromptCandidateGenerationSources(
        invalidEvidence.outputPath,
        invalidEvidence.baselinePath,
        [invalidEvidence.evidencePath],
      ),
    ).rejects.toThrowError(/UTF-8/);
  });

  it("publishes one complete candidate and does not overwrite any existing entry", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();

    await publishLocalPromptCandidate(fixture.outputPath, sourceText);
    expect(await readFile(fixture.outputPath, "utf8")).toBe(sourceText);

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, `${sourceText}\n`),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "output_exists",
      }),
    );
    expect(await readFile(fixture.outputPath, "utf8")).toBe(sourceText);
  });

  it("recovers post-commit lock and temporary debris without changing the final file", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();
    const temporary = temporaryPath(fixture, 0);
    const lockPath = join(fixture.root, ".generated.prompt-candidate.yaml.generation.lock");
    await writeFile(temporary, sourceText, { encoding: "utf8", mode: 0o600 });
    await link(temporary, fixture.outputPath);
    await symlink(
      JSON.stringify({
        version: 1,
        hostname: hostname(),
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000000",
      }),
      lockPath,
    );

    await expect(publishLocalPromptCandidate(fixture.outputPath, sourceText)).rejects.toMatchObject(
      { code: "output_exists" },
    );
    await expect(readFile(fixture.outputPath, "utf8")).resolves.toBe(sourceText);
    await expect(access(temporary)).rejects.toThrow();
    await expect(access(lockPath)).rejects.toThrow();
  });

  it("does not expose partial or invalid output", async () => {
    const fixture = await localFixture();
    await expect(
      publishLocalPromptCandidate(fixture.outputPath, "not a candidate"),
    ).rejects.toThrow(/invalid/);
    await expect(access(fixture.outputPath)).rejects.toThrow();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        beforePublish: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrowError(/simulated interruption/);
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("does not publish a replacement of its validated temporary file", async () => {
    const fixture = await localFixture();
    let replacementPath: string | undefined;

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        beforePublish: async () => {
          const temporaryName = (await readdir(fixture.root)).find((name) =>
            /^\.generated\.prompt-candidate\.yaml\.generation\.[0-9a-f-]+\.tmp$/.test(name),
          );
          if (temporaryName === undefined) {
            throw new Error("candidate temporary file is missing");
          }
          replacementPath = join(fixture.root, temporaryName);
          await unlink(replacementPath);
          await writeFile(replacementPath, "attacker-controlled\n", "utf8");
        },
      }),
    ).rejects.toThrowError(/temporary.*changed/i);
    await expect(access(fixture.outputPath)).rejects.toThrow();
    expect(replacementPath).toBeDefined();
    await expect(readFile(replacementPath as string, "utf8")).resolves.toBe(
      "attacker-controlled\n",
    );
  });

  it("does not publish when cancellation reaches the commit point", async () => {
    const fixture = await localFixture();
    const controller = new AbortController();
    const reason = new Error("publication was cancelled");

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        signal: controller.signal,
        beforePublish: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("reports uncertain publication when cancellation follows the commit", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();
    const controller = new AbortController();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, sourceText, {
        signal: controller.signal,
        afterPublishLink: () => controller.abort(new Error("post-commit cancellation")),
      }),
    ).rejects.toMatchObject({ code: "publication_uncertain" });
    await expect(readFile(fixture.outputPath, "utf8")).resolves.toBe(sourceText);
  });

  it("reports uncertain publication when cancellation reaches lock release", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();
    const controller = new AbortController();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, sourceText, {
        signal: controller.signal,
        beforeReleaseLock: (_path, phase) => {
          if (phase === "before-unlink") {
            controller.abort(new Error("lock-release cancellation"));
          }
        },
      }),
    ).rejects.toMatchObject({ code: "publication_uncertain" });
    await expect(readFile(fixture.outputPath, "utf8")).resolves.toBe(sourceText);
  });

  it("preserves near-match files and rejects reserved output names", async () => {
    const fixture = await localFixture();
    const nearMatch = join(
      fixture.root,
      ".generated.prompt-candidate.yaml.generation.operator-notes.tmp",
    );
    await writeFile(nearMatch, "operator-owned\n", "utf8");
    await utimes(nearMatch, new Date(0), new Date(0));

    await publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText());

    expect(await readFile(nearMatch, "utf8")).toBe("operator-owned\n");
    const reservedOutput = join(
      fixture.root,
      ".report.yaml.generation.00000000-0000-4000-8000-000000000000.tmp",
    );
    await expect(
      publishLocalPromptCandidate(reservedOutput, generatedCandidateText()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "invalid_output",
      }),
    );
    await expect(access(reservedOutput)).rejects.toThrow();
  });

  it("fails closed when recent publisher temporary files reach the limit", async () => {
    const fixture = await localFixture();
    for (let index = 0; index < 16; index += 1) {
      await writeFile(temporaryPath(fixture, index), "complete temporary candidate\n", "utf8");
    }

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "temporary_limit",
      }),
    );
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("checks temporary count and bytes before stale cleanup", async () => {
    const tooMany = await localFixture();
    for (let index = 0; index < 17; index += 1) {
      const path = temporaryPath(tooMany, index);
      await writeFile(path, "stale\n", "utf8");
      await utimes(path, new Date(0), new Date(0));
    }
    await expect(
      publishLocalPromptCandidate(tooMany.outputPath, generatedCandidateText()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "temporary_limit",
      }),
    );
    await expect(readFile(temporaryPath(tooMany, 0), "utf8")).resolves.toBe("stale\n");

    const tooLarge = await localFixture();
    const largeTemporary = temporaryPath(tooLarge, 0);
    await writeFile(largeTemporary, "x".repeat(16 * 1024 * 1024 + 1), "utf8");
    await utimes(largeTemporary, new Date(0), new Date(0));
    await expect(
      publishLocalPromptCandidate(tooLarge.outputPath, generatedCandidateText()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "temporary_limit",
      }),
    );
    await expect(access(largeTemporary)).resolves.toBeUndefined();
  });

  it("does not remove a stale temporary path that changes during recovery", async () => {
    const fixture = await localFixture();
    const stale = temporaryPath(fixture, 0);
    await writeFile(stale, "stale\n", "utf8");
    await utimes(stale, new Date(0), new Date(0));

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        beforeRetireTemporary: async (path) => {
          await unlink(path);
          await writeFile(path, "replacement\n", "utf8");
        },
      }),
    ).rejects.toThrowError(/changed during stale recovery/);
    expect(await readFile(stale, "utf8")).toBe("replacement\n");
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("does not publish when a source changes at the final commit check", async () => {
    const fixture = await localFixture();
    const admitted = await admitLocalPromptCandidateGenerationSources(
      fixture.outputPath,
      fixture.baselinePath,
      [fixture.evidencePath],
    );

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        beforePublish: async () => {
          await writeFile(fixture.baselinePath, `${promptCandidateWorkflowText()}\n`, "utf8");
          await admitted.revalidate();
        },
      }),
    ).rejects.toThrowError(/changed/);
    await expect(access(fixture.outputPath)).rejects.toThrow();
  });

  it("keeps the temporary-file bound under concurrent publication", async () => {
    const fixture = await localFixture();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let markOverflow: () => void = () => undefined;
    const overflow = new Promise<void>((resolve) => {
      markOverflow = resolve;
    });
    const publications = Array.from({ length: 20 }, () =>
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        beforePublish: async () => {
          entered += 1;
          if (entered > 16) {
            markOverflow();
          }
          await held;
        },
      }).then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    );

    await Promise.race([overflow, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
    const temporaryFiles = (await readdir(fixture.root)).filter((name) =>
      /^\.generated\.prompt-candidate\.yaml\.generation\.[0-9a-f-]+\.tmp$/.test(name),
    );
    expect(temporaryFiles.length).toBeLessThanOrEqual(16);

    release();
    const results = await Promise.all(publications);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await readFile(fixture.outputPath, "utf8")).toBe(generatedCandidateText());
  });

  it("returns a bounded result when two publishers recover the same dead lock", async () => {
    const fixture = await localFixture();
    const lockPath = join(fixture.root, ".generated.prompt-candidate.yaml.generation.lock");
    await symlink(
      JSON.stringify({
        version: 1,
        hostname: hostname(),
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000000",
      }),
      lockPath,
    );
    let observedRecoveries = 0;
    let releaseRecoveries: () => void = () => undefined;
    const bothObserved = new Promise<void>((resolve) => {
      releaseRecoveries = resolve;
    });
    const publish = () =>
      publishLocalPromptCandidate(fixture.outputPath, generatedCandidateText(), {
        beforeRecoverPublicationLock: async () => {
          observedRecoveries += 1;
          if (observedRecoveries === 2) {
            await unlink(lockPath);
            releaseRecoveries();
          }
          await bothObserved;
        },
      });

    const results = await Promise.allSettled([publish(), publish()]);

    expect(observedRecoveries).toBe(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      LocalPromptCandidatePublisherError,
    );
    expect(rejected?.status === "rejected" ? rejected.reason.code : undefined).toMatch(
      /output_exists|temporary_limit/,
    );
  });

  it("reports uncertain publication when final lock cleanup fails", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, sourceText, {
        beforeReleaseLock: async (path) => unlink(path),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "publication_uncertain",
      }),
    );
    expect(await readFile(fixture.outputPath, "utf8")).toBe(sourceText);
  });

  it("reports uncertain publication when final lock cleanup cannot be synchronized", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, sourceText, {
        beforeReleaseLock: (_path, phase) => {
          if (phase === "before-directory-sync") {
            throw new Error("simulated lock directory synchronization failure");
          }
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LocalPromptCandidatePublisherError>>({
        code: "publication_uncertain",
      }),
    );
    expect(await readFile(fixture.outputPath, "utf8")).toBe(sourceText);
  });

  it("reports an unsettled lock when publication and cleanup both fail", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, sourceText, {
        beforePublish: () => {
          throw new Error("simulated publication failure");
        },
        beforeReleaseLock: () => {
          throw new Error("simulated lock cleanup failure");
        },
      }),
    ).rejects.toMatchObject({
      code: "cleanup_uncertain",
      message: expect.stringMatching(/publication failure.*lock cleanup failure/i),
    });
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(publishLocalPromptCandidate(fixture.outputPath, sourceText)).rejects.toMatchObject(
      { code: "temporary_limit" },
    );
  });

  it("reports an unsettled lock when acquisition and cleanup both fail", async () => {
    const fixture = await localFixture();
    const sourceText = generatedCandidateText();

    await expect(
      publishLocalPromptCandidate(fixture.outputPath, sourceText, {
        duringAcquirePublicationLock: (_path, phase) => {
          if (phase === "before-directory-sync") {
            throw new Error("simulated acquisition synchronization failure");
          }
          if (phase === "before-cleanup-unlink") {
            throw new Error("simulated acquisition cleanup failure");
          }
        },
      }),
    ).rejects.toMatchObject({
      code: "cleanup_uncertain",
      message: expect.stringMatching(/synchronization failure.*cleanup failure/i),
    });
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(publishLocalPromptCandidate(fixture.outputPath, sourceText)).rejects.toMatchObject(
      { code: "temporary_limit" },
    );
  });
});

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-candidate-generation-")));
  temporaryDirectories.push(root);
  const baselinePath = join(root, "baseline.workflow.yaml");
  const evidencePath = join(root, "tuning-evidence.json");
  const outputPath = join(root, "generated.prompt-candidate.yaml");
  const generation = promptCandidateGenerationFixture();
  await writeFile(baselinePath, promptCandidateWorkflowText(), "utf8");
  await writeFile(evidencePath, `${JSON.stringify(generation.evidence)}\n`, "utf8");
  return { root, baselinePath, evidencePath, outputPath };
}

function generatedCandidateText(): string {
  const { prepared } = promptCandidateGenerationFixture();
  const source = completePromptCandidateGeneration(
    prepared,
    JSON.stringify({
      changes: [{ nodeId: "implement", value: "Read TASK.md and verify the result." }],
    }),
    {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsdMicros: 0,
    },
  );
  return `${JSON.stringify(source)}\n`;
}

function temporaryPath(fixture: Awaited<ReturnType<typeof localFixture>>, index: number): string {
  return join(
    fixture.root,
    `.generated.prompt-candidate.yaml.generation.00000000-0000-4000-8000-${index
      .toString(16)
      .padStart(12, "0")}.tmp`,
  );
}
