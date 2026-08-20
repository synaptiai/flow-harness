import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeEffectiveHarnessCandidateArtifact,
  MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES,
} from "../../../../src/domain/adaptation/effective-harness-candidate.js";
import { admitLocalAdaptationCandidate } from "../../../../src/infrastructure/fs/local-adaptation-candidate.js";
import { effectiveHarnessCandidateArtifactFixture } from "../../../fixtures/effective-harness-evaluation.js";
import { modelRoutingCandidateSourceFixture } from "../../../fixtures/model-routing-candidate.js";
import { promptCandidateWorkflowText } from "../../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local adaptation candidate dispatch", () => {
  it("dispatches one exact model-routing candidate and rejects replacement", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")));
    temporaryDirectories.push(directory);
    const path = join(directory, "route.candidate.yaml");
    const baselinePath = join(directory, "baseline.workflow.yaml");
    const baselineText = promptCandidateWorkflowText();
    const source = modelRoutingCandidateSourceFixture(baselineText);
    const content = Buffer.from(JSON.stringify(source));
    await writeFile(path, content);
    await writeFile(baselinePath, baselineText);

    await expect(admitLocalAdaptationCandidate(path)).resolves.toMatchObject({
      kind: "model-routing-candidate",
      candidate: {
        source,
        identity: {
          kind: "model-routing-candidate",
          route: source.route,
        },
      },
    });
    await expect(
      admitLocalAdaptationCandidate(path, {
        afterDiscriminatorRead: () => writeFile(path, Buffer.concat([content, Buffer.from(" ")])),
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("dispatches one exact effective harness artifact and rejects replacement", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")));
    temporaryDirectories.push(directory);
    const path = join(directory, "candidate.json");
    const artifact = effectiveHarnessCandidateArtifactFixture();
    const content = encodeEffectiveHarnessCandidateArtifact(artifact);
    await writeFile(path, content);

    await expect(admitLocalAdaptationCandidate(path)).resolves.toMatchObject({
      kind: "effective-harness-candidate",
      candidate: { artifact },
    });
    await expect(
      admitLocalAdaptationCandidate(path, {
        afterDiscriminatorRead: () => writeFile(path, Buffer.concat([content, Buffer.from(" ")])),
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("accepts the exact discriminator byte boundary before kind validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "candidate.yaml");
    const prefix = "kind: Unknown\n";
    await writeFile(
      path,
      prefix + " ".repeat(MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES - prefix.length),
    );

    await expect(admitLocalAdaptationCandidate(path)).rejects.toThrow(/kind is unsupported/i);
  });

  it("bounds a discriminator that grows after its initial file observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "candidate.yaml");
    await writeFile(path, "kind: Unknown\n");

    await expect(
      admitLocalAdaptationCandidate(path, {
        afterDiscriminatorStat: () =>
          writeFile(path, "x".repeat(MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES + 1)),
      }),
    ).rejects.toThrow(/exceeds.*byte limit/i);
  });

  it("preserves exact cancellation after the discriminator file is opened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "candidate.yaml");
    await writeFile(path, "kind: Unknown\n");
    const controller = new AbortController();
    const reason = new Error("operator cancelled candidate discrimination");

    await expect(
      admitLocalAdaptationCandidate(path, {
        signal: controller.signal,
        afterDiscriminatorStat: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
  });
});
