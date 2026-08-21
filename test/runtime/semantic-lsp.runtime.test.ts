import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createLanguageServerSnapshot } from "../../src/domain/capability/language-server.js";
import { createLocalSemanticToolSessionFactory } from "../../src/infrastructure/lsp/local-semantic-code-service.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";

const linux = process.platform === "linux" && process.arch === "x64";
const temporaryDirectories: string[] = [];
const fixtureExecutable = fileURLToPath(
  new URL("../fixtures/semantic/fake-lsp-server.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe.skipIf(!linux)("semantic LSP runtime boundary", () => {
  it("allows project reads while denying projection writes and network access", async () => {
    const project = await realpath(await mkdtemp(join(tmpdir(), "flow-semantic-runtime-")));
    temporaryDirectories.push(project);
    await writeFile(join(project, "example.ts"), "const value = 1;\n");
    const listener = createServer();
    let connections = 0;
    listener.on("connection", (socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      listener.once("error", rejectListen);
      listener.listen(0, "127.0.0.1", resolveListen);
    });
    const address = listener.address();
    if (address === null || typeof address === "string") {
      throw new Error("semantic boundary listener did not expose a TCP port");
    }

    try {
      const languageServer = await fakeLanguageServer(address.port);
      const session = createLocalSemanticToolSessionFactory(createProductionCommandSandbox())({
        context: {
          runId: "semantic-runtime",
          workflowId: "semantic-runtime-workflow",
          attempt: 1,
          cwd: project,
          projectRoot: project,
          protectedPaths: [],
        },
        languageServer,
      });

      const result = await session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      });

      expect(result).toMatchObject({
        operation: "hover",
        hover: { path: "example.ts", value: "`const value: number`" },
      });
      expect(connections).toBe(0);
      await expect(readFile(join(project, "example.ts"), "utf8")).resolves.toBe(
        "const value = 1;\n",
      );
      expect(session.evidence()).toEqual([
        expect.objectContaining({
          sequence: 1,
          languageServerDigest: languageServer.digest,
          sandbox: expect.objectContaining({
            backend: "anthropic-sandbox-runtime",
            profile: "flow-native-v1",
          }),
        }),
      ]);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        listener.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    }
  }, 30_000);
});

async function fakeLanguageServer(port: number) {
  await chmod(fixtureExecutable, 0o755);
  const bytes = await readFile(fixtureExecutable);
  const executableSha256 = sha256(bytes);
  const identity = await stat(fixtureExecutable, { bigint: true });
  const manifest = Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "LanguageServer",
      metadata: { name: "fake-typescript" },
      spec: {
        protocol: "lsp-3.18",
        executable: fixtureExecutable,
        executableSha256,
        args: ["verify-boundary", String(port)],
        languages: [{ id: "typescript", suffixes: [".ts"] }],
        containmentProfile: "default",
        requestTimeoutMs: 5_000,
      },
    }),
  );
  return createLanguageServerSnapshot({
    provenance: ".flow/language-servers/fake-typescript.json",
    manifest,
    executable: {
      path: fixtureExecutable,
      sha256: executableSha256,
      bytes: bytes.byteLength,
      device: String(identity.dev),
      inode: String(identity.ino),
    },
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
