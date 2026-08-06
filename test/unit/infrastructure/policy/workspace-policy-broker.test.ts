import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PolicyAuditClosedError,
  PolicyBroker,
  PolicyDeniedError,
} from "../../../../src/domain/policy/broker.js";
import { createWorkspacePolicyBroker } from "../../../../src/infrastructure/policy/workspace-policy-broker.js";

const temporaryDirectories: string[] = [];
const attribution = {
  runId: "run-policy",
  workflowId: "policy-workflow",
  nodeId: "analyze",
  attempt: 1,
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspacePolicyBroker", () => {
  it("authorizes before invoking an allowed effect exactly once", async () => {
    const root = await createTemporaryDirectory();
    const file = join(root, "inside.txt");
    await writeFile(file, "inside", "utf8");
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async (target: string) => target);
    const canonicalFile = await realpath(file);

    await expect(workspace.execute("filesystem.read", file, effect)).resolves.toBe(canonicalFile);
    expect(effect).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledWith(canonicalFile);
    expect(policy.snapshot()).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: "filesystem.read",
        target: canonicalFile,
        outcome: "allowed",
      }),
    ]);
  });

  it("denies an undeclared action before invoking its effect", async () => {
    const root = await createTemporaryDirectory();
    const file = join(root, "inside.txt");
    await writeFile(file, "inside", "utf8");
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async () => undefined);

    await expect(workspace.execute("filesystem.write", file, effect)).rejects.toThrowError(
      PolicyDeniedError,
    );
    expect(effect).not.toHaveBeenCalled();
    expect(policy.snapshot()[0]).toMatchObject({
      action: "filesystem.write",
      outcome: "denied",
      reason: "operation_not_declared",
    });
  });

  it("denies lexical escapes before invoking their effect", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async () => undefined);
    const canonicalOutsideFile = await realpath(outsideFile);

    await expect(workspace.execute("filesystem.read", outsideFile, effect)).rejects.toThrowError(
      PolicyDeniedError,
    );
    expect(effect).not.toHaveBeenCalled();
    expect(policy.snapshot()[0]).toMatchObject({
      target: canonicalOutsideFile,
      outcome: "denied",
      reason: "target_outside_workspace",
    });
  });

  it("denies a symlink escape before invoking its effect", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const outsideFile = join(outside, "secret.txt");
    const link = join(root, "linked-secret");
    await writeFile(outsideFile, "secret", "utf8");
    await symlink(outsideFile, link);
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async () => undefined);
    const canonicalOutsideFile = await realpath(outsideFile);

    await expect(workspace.execute("filesystem.read", link, effect)).rejects.toThrowError(
      PolicyDeniedError,
    );
    expect(effect).not.toHaveBeenCalled();
    expect(policy.snapshot()[0]).toMatchObject({
      target: canonicalOutsideFile,
      outcome: "denied",
      reason: "target_outside_workspace",
    });
  });

  it("canonicalizes the nearest existing ancestor for a missing target", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "missing", "file.txt");
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async (canonicalTarget: string) => canonicalTarget);
    const canonicalTarget = join(await realpath(root), "missing", "file.txt");

    await expect(workspace.execute("filesystem.read", target, effect)).resolves.toBe(
      canonicalTarget,
    );
    expect(policy.snapshot()[0]).toMatchObject({ target: canonicalTarget, outcome: "allowed" });
  });

  it("records an unresolvable target denial before invoking its effect", async () => {
    const root = await createTemporaryDirectory();
    const target = join(root, "invalid\0target");
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async () => undefined);

    await expect(workspace.execute("filesystem.read", target, effect)).rejects.toThrowError(
      PolicyDeniedError,
    );
    expect(effect).not.toHaveBeenCalled();
    expect(policy.snapshot()[0]).toMatchObject({
      outcome: "denied",
      reason: "target_resolution_failed",
    });
  });

  it("denies effects after the node audit has closed", async () => {
    const root = await createTemporaryDirectory();
    const file = join(root, "inside.txt");
    await writeFile(file, "inside", "utf8");
    const policy = new PolicyBroker(attribution, ["filesystem.read"]);
    const workspace = await createWorkspacePolicyBroker(root, policy);
    const effect = vi.fn(async () => undefined);
    policy.close();

    await expect(workspace.execute("filesystem.read", file, effect)).rejects.toThrowError(
      PolicyAuditClosedError,
    );
    expect(effect).not.toHaveBeenCalled();
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-policy-broker-"));
  temporaryDirectories.push(directory);
  return directory;
}
