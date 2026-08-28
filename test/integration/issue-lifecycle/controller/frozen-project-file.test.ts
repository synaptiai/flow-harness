import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_FROZEN_PROJECT_FILE_BYTES,
  readFrozenProjectFile,
} from "../../../../src/infrastructure/fs/frozen-project-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("readFrozenProjectFile", () => {
  it("returns exact immutable bytes and a SHA-256 digest for a nested project file", async () => {
    const root = await projectDirectory();
    await mkdir(join(root, "plans"), { mode: 0o700 });
    const content = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
    await writeFile(join(root, "plans", "issue.plan"), content, { mode: 0o600 });

    const frozen = await readFrozenProjectFile({
      projectRoot: root,
      path: "plans/issue.plan",
      maxBytes: 128,
    });

    expect(frozen).toEqual({
      version: 1,
      path: "plans/issue.plan",
      byteLength: content.byteLength,
      contentBase64: content.toString("base64"),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it.each([
    "",
    "/absolute",
    "../outside",
    "directory/../file",
    "directory/./file",
    "directory//file",
    "directory\\file",
    "directory/file/",
    `file\0secret`,
  ])("rejects unsafe or noncanonical path %j before reading", async (path) => {
    const root = await projectDirectory();

    await expect(
      readFrozenProjectFile({ projectRoot: root, path, maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "path_invalid" });
  });

  it("rejects paths that exceed the depth, component, or encoded-byte bounds", async () => {
    const root = await projectDirectory();
    const deep = Array.from({ length: 65 }, () => "a").join("/");
    const longComponent = "a".repeat(256);
    const longPath = Array.from({ length: 20 }, () => "é".repeat(120)).join("/");

    for (const path of [deep, longComponent, longPath]) {
      await expect(
        readFrozenProjectFile({ projectRoot: root, path, maxBytes: 128 }),
      ).rejects.toMatchObject({ code: "path_invalid" });
    }
  });

  it("rejects final and ancestor symbolic links", async () => {
    const root = await projectDirectory();
    const outside = await projectDirectory();
    await writeFile(join(outside, "secret"), "secret", { mode: 0o600 });
    await symlink(join(outside, "secret"), join(root, "file-link"));
    await symlink(outside, join(root, "directory-link"));

    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "file-link", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(
      readFrozenProjectFile({
        projectRoot: root,
        path: "directory-link/secret",
        maxBytes: 128,
      }),
    ).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects a symbolic-link project root", async () => {
    const root = await projectDirectory();
    await writeFile(join(root, "plan"), "plan", { mode: 0o600 });
    const parent = await projectDirectory();
    const linkedRoot = join(parent, "linked-root");
    await symlink(root, linkedRoot);

    await expect(
      readFrozenProjectFile({ projectRoot: linkedRoot, path: "plan", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_root" });
  });

  it("rejects group-writable ancestors and files", async () => {
    const root = await projectDirectory();
    const directory = join(root, "unsafe");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "plan"), "plan", { mode: 0o600 });
    await chmod(directory, 0o770);

    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "unsafe/plan", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_path" });

    await chmod(directory, 0o700);
    await chmod(join(directory, "plan"), 0o660);
    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "unsafe/plan", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_file" });
  });

  it("rejects a group-writable project root", async () => {
    const root = await projectDirectory();
    await writeFile(join(root, "plan"), "plan", { mode: 0o600 });
    await chmod(root, 0o770);

    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "plan", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_root" });
  });

  it("rejects multiply-linked and nonregular files", async () => {
    const root = await projectDirectory();
    const file = join(root, "plan");
    await writeFile(file, "plan", { mode: 0o600 });
    await link(file, join(root, "second-name"));

    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "plan", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_file" });
    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "missing", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "file_unavailable" });
    await mkdir(join(root, "directory"), { mode: 0o700 });
    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "directory", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "unsafe_file" });
  });

  it("rejects caller and implementation size-limit attacks", async () => {
    const root = await projectDirectory();
    await writeFile(join(root, "plan"), Buffer.alloc(129), { mode: 0o600 });

    await expect(
      readFrozenProjectFile({ projectRoot: root, path: "plan", maxBytes: 128 }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await expect(
      readFrozenProjectFile({
        projectRoot: root,
        path: "plan",
        maxBytes: MAX_FROZEN_PROJECT_FILE_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: "request_invalid" });
  });

  it("uses stable content-free errors", async () => {
    const root = await projectDirectory();
    const secret = "secret-plan-name";

    const error = await captureError(() =>
      readFrozenProjectFile({ projectRoot: root, path: secret, maxBytes: 128 }),
    );

    expect(error).toMatchObject({
      name: "FrozenProjectFileError",
      code: "file_unavailable",
      message: "Frozen project file read failed: file_unavailable",
    });
    expect(String(error)).not.toContain(secret);
  });
});

async function projectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-frozen-project-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return await realpath(directory);
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}
