import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommandSandbox,
  CommandSandboxRequest,
} from "../../../../src/application/command-sandbox.js";
import { createLanguageServerSnapshot } from "../../../../src/domain/capability/language-server.js";
import {
  createLocalSemanticToolSessionFactory,
  type LocalSemanticCodeServiceOptions,
} from "../../../../src/infrastructure/lsp/local-semantic-code-service.js";

const temporaryDirectories: string[] = [];
const fixtureExecutable = fileURLToPath(
  new URL("../../../fixtures/semantic/fake-lsp-server.mjs", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local semantic code service", () => {
  it("runs one short-lived query against a protected projection", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer();
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(project),
      languageServer,
    });

    const result = await session.query({
      operation: "hover",
      path: "example.ts",
      position: { line: 0, character: 7 },
    });

    expect(result).toEqual({
      operation: "hover",
      hover: {
        path: "example.ts",
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        format: "markdown",
        value: "`const value: number`",
      },
    });
    expect(sandbox.requests).toHaveLength(1);
    const request = sandbox.requests[0];
    expect(request?.cwd).not.toBe(project);
    expect(request?.projectRoot).toBe(request?.cwd);
    expect(request?.protectedPaths).toEqual([request?.cwd]);
    expect(request?.runtimeSupportPaths).toEqual([fixtureExecutable]);
    expect(await readFile(join(project, "example.ts"), "utf8")).toBe("const value = 1;\n");
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([
      expect.objectContaining({
        version: 1,
        sequence: 1,
        request: {
          operation: "hover",
          path: "example.ts",
          position: { line: 0, character: 7 },
        },
        projectDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceDigest: sha256(Buffer.from("const value = 1;\n")),
        languageServerDigest: languageServer.digest,
        sandbox: {
          backend: "test-sandbox",
          backendVersion: "1",
          profile: "workspace-readonly-network-deny-v1",
          policyDigest: "a".repeat(64),
        },
        result,
        resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it("discards a result when the authoritative project changes after capture", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer();
    const options: LocalSemanticCodeServiceOptions = {
      async afterSnapshot() {
        await writeFile(join(project, "example.ts"), "const value = 2;\n");
      },
    };
    const session = createLocalSemanticToolSessionFactory(
      sandbox,
      options,
    )({
      context: executionContext(project),
      languageServer,
    });

    await expect(
      session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      }),
    ).rejects.toMatchObject({
      name: "LocalSemanticCodeServiceError",
      code: "semantic_source_changed",
      message: "semantic project source changed during the query",
    });
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });
});

class RecordingSandbox implements CommandSandbox {
  readonly requests: CommandSandboxRequest[] = [];
  releases = 0;

  async prepare(request: CommandSandboxRequest) {
    this.requests.push(request);
    return {
      processContainment: "process-group" as const,
      launch: {
        executable: request.executable,
        args: request.args,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      },
      evidence: {
        backend: "test-sandbox",
        backendVersion: "1",
        profile: "workspace-readonly-network-deny-v1",
        policyDigest: "a".repeat(64),
      },
      release: async () => {
        this.releases += 1;
      },
    };
  }
}

async function temporaryProject(): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-semantic-service-")));
  temporaryDirectories.push(project);
  await writeFile(join(project, "example.ts"), "const value = 1;\n");
  await writeFile(join(project, "definition.ts"), "export const definition = 1;\n");
  return project;
}

async function fakeLanguageServer() {
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
        args: [],
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

function executionContext(project: string) {
  return {
    runId: "run-semantic",
    workflowId: "semantic-workflow",
    attempt: 1,
    cwd: project,
    projectRoot: project,
    protectedPaths: [],
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
