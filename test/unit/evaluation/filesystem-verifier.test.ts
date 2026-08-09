import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyEvaluationWorkspace } from "../../../src/domain/evaluation/filesystem-verifier.js";
import {
  calculateEvaluationVerifierDigest,
  type EvaluationFilesystemAssertion,
} from "../../../src/domain/evaluation/plan.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("private evaluation filesystem verifier", () => {
  it("authoritatively accepts bounded exists, absent, and SHA-256 assertions", async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(join(workspace.cwd, "output"));
    await writeFile(join(workspace.cwd, "output", "RESULT.md"), "complete\n");
    const verifier = filesystemVerifier([
      { kind: "exists", path: "output" },
      { kind: "absent", path: "SHOULD-NOT-EXIST" },
      { kind: "sha256", path: "output/RESULT.md", value: sha256("complete\n") },
    ]);

    const result = await verifyEvaluationWorkspace({
      workspace,
      expectedIdentity: identity(workspace),
      verifier,
    });

    expect(result).toEqual({
      outcome: "accepted",
      verifierDigest: verifier.digest,
      assertions: [
        { kind: "exists", path: "output", outcome: true },
        { kind: "absent", path: "SHOULD-NOT-EXIST", outcome: true },
        {
          kind: "sha256",
          path: "output/RESULT.md",
          outcome: true,
          observedSha256: sha256("complete\n"),
        },
      ],
    });
  });

  it("rejects a completed harness result that does not satisfy private assertions", async () => {
    const workspace = await temporaryWorkspace();

    const result = await verifyEvaluationWorkspace({
      workspace,
      expectedIdentity: identity(workspace),
      verifier: filesystemVerifier([{ kind: "exists", path: "RESULT.md" }]),
    });

    expect(result).toMatchObject({
      outcome: "rejected",
      assertions: [{ kind: "exists", path: "RESULT.md", outcome: false }],
    });
  });

  it("returns verifier error for identity substitution and unsafe symbolic links", async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(join(workspace.cwd, "actual"), "value");
    await symlink("actual", join(workspace.cwd, "linked"));

    await expect(
      verifyEvaluationWorkspace({
        workspace,
        expectedIdentity: { ...identity(workspace), snapshotDigest: "c".repeat(64) },
        verifier: filesystemVerifier([{ kind: "exists", path: "actual" }]),
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      assertions: [],
      reason: expect.stringMatching(/identity/i),
    });

    await expect(
      verifyEvaluationWorkspace({
        workspace,
        expectedIdentity: identity(workspace),
        verifier: filesystemVerifier([{ kind: "sha256", path: "linked", value: sha256("value") }]),
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      assertions: [{ kind: "sha256", path: "linked", outcome: false }],
      reason: expect.stringMatching(/symbolic link/i),
    });
  });

  it("returns verifier error when assertions do not match their admitted digest", async () => {
    const workspace = await temporaryWorkspace();

    await expect(
      verifyEvaluationWorkspace({
        workspace,
        expectedIdentity: identity(workspace),
        verifier: {
          kind: "filesystem-v1",
          digest: calculateEvaluationVerifierDigest("filesystem-v1", [
            { kind: "absent", path: "RESULT.md" },
          ]),
          assertions: [{ kind: "exists", path: "RESULT.md" }],
        },
      }),
    ).resolves.toMatchObject({
      outcome: "error",
      assertions: [],
      reason: expect.stringMatching(/digest/i),
    });
  });
});

async function temporaryWorkspace() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-verifier-")));
  temporaryDirectories.push(cwd);
  return Object.freeze({
    workspaceId: "trial-workspace",
    cwd,
    backend: "reflink-copy-v1" as const,
    snapshotDigest: "f".repeat(64),
  });
}

function identity(workspace: Awaited<ReturnType<typeof temporaryWorkspace>>) {
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    backend: workspace.backend,
    snapshotDigest: workspace.snapshotDigest,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function filesystemVerifier(assertions: readonly EvaluationFilesystemAssertion[]) {
  return Object.freeze({
    kind: "filesystem-v1" as const,
    digest: calculateEvaluationVerifierDigest("filesystem-v1", assertions),
    assertions,
  });
}
