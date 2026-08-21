import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
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
  MAX_SEMANTIC_PROJECT_BYTES,
  MAX_SEMANTIC_PROJECT_DEPTH,
  MAX_SEMANTIC_PROJECT_ENTRIES,
  MAX_SEMANTIC_PROJECT_FILE_BYTES,
  NodeLspTransport,
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

  it("omits nested private and generated workspace collections from the projection", async () => {
    const project = await temporaryProject();
    const nestedRoot = join(project, "packages", "nested");
    const excludedPaths = [
      ".flow/private.ts",
      ".git/private.ts",
      "node_modules/private.ts",
      "dist/private.ts",
      "coverage/private.ts",
      ".flow-workspaces/private.ts",
      ".review.flow-workspaces/private.ts",
    ];
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(join(nestedRoot, "visible.ts"), "export const visible = true;\n");
    for (const path of excludedPaths) {
      const excludedPath = join(nestedRoot, path);
      await mkdir(dirname(excludedPath), { recursive: true });
      await writeFile(excludedPath, "PRIVATE_SEMANTIC_PROJECTION\n");
    }
    let visibleProjected = false;
    const projectedExcludedPaths = new Set<string>();
    const sandbox = new RecordingSandbox(undefined, async (request) => {
      visibleProjected =
        (await readFile(join(request.cwd, "packages", "nested", "visible.ts"), "utf8")) ===
        "export const visible = true;\n";
      for (const path of excludedPaths) {
        try {
          await readFile(join(request.cwd, "packages", "nested", path));
          projectedExcludedPaths.add(path);
        } catch {
          // An excluded path must not exist in the private semantic projection.
        }
      }
    });
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(project),
      languageServer: await fakeLanguageServer(),
    });

    await expect(
      session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      }),
    ).resolves.toMatchObject({ operation: "hover" });

    expect(visibleProjected).toBe(true);
    expect([...projectedExcludedPaths]).toEqual([]);
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

  it("preserves caller cancellation after launch and confirmed cleanup", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer(["hang-hover"]);
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(project),
      languageServer,
    });
    const controller = new AbortController();
    const reason = new Error("operator cancelled semantic query");
    const operation = session.query(
      {
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(reason), 50).unref();

    await expect(operation).rejects.toBe(reason);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });

  it("returns a fixed deadline after process and containment settlement", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer(["hang-hover"], 100);
    const session = createLocalSemanticToolSessionFactory(sandbox)({
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
      code: "semantic_deadline_exceeded",
      message: "semantic language-service deadline was exceeded",
    });
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });

  it("applies the request deadline before sandbox preparation", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer([], 100);
    const session = createLocalSemanticToolSessionFactory(sandbox, {
      async afterSnapshot() {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      },
    })({
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
      code: "semantic_deadline_exceeded",
      message: "semantic language-service deadline was exceeded",
    });
    expect(sandbox.requests).toEqual([]);
    expect(session.evidence()).toEqual([]);
  });

  it("classifies a server that ignores the exit notification as a deadline", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer(["ignore-exit"], 100);
    const session = createLocalSemanticToolSessionFactory(sandbox, {
      terminationGraceMs: 0,
    })({
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
      code: "semantic_deadline_exceeded",
      message: "semantic language-service deadline was exceeded",
    });
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });

  it("lets unconfirmed process termination outrank the request deadline", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer(["hang-ignore-term"], 100);
    const session = createLocalSemanticToolSessionFactory(sandbox, {
      waitForExit(child, _timeoutMs, _terminationGraceMs, signal) {
        return new Promise((resolveExit) => {
          signal?.addEventListener(
            "abort",
            () => {
              child.kill("SIGKILL");
              resolveExit({
                exitCode: null,
                signal: null,
                timedOut: false,
                aborted: true,
                spawnError: null,
                terminationIncomplete: true,
              });
            },
            { once: true },
          );
        });
      },
    })({
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
      code: "semantic_cleanup_uncertain",
      message: "semantic language-service cleanup is uncertain",
    });
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });

  it("lets cleanup uncertainty outrank source and private release failures", async () => {
    const project = await temporaryProject();
    const privateRelease = new Error("PRIVATE_SEMANTIC_RELEASE_FAILURE");
    const sandbox = new RecordingSandbox(privateRelease);
    const languageServer = await fakeLanguageServer([], 30_000);
    const session = createLocalSemanticToolSessionFactory(sandbox, {
      async afterSnapshot() {
        await writeFile(join(project, "example.ts"), "const value = 2;\n");
      },
    })({
      context: executionContext(project),
      languageServer,
    });

    let caught: unknown;
    try {
      await session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "semantic_cleanup_uncertain",
      message: "semantic language-service cleanup is uncertain",
    });
    expect(caught).not.toHaveProperty("cause");
    expect(JSON.stringify(caught)).not.toContain(privateRelease.message);
    expect(session.evidence()).toEqual([]);
  });

  it("rejects stderr overflow before recording a result", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer(["stderr-overflow"]);
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(project),
      languageServer,
    });

    await expect(
      session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      }),
    ).rejects.toMatchObject({ code: "semantic_response_limit_exceeded" });
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });

  it.each([
    {
      label: "an unsupported server capability",
      args: ["unsupported-hover"],
      path: "example.ts",
      code: "semantic_operation_unsupported",
      message: "semantic operation is not supported",
    },
    {
      label: "an unmapped project language",
      args: [],
      path: "unmapped.txt",
      code: "semantic_request_invalid",
      message: "semantic request is invalid",
    },
  ])("preserves the fixed category for $label", async ({ args, path, code, message }) => {
    const project = await temporaryProject();
    await writeFile(join(project, "unmapped.txt"), "plain text\n");
    const sandbox = new RecordingSandbox();
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(project),
      languageServer: await fakeLanguageServer(args),
    });

    await expect(
      session.query({
        operation: "hover",
        path,
        position: { line: 0, character: 0 },
      }),
    ).rejects.toMatchObject({ code, message });
    expect(sandbox.releases).toBe(1);
    expect(session.evidence()).toEqual([]);
  });

  it("rejects oversized and linked project sources before sandbox preparation", async () => {
    const project = await temporaryProject();
    const languageServer = await fakeLanguageServer([], 30_000);

    const oversizedSandbox = new RecordingSandbox();
    await writeFile(
      join(project, "oversized.ts"),
      Buffer.alloc(MAX_SEMANTIC_PROJECT_FILE_BYTES + 1, 0x78),
    );
    const oversizedSession = createLocalSemanticToolSessionFactory(oversizedSandbox)({
      context: executionContext(project),
      languageServer,
    });
    await expect(
      oversizedSession.query({ operation: "diagnostics", path: "example.ts" }),
    ).rejects.toMatchObject({ code: "semantic_response_limit_exceeded" });
    expect(oversizedSandbox.requests).toEqual([]);

    await rm(join(project, "oversized.ts"));
    await symlink(join(project, "example.ts"), join(project, "linked.ts"));
    const linkedSandbox = new RecordingSandbox();
    const linkedSession = createLocalSemanticToolSessionFactory(linkedSandbox)({
      context: executionContext(project),
      languageServer,
    });
    await expect(
      linkedSession.query({ operation: "diagnostics", path: "example.ts" }),
    ).rejects.toMatchObject({ code: "semantic_source_changed" });
    expect(linkedSandbox.requests).toEqual([]);
  });

  it("binds exact and plus-one project entry counts", async () => {
    const project = await temporaryProject();
    const existingEntries = 2;
    await writeEmptyFiles(project, MAX_SEMANTIC_PROJECT_ENTRIES - existingEntries, "bounded-entry");
    const languageServer = await fakeLanguageServer([], 30_000);
    const exactSandbox = new RecordingSandbox();
    const exactSession = createLocalSemanticToolSessionFactory(exactSandbox)({
      context: executionContext(project),
      languageServer,
    });

    await expect(
      exactSession.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 0 },
      }),
    ).resolves.toMatchObject({ operation: "hover" });

    await writeFile(join(project, "entry-plus-one.ts"), "");
    const plusOneSandbox = new RecordingSandbox();
    const plusOneSession = createLocalSemanticToolSessionFactory(plusOneSandbox)({
      context: executionContext(project),
      languageServer,
    });
    await expect(
      plusOneSession.query({ operation: "diagnostics", path: "example.ts" }),
    ).rejects.toMatchObject({ code: "semantic_response_limit_exceeded" });
    expect(plusOneSandbox.requests).toEqual([]);
    expect(plusOneSession.evidence()).toEqual([]);
  }, 30_000);

  it("binds exact and plus-one aggregate project bytes", async () => {
    const project = await temporaryProject();
    const existingBytes =
      (await readFile(join(project, "example.ts"))).byteLength +
      (await readFile(join(project, "definition.ts"))).byteLength;
    await writeProjectBytes(project, MAX_SEMANTIC_PROJECT_BYTES - existingBytes);
    const languageServer = await fakeLanguageServer([], 30_000);
    const exactSandbox = new RecordingSandbox();
    const exactSession = createLocalSemanticToolSessionFactory(exactSandbox)({
      context: executionContext(project),
      languageServer,
    });

    await expect(
      exactSession.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 0 },
      }),
    ).resolves.toMatchObject({ operation: "hover" });

    await writeFile(join(project, "bytes-plus-one.ts"), "x");
    const plusOneSandbox = new RecordingSandbox();
    const plusOneSession = createLocalSemanticToolSessionFactory(plusOneSandbox)({
      context: executionContext(project),
      languageServer,
    });
    await expect(
      plusOneSession.query({ operation: "diagnostics", path: "example.ts" }),
    ).rejects.toMatchObject({ code: "semantic_response_limit_exceeded" });
    expect(plusOneSandbox.requests).toEqual([]);
    expect(plusOneSession.evidence()).toEqual([]);
  }, 30_000);

  it("binds exact and plus-one project directory depth", async () => {
    const project = await temporaryProject();
    let directory = project;
    for (let depth = 1; depth < MAX_SEMANTIC_PROJECT_DEPTH; depth += 1) {
      directory = join(directory, `depth-${depth}`);
      await mkdir(directory);
    }
    await writeFile(join(directory, "deep.ts"), "export const deep = true;\n");
    const languageServer = await fakeLanguageServer([], 30_000);
    const exactSandbox = new RecordingSandbox();
    const exactSession = createLocalSemanticToolSessionFactory(exactSandbox)({
      context: executionContext(project),
      languageServer,
    });

    await expect(
      exactSession.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 0 },
      }),
    ).resolves.toMatchObject({ operation: "hover" });

    const plusOne = join(directory, "depth-plus-one");
    await mkdir(plusOne);
    await writeFile(join(plusOne, "too-deep.ts"), "export const tooDeep = true;\n");
    const plusOneSandbox = new RecordingSandbox();
    const plusOneSession = createLocalSemanticToolSessionFactory(plusOneSandbox)({
      context: executionContext(project),
      languageServer,
    });
    await expect(
      plusOneSession.query({ operation: "diagnostics", path: "example.ts" }),
    ).rejects.toMatchObject({ code: "semantic_response_limit_exceeded" });
    expect(plusOneSandbox.requests).toEqual([]);
    expect(plusOneSession.evidence()).toEqual([]);
  });

  it("rejects a project reached through a symbolic-link ancestor", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-semantic-linked-root-")));
    temporaryDirectories.push(root);
    const realParent = join(root, "real");
    const realProject = join(realParent, "project");
    await mkdir(realProject, { recursive: true });
    await writeFile(join(realProject, "example.ts"), "const value = 1;\n");
    await symlink(realParent, join(root, "alias"));
    const sandbox = new RecordingSandbox();
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(join(root, "alias", "project")),
      languageServer: await fakeLanguageServer(),
    });

    await expect(
      session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      }),
    ).rejects.toMatchObject({ code: "semantic_source_changed" });
    expect(sandbox.requests).toEqual([]);
    expect(session.evidence()).toEqual([]);
  });

  it("rejects a directory replacement before sandbox preparation", async () => {
    const project = await temporaryProject();
    const nested = join(project, "nested");
    const original = `${nested}-original`;
    const external = await realpath(await mkdtemp(join(tmpdir(), "flow-semantic-external-")));
    temporaryDirectories.push(external);
    await mkdir(nested);
    await writeFile(join(nested, "nested.ts"), "export const nested = true;\n");
    await writeFile(join(external, "nested.ts"), "export const PRIVATE_EXTERNAL = true;\n");
    const sandbox = new RecordingSandbox();
    let replaced = false;
    const session = createLocalSemanticToolSessionFactory(sandbox, {
      async afterProjectDirectoryObserved(path) {
        if (!replaced && path === nested) {
          replaced = true;
          await rename(nested, original);
          await symlink(external, nested);
        }
      },
    })({
      context: executionContext(project),
      languageServer: await fakeLanguageServer(),
    });

    await expect(
      session.query({
        operation: "hover",
        path: "example.ts",
        position: { line: 0, character: 7 },
      }),
    ).rejects.toMatchObject({ code: "semantic_source_changed" });
    expect(sandbox.requests).toEqual([]);
    expect(session.evidence()).toEqual([]);
  });

  it("enforces the per-attempt receipt count before another launch", async () => {
    const project = await temporaryProject();
    const sandbox = new RecordingSandbox();
    const languageServer = await fakeLanguageServer();
    const session = createLocalSemanticToolSessionFactory(sandbox)({
      context: executionContext(project),
      languageServer,
    });
    const request = {
      operation: "hover" as const,
      path: "example.ts",
      position: { line: 0, character: 7 },
    };

    for (let index = 0; index < 16; index += 1) {
      await session.query(request);
    }
    await expect(session.query(request)).rejects.toMatchObject({
      code: "semantic_response_limit_exceeded",
    });
    expect(sandbox.requests).toHaveLength(16);
    expect(sandbox.releases).toBe(16);
    expect(session.evidence()).toHaveLength(16);
  }, 30_000);

  it("interrupts a pending transport read with the exact caller reason", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new NodeLspTransport({
      stdin: input,
      stdout: output,
    } as unknown as ChildProcess);
    const controller = new AbortController();
    const reason = new Error("cancel pending language-service read");

    const read = transport.read(controller.signal);
    controller.abort(reason);

    await expect(read).rejects.toBe(reason);
    output.destroy();
    input.destroy();
  });
});

class RecordingSandbox implements CommandSandbox {
  readonly requests: CommandSandboxRequest[] = [];
  releases = 0;

  constructor(
    private readonly releaseError?: Error,
    private readonly afterPrepare?: (request: CommandSandboxRequest) => void | Promise<void>,
  ) {}

  async prepare(request: CommandSandboxRequest) {
    this.requests.push(request);
    await this.afterPrepare?.(request);
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
        if (this.releaseError !== undefined) {
          throw this.releaseError;
        }
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

async function writeEmptyFiles(root: string, count: number, prefix: string): Promise<void> {
  const batchSize = 128;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(start + batchSize, count);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) =>
        writeFile(join(root, `${prefix}-${start + offset}.ts`), ""),
      ),
    );
  }
}

async function writeProjectBytes(root: string, bytes: number): Promise<void> {
  let remaining = bytes;
  let index = 0;
  while (remaining > 0) {
    const current = Math.min(remaining, MAX_SEMANTIC_PROJECT_FILE_BYTES);
    await writeFile(join(root, `bounded-bytes-${index}.ts`), Buffer.alloc(current, 0x20));
    remaining -= current;
    index += 1;
  }
}

async function fakeLanguageServer(args: readonly string[] = [], requestTimeoutMs = 5_000) {
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
        args,
        languages: [{ id: "typescript", suffixes: [".ts"] }],
        containmentProfile: "default",
        requestTimeoutMs,
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
