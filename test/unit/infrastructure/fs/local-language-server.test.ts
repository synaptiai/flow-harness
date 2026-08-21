import { createHash } from "node:crypto";
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  admitLocalLanguageServer,
  assertLocalLanguageServerCurrent,
} from "../../../../src/infrastructure/fs/local-language-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local language-server admission", () => {
  it("reopens an exact manifest and executable into an immutable snapshot", async () => {
    const fixture = await createFixture();

    const snapshot = await admitLocalLanguageServer(fixture.project, fixture.manifestPath);

    expect(snapshot).toMatchObject({
      name: "typescript",
      manifest: { provenance: ".flow/language-servers/typescript.json" },
      executable: {
        path: fixture.executablePath,
        sha256: fixture.executableSha256,
        bytes: fixture.executable.byteLength,
        device: expect.stringMatching(/^(?:0|[1-9][0-9]*)$/),
        inode: expect.stringMatching(/^[1-9][0-9]*$/),
      },
    });
  });

  it.each(["manifest", "executable"] as const)(
    "rejects a symbolic-link $label before reading its target",
    async (label) => {
      const fixture = await createFixture();
      const link = label === "manifest" ? fixture.manifestPath : fixture.executablePath;
      const target = `${link}.target`;
      await rename(link, target);
      await symlink(target, link);

      await expect(
        admitLocalLanguageServer(fixture.project, fixture.manifestPath),
      ).rejects.toMatchObject({
        name: "LocalLanguageServerError",
        code: label === "manifest" ? "invalid_manifest" : "invalid_executable",
      });
    },
  );

  it("rejects a manifest whose declared executable digest differs", async () => {
    const fixture = await createFixture({ executableSha256: "b".repeat(64) });

    await expect(
      admitLocalLanguageServer(fixture.project, fixture.manifestPath),
    ).rejects.toMatchObject({
      name: "LocalLanguageServerError",
      code: "invalid_executable",
    });
  });

  it("rejects executable replacement after its opened bytes were hashed", async () => {
    const fixture = await createFixture();

    await expect(
      admitLocalLanguageServer(fixture.project, fixture.manifestPath, {
        async afterExecutableRead() {
          await rename(fixture.executablePath, `${fixture.executablePath}.original`);
          await writeFile(fixture.executablePath, fixture.executable);
          await chmod(fixture.executablePath, 0o755);
        },
      }),
    ).rejects.toMatchObject({
      name: "LocalLanguageServerError",
      code: "source_changed",
    });
  });

  it("rejects a currentness check through a replaced executable-directory ancestor", async () => {
    const fixture = await createFixture();
    const snapshot = await admitLocalLanguageServer(fixture.project, fixture.manifestPath);
    const executableDirectory = join(fixture.project, "tools");
    const movedDirectory = join(fixture.project, "tools-original");
    await rename(executableDirectory, movedDirectory);
    await symlink(movedDirectory, executableDirectory);

    await expect(assertLocalLanguageServerCurrent(snapshot)).rejects.toMatchObject({
      name: "LocalLanguageServerError",
      code: "source_changed",
    });
  });

  it("retains path authority when an unrelated directory entry changes", async () => {
    const fixture = await createFixture();

    await expect(
      admitLocalLanguageServer(fixture.project, fixture.manifestPath, {
        async beforeReturn() {
          await writeFile(join(fixture.project, "tools", "unrelated.txt"), "unrelated\n");
        },
      }),
    ).resolves.toMatchObject({ name: "typescript" });
  });

  it("preserves exact cancellation after the manifest read and starts no executable read", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const reason = new Error("cancel language-server admission");
    let executableRead = false;

    const operation = admitLocalLanguageServer(fixture.project, fixture.manifestPath, {
      signal: controller.signal,
      afterManifestRead() {
        controller.abort(reason);
      },
      afterExecutableRead() {
        executableRead = true;
      },
    });

    await expect(operation).rejects.toBe(reason);
    expect(executableRead).toBe(false);
  });

  it.each(["manifest", "executable"] as const)(
    "closes the opened $kind before preserving post-open cancellation",
    async (kind) => {
      const fixture = await createFixture();
      const controller = new AbortController();
      const reason = new Error(`cancel after ${kind} open`);
      let openedHandle: FileHandle | undefined;

      const operation = admitLocalLanguageServer(fixture.project, fixture.manifestPath, {
        signal: controller.signal,
        afterFileOpened(openedKind, handle) {
          if (openedKind === kind) {
            openedHandle = handle;
            controller.abort(reason);
          }
        },
      });

      await expect(operation).rejects.toBe(reason);
      expect(openedHandle).toBeDefined();
      await expect((openedHandle as FileHandle).stat()).rejects.toMatchObject({ code: "EBADF" });
    },
  );
});

async function createFixture(overrides: { readonly executableSha256?: string } = {}): Promise<{
  project: string;
  manifestPath: string;
  executablePath: string;
  executable: Buffer;
  executableSha256: string;
}> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-language-server-")));
  temporaryDirectories.push(project);
  const manifestDirectory = join(project, ".flow", "language-servers");
  const executableDirectory = join(project, "tools");
  await mkdir(manifestDirectory, { recursive: true });
  await mkdir(executableDirectory, { recursive: true });
  const executable = Buffer.from("#!/bin/sh\nexit 0\n");
  const executablePath = join(executableDirectory, "typescript-language-server");
  await writeFile(executablePath, executable);
  await chmod(executablePath, 0o755);
  const executableSha256 = sha256(executable);
  const manifestPath = join(manifestDirectory, "typescript.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "LanguageServer",
      metadata: { name: "typescript" },
      spec: {
        protocol: "lsp-3.18",
        executable: executablePath,
        executableSha256: overrides.executableSha256 ?? executableSha256,
        args: ["--stdio"],
        languages: [{ id: "typescript", suffixes: [".ts", ".tsx"] }],
        containmentProfile: "default",
        requestTimeoutMs: 5_000,
      },
    }),
  );
  return { project, manifestPath, executablePath, executable, executableSha256 };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
