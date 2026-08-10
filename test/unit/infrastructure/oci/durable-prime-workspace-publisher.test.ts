import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurablePrimeWorkspacePublisher } from "../../../../src/infrastructure/oci/durable-prime-workspace-publisher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("durable Prime workspace publisher", () => {
  it("replaces the complete workspace and retires all journal data", async () => {
    const fixture = await workspaceFixture();
    const publisher = new DurablePrimeWorkspacePublisher();

    await publisher.publish(publishInput(fixture));

    await expect(readFile(join(fixture.targetRoot, "RESULT.md"), "utf8")).resolves.toBe("DONE\n");
    await expect(readFile(join(fixture.targetRoot, "OLD.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(fixture.parent)).filter((name) => name.includes("prime-replacement")),
    ).toEqual([]);
  });

  it("rolls back an uncommitted switch after a crash", async () => {
    const fixture = await workspaceFixture();
    const crashing = new DurablePrimeWorkspacePublisher({
      afterTargetRetired: () => {
        throw new Error("simulated process crash");
      },
    });
    await expect(crashing.publish(publishInput(fixture))).rejects.toThrow(/process crash/i);

    const recovered = await new DurablePrimeWorkspacePublisher().recover(fixture.targetRoot);

    expect(recovered).toBe("rolled_back");
    await expect(readFile(join(fixture.targetRoot, "OLD.md"), "utf8")).resolves.toBe("OLD\n");
    await expect(readFile(join(fixture.targetRoot, "RESULT.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("finishes cleanup after the committed switch survives a crash", async () => {
    const fixture = await workspaceFixture();
    const crashing = new DurablePrimeWorkspacePublisher({
      afterTargetSwitched: () => {
        throw new Error("simulated process crash");
      },
    });
    await expect(crashing.publish(publishInput(fixture))).rejects.toThrow(/process crash/i);

    const recovered = await new DurablePrimeWorkspacePublisher().recover(fixture.targetRoot);

    expect(recovered).toBe("committed");
    await expect(readFile(join(fixture.targetRoot, "RESULT.md"), "utf8")).resolves.toBe("DONE\n");
    await expect(readFile(join(fixture.targetRoot, "OLD.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function workspaceFixture() {
  const parent = await mkdtemp(join(tmpdir(), "flow-prime-publisher-"));
  temporaryDirectories.push(parent);
  const targetRoot = join(parent, "workspace");
  const stagingRoot = join(parent, ".workspace.prime-stage");
  await mkdir(targetRoot);
  await mkdir(stagingRoot);
  await writeFile(join(targetRoot, "OLD.md"), "OLD\n");
  await writeFile(join(stagingRoot, "RESULT.md"), "DONE\n");
  return { parent, targetRoot, stagingRoot };
}

function publishInput(fixture: Awaited<ReturnType<typeof workspaceFixture>>) {
  return {
    targetRoot: fixture.targetRoot,
    stagingRoot: fixture.stagingRoot,
    entries: [
      {
        path: "RESULT.md",
        type: "file" as const,
        mode: 0o644,
        size: 5,
        sha256: "8221ac66be71558c921fb44cfb66f7997699aea754d917763882d6d9eddc836e",
      },
    ],
    manifestSha256: "a".repeat(64),
  };
}
