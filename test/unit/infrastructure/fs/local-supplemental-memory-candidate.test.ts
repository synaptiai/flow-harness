import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEffectiveHarnessState,
  type EffectiveHarnessState,
} from "../../../../src/domain/adaptation/effective-harness-state.js";
import {
  MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES,
  type SupplementalMemoryCandidateSource,
} from "../../../../src/domain/adaptation/supplemental-memory-candidate.js";
import { calculateCapabilitySnapshotDigest } from "../../../../src/domain/capability/agent-skills.js";
import {
  admitLocalSupplementalMemoryCandidate,
  LocalSupplementalMemoryCandidateError,
} from "../../../../src/infrastructure/fs/local-supplemental-memory-candidate.js";
import { promptCandidateWorkflowText } from "../../../fixtures/prompt-candidate-generation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local supplemental-memory candidate admission", () => {
  it("accepts the exact source byte boundary and rejects one additional byte", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-candidate-")));
    temporaryDirectories.push(directory);
    const baseline = baselineState();
    const source = candidateText(baseline);
    const exact = `${source}${" ".repeat(MAX_SUPPLEMENTAL_MEMORY_CANDIDATE_BYTES - Buffer.byteLength(source))}`;
    const exactPath = join(directory, "exact.candidate.json");
    const overflowPath = join(directory, "overflow.candidate.json");
    await writeFile(exactPath, exact);
    await writeFile(overflowPath, `${exact} `);

    await expect(
      admitLocalSupplementalMemoryCandidate(exactPath, {
        resolveBaseline: async () => baseline,
      }),
    ).resolves.toMatchObject({
      identity: { kind: "supplemental-memory-candidate" },
      state: { supplementalMemory: [expect.objectContaining({ id: "reviewed-fixture" })] },
    });
    await expect(
      admitLocalSupplementalMemoryCandidate(overflowPath, {
        resolveBaseline: async () => baseline,
      }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects direct and ancestor links before baseline resolution", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-candidate-")));
    temporaryDirectories.push(directory);
    const realDirectory = join(directory, "real", "nested");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(realDirectory, { recursive: true }));
    const realPath = join(realDirectory, "memory.candidate.json");
    await writeFile(realPath, candidateText(baselineState()));
    const directLink = join(directory, "direct-link.json");
    const ancestorLink = join(directory, "ancestor-link");
    await symlink(realPath, directLink);
    await symlink(join(directory, "real"), ancestorLink);
    const resolveBaseline = vi.fn(async () => baselineState());

    await expect(
      admitLocalSupplementalMemoryCandidate(directLink, { resolveBaseline }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      admitLocalSupplementalMemoryCandidate(join(ancestorLink, "nested", "memory.candidate.json"), {
        resolveBaseline,
      }),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(resolveBaseline).not.toHaveBeenCalled();
  });

  it("rejects same-size source replacement after projection", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-candidate-")));
    temporaryDirectories.push(directory);
    const baseline = baselineState();
    const path = join(directory, "memory.candidate.json");
    const source = candidateText(baseline, "PRIVATE_MEMORY_VERSION_A");
    const replacement = candidateText(baseline, "PRIVATE_MEMORY_VERSION_B");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(source));
    await writeFile(path, source);

    await expect(
      admitLocalSupplementalMemoryCandidate(path, {
        resolveBaseline: async () => baseline,
        beforeReturn: () => writeFile(path, replacement),
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("preserves exact cancellation before parsing and after baseline resolution", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-candidate-")));
    temporaryDirectories.push(directory);
    const baseline = baselineState();
    const path = join(directory, "memory.candidate.json");
    await writeFile(path, candidateText(baseline));

    const beforeController = new AbortController();
    const beforeReason = new Error("operator cancelled before memory parsing");
    const beforeResolver = vi.fn(async () => baseline);
    await expect(
      admitLocalSupplementalMemoryCandidate(path, {
        signal: beforeController.signal,
        resolveBaseline: beforeResolver,
        afterRead: () => beforeController.abort(beforeReason),
      }),
    ).rejects.toBe(beforeReason);
    expect(beforeResolver).not.toHaveBeenCalled();

    const afterController = new AbortController();
    const afterReason = new Error("operator cancelled after memory baseline resolution");
    await expect(
      admitLocalSupplementalMemoryCandidate(path, {
        signal: afterController.signal,
        resolveBaseline: async () => {
          afterController.abort(afterReason);
          return baseline;
        },
      }),
    ).rejects.toBe(afterReason);
  });

  it("maps private baseline failures to one value-free stage", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "flow-memory-candidate-")));
    temporaryDirectories.push(directory);
    const path = join(directory, "memory.candidate.json");
    await writeFile(path, candidateText(baselineState()));
    const privateCanary = "PRIVATE_BASELINE_RESOLVER_FAILURE";

    const error = await admitLocalSupplementalMemoryCandidate(path, {
      resolveBaseline: async () => {
        throw new Error(privateCanary);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LocalSupplementalMemoryCandidateError);
    expect(error).toMatchObject({ code: "invalid_source" });
    expect((error as Error).message).not.toContain(privateCanary);
    expect((error as Error).cause).toBeUndefined();
  });
});

function baselineState(): EffectiveHarnessState {
  return createEffectiveHarnessState({
    scopeDigest: "a".repeat(64),
    workflowSource: promptCandidateWorkflowText(),
    packages: [],
  });
}

function candidateText(
  baseline: EffectiveHarnessState,
  value = "PRIVATE_MEMORY_READ_THE_REVIEWED_FIXTURE",
): string {
  const source: SupplementalMemoryCandidateSource = {
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "SupplementalMemoryCandidate",
    metadata: { id: "reviewed-fixture", version: "1.0.0" },
    scope: {
      kind: "workflow-agent-memory",
      workflowId: baseline.workflowId,
      childPath: [],
      agentNodeId: "implement",
      entryId: "reviewed-fixture",
    },
    baseline: {
      stateDigest: baseline.stateDigest,
      workflowDigest: baseline.workflow.workflowDigest,
      packageClosureDigest: calculateCapabilitySnapshotDigest(baseline.packages),
    },
    change: { kind: "add", value },
  };
  return JSON.stringify(source);
}
