import { link, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_GOAL_WORKSPACE_SOURCE_BYTES } from "../../../../src/domain/goal/workspace.js";
import {
  LocalGoalWorkspaceSourceError,
  readLocalGoalWorkspaceSource,
} from "../../../../src/infrastructure/fs/local-goal-workspace-source.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("local goal workspace source", () => {
  it("reads and parses one stable regular source", async () => {
    const root = await temporaryRoot();
    const path = join(root, "goal.yaml");
    await writeFile(path, source("Ship the revision ledger."), "utf8");

    const admitted = await readLocalGoalWorkspaceSource(path);

    expect(admitted.sourcePath).toBe(path);
    expect(admitted.source.objective).toBe("Ship the revision ledger.");
    expect(admitted.sourceText).toBe(source("Ship the revision ledger."));
  });

  it("accepts the exact source-byte limit and rejects one additional byte", async () => {
    const root = await temporaryRoot();
    const exactPath = join(root, "exact.yaml");
    const extraPath = join(root, "extra.yaml");
    const prefix = source("");
    const exact = source("a".repeat(MAX_GOAL_WORKSPACE_SOURCE_BYTES - Buffer.byteLength(prefix)));
    expect(Buffer.byteLength(exact)).toBe(MAX_GOAL_WORKSPACE_SOURCE_BYTES);
    await writeFile(exactPath, exact);
    await writeFile(extraPath, `${exact}a`);

    await expect(readLocalGoalWorkspaceSource(exactPath)).rejects.toMatchObject({
      code: "invalid_source",
    });
    await expect(readLocalGoalWorkspaceSource(extraPath)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it.each(["symlink", "hard-link"] as const)(
    "rejects a %s without exposing its path",
    async (kind) => {
      const root = await temporaryRoot();
      const target = join(root, "PRIVATE_TARGET.yaml");
      const candidate = join(root, "PRIVATE_CANDIDATE.yaml");
      await writeFile(target, source("Private source."));
      if (kind === "symlink") await symlink(target, candidate);
      else await link(target, candidate);

      const error = await readError(candidate);

      expect(error).toBeInstanceOf(LocalGoalWorkspaceSourceError);
      expect(error.code).toBe("invalid_path");
      expect(error.message).not.toContain("PRIVATE_");
    },
  );

  it("rejects fatal UTF-8 without exposing source bytes", async () => {
    const root = await temporaryRoot();
    const path = join(root, "goal.yaml");
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x50, 0x52, 0x49, 0x56, 0x41, 0x54, 0x45]));

    const error = await readError(path);

    expect(error.code).toBe("invalid_source");
    expect(error.message).not.toContain("PRIVATE");
  });

  it("rejects a path replacement after the opened file is read", async () => {
    const root = await temporaryRoot();
    const path = join(root, "goal.yaml");
    const replacement = join(root, "replacement.yaml");
    await writeFile(path, source("Original source."));
    await writeFile(replacement, source("Replacement src."));

    await expect(
      readLocalGoalWorkspaceSource(path, {
        async afterRead() {
          await rename(replacement, path);
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("preserves the exact cancellation reason after the read boundary", async () => {
    const root = await temporaryRoot();
    const path = join(root, "goal.yaml");
    await writeFile(path, source("Cancelled source."));
    const controller = new AbortController();
    const reason = new Error("PRIVATE_CANCEL_REASON");

    await expect(
      readLocalGoalWorkspaceSource(path, {
        signal: controller.signal,
        afterRead() {
          controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
  });
});

function source(objective: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: GoalWorkspace
objective: ${JSON.stringify(objective)}
facts: []
invariants: []
verifiedFacts: []
openQuestions: []
nextAction: { id: continue, text: Continue. }
`;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-goal-source-"));
  roots.push(root);
  return root;
}

async function readError(path: string): Promise<LocalGoalWorkspaceSourceError> {
  try {
    await readLocalGoalWorkspaceSource(path);
  } catch (error) {
    if (error instanceof LocalGoalWorkspaceSourceError) return error;
    throw error;
  }
  throw new Error("expected local goal workspace source read to fail");
}
