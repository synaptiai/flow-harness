import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeEffectiveHarnessCandidateArtifact,
  MAX_EFFECTIVE_HARNESS_CANDIDATE_BYTES,
} from "../../../../src/domain/adaptation/effective-harness-candidate.js";
import { createEffectiveHarnessState } from "../../../../src/domain/adaptation/effective-harness-state.js";
import { calculateCapabilitySnapshotDigest } from "../../../../src/domain/capability/agent-skills.js";
import { admitLocalAdaptationCandidate } from "../../../../src/infrastructure/fs/local-adaptation-candidate.js";
import { childSpecialistCandidateFixture } from "../../../fixtures/child-specialist-candidate.js";
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
  it("does not retain a private missing source path as a nested cause", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")));
    temporaryDirectories.push(directory);
    const privatePath = join(directory, "PRIVATE_MISSING_MEMORY_CANDIDATE.json");

    const error = await admitLocalAdaptationCandidate(privatePath).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(privatePath);
    expect((error as Error).cause).toBeUndefined();
  });

  it("dispatches a child-specialist candidate with its admitted package closure", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")));
    temporaryDirectories.push(directory);
    const path = join(directory, "specialist.candidate.yaml");
    const baselinePath = join(directory, "baseline.workflow.yaml");
    const fixture = childSpecialistCandidateFixture();
    await writeFile(path, fixture.sourceText);
    await writeFile(baselinePath, fixture.baselineText);

    await expect(
      admitLocalAdaptationCandidate(path, {
        capabilityPackages: fixture.packages,
      }),
    ).resolves.toMatchObject({
      kind: "child-specialist-candidate",
      candidate: {
        identity: fixture.projected.identity,
        workflow: fixture.projected.workflow,
      },
    });
    await expect(admitLocalAdaptationCandidate(path)).rejects.toThrow(
      "child-specialist candidate requires an admitted package closure",
    );
  });

  it("resolves child-specialist packages only after child discrimination", async () => {
    const childDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")),
    );
    const modelDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")),
    );
    temporaryDirectories.push(childDirectory, modelDirectory);
    const childPath = join(childDirectory, "specialist.candidate.yaml");
    const modelPath = join(modelDirectory, "route.candidate.yaml");
    const fixture = childSpecialistCandidateFixture();
    const modelBaseline = promptCandidateWorkflowText();
    await writeFile(childPath, fixture.sourceText);
    await writeFile(join(childDirectory, "baseline.workflow.yaml"), fixture.baselineText);
    await writeFile(modelPath, JSON.stringify(modelRoutingCandidateSourceFixture(modelBaseline)));
    await writeFile(join(modelDirectory, "baseline.workflow.yaml"), modelBaseline);
    const resolvedIds: string[] = [];

    await expect(
      admitLocalAdaptationCandidate(childPath, {
        resolveChildSpecialistPackages: async (source) => {
          resolvedIds.push(source.metadata.id);
          return fixture.packages;
        },
      }),
    ).resolves.toMatchObject({ kind: "child-specialist-candidate" });
    await expect(
      admitLocalAdaptationCandidate(modelPath, {
        resolveChildSpecialistPackages: async () => {
          throw new Error("PRIVATE_RESOLVER_MUST_NOT_RUN");
        },
      }),
    ).resolves.toMatchObject({ kind: "model-routing-candidate" });
    expect(resolvedIds).toEqual([fixture.projected.identity.id]);
  });

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

  it("dispatches supplemental memory only after resolving its exact complete baseline", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-adaptation-candidate-")));
    temporaryDirectories.push(directory);
    const path = join(directory, "memory.candidate.json");
    const baseline = createEffectiveHarnessState({
      scopeDigest: "a".repeat(64),
      workflowSource: promptCandidateWorkflowText(),
      packages: [],
    });
    const source = {
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "SupplementalMemoryCandidate",
      metadata: { id: "reviewed-fixture", version: "1.0.0" },
      scope: {
        kind: "workflow-agent-memory",
        workflowId: baseline.workflowId,
        childPath: [],
        agentNodeId: "implement",
        entryId: "fixture-location",
      },
      baseline: {
        stateDigest: baseline.stateDigest,
        workflowDigest: baseline.workflow.workflowDigest,
        packageClosureDigest: calculateCapabilitySnapshotDigest(baseline.packages),
      },
      change: { kind: "add", value: "PRIVATE_MEMORY_READ_THE_REVIEWED_FIXTURE" },
    };
    await writeFile(path, JSON.stringify(source));
    const resolvedWorkflowIds: string[] = [];

    const admitted = await admitLocalAdaptationCandidate(path, {
      resolveSupplementalMemoryBaseline: async (candidate) => {
        resolvedWorkflowIds.push(candidate.scope.workflowId);
        return baseline;
      },
    });

    expect(admitted).toMatchObject({
      kind: "supplemental-memory-candidate",
      candidate: {
        source,
        identity: {
          kind: "supplemental-memory-candidate",
          scope: source.scope,
          projectedStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        state: {
          supplementalMemory: [
            expect.objectContaining({
              id: "fixture-location",
              target: {
                workflowId: source.scope.workflowId,
                childPath: source.scope.childPath,
                agentNodeId: source.scope.agentNodeId,
              },
            }),
          ],
        },
      },
    });
    expect(resolvedWorkflowIds).toEqual([baseline.workflowId]);
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
