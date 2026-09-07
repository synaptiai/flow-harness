import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { CommandSandbox } from "../../src/application/command-sandbox.js";
import { CommandNodeExecutor } from "../../src/infrastructure/process/command-node-executor.js";
import { createProductionCommandSandbox } from "../../src/infrastructure/runtime/production-node-executor.js";

const linuxTarget = process.platform === "linux" && process.arch === "x64";
const COMMAND_TIMEOUT_MS = 10_000;
const execFile = promisify(execFileCallback);
const namespaceArgs = [
  "--user",
  "--map-root-user",
  "--mount",
  "--propagation",
  "private",
  "--pid",
  "--fork",
  "--kill-child=SIGKILL",
];

// Fixture qualification only: no behavioral observer, repair eligibility, or target CLI.
// The test-owned decorator adds one read-only support root to the real native sandbox.
// Authored command context receives no new filesystem or environment authority.
describe.skipIf(!linuxTarget)("Linux x64 immutable verification fixture prerequisites", () => {
  it("preserves EACCES for mode-000 files and parents, distinct from ENOENT and readable controls", async () => {
    await withFixture(async (fixture) => {
      await assertHostPreconditions(fixture);
      const output = await executeCandidate(
        fixture,
        `${readOperationSource}
        const result = {
          deniedFile: read(${JSON.stringify(fixture.deniedFile)}),
          deniedParent: read(${JSON.stringify(fixture.childFile)}),
          missing: read(${JSON.stringify(fixture.missing)}),
          readable: read(${JSON.stringify(fixture.readable)}),
          privateExpectations: read(${JSON.stringify(fixture.expectations)}).code !== null,
          workspaceWritable: false,
        };
        fs.writeFileSync("ordinary.txt", "allowed");
        result.workspaceWritable = true;
        process.stdout.write(JSON.stringify(result));`,
      );

      // Expected outcomes stay host-owned; the candidate receives paths, not this file.
      expect(output).toEqual(JSON.parse(fixture.expectationBytes));
      await expect(readFile(join(fixture.workspace, "ordinary.txt"), "utf8")).resolves.toBe(
        "allowed",
      );
      await assertUnchangedFixtures(fixture);
    });
  }, 30_000);

  it("cannot chmod, replace, hard-link, or bypass permission fixtures through workspace aliases", async () => {
    await withFixture(async (fixture) => {
      const fileAlias = join(fixture.workspace, "file-alias");
      const parentAlias = join(fixture.workspace, "parent-alias");
      const readableAlias = join(fixture.workspace, "readable-alias");
      const privateAlias = join(fixture.workspace, "expectations-alias");
      await symlink(fixture.deniedFile, fileAlias);
      await symlink(fixture.deniedParent, parentAlias);
      await symlink(fixture.readable, readableAlias);
      await symlink(fixture.expectations, privateAlias);
      await assertHostPreconditions(fixture);
      await expect(readFile(fileAlias)).rejects.toMatchObject({ code: "EACCES" });
      await expect(readFile(join(parentAlias, "child.txt"))).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(readFile(privateAlias, "utf8")).resolves.toBe(fixture.expectationBytes);
      await expect(readFile(readableAlias, "utf8")).resolves.toBe(fixture.readableBytes);

      const output = await executeCandidate(
        fixture,
        `${readOperationSource}
        const attempt = operation => {
          try { operation(); return true; } catch { return false; }
        };
        const replacement = "replacement.txt";
        fs.writeFileSync(replacement, "candidate replacement");
        const mutations = {
          chmodRoot: attempt(() => fs.chmodSync(${JSON.stringify(fixture.inputs)}, 0o777)),
          chmodFile: attempt(() => fs.chmodSync(${JSON.stringify(fixture.deniedFile)}, 0o600)),
          chmodParent: attempt(() => fs.chmodSync(${JSON.stringify(fixture.deniedParent)}, 0o700)),
          chmodReadable: attempt(() => fs.chmodSync(${JSON.stringify(fixture.readable)}, 0o777)),
          rewriteReadable: attempt(() => fs.writeFileSync(${JSON.stringify(fixture.readable)}, "tampered")),
          rewriteDenied: attempt(() => fs.writeFileSync(${JSON.stringify(fixture.deniedFile)}, "tampered")),
          unlinkReadable: attempt(() => fs.unlinkSync(${JSON.stringify(fixture.readable)})),
          replaceReadable: attempt(() => fs.renameSync(replacement, ${JSON.stringify(fixture.readable)})),
          createMissing: attempt(() => fs.writeFileSync(${JSON.stringify(fixture.missing)}, "tampered")),
          hardLinkReadable: attempt(() => fs.linkSync(${JSON.stringify(fixture.readable)}, "hard-link.txt")),
          chmodAlias: attempt(() => fs.chmodSync(${JSON.stringify(fileAlias)}, 0o600)),
        };
        const reads = {
          deniedFile: read(${JSON.stringify(fixture.deniedFile)}),
          deniedParent: read(${JSON.stringify(fixture.childFile)}),
          fileAlias: read(${JSON.stringify(fileAlias)}),
          parentAlias: read(${JSON.stringify(join(parentAlias, "child.txt"))}),
          readableAlias: read(${JSON.stringify(readableAlias)}),
          procFile: read(${JSON.stringify(`/proc/self/root${fixture.deniedFile}`)}),
          procParent: read(${JSON.stringify(`/proc/self/root${fixture.childFile}`)}),
          procReadable: read(${JSON.stringify(`/proc/self/root${fixture.readable}`)}),
          procMissing: read(${JSON.stringify(`/proc/self/root${fixture.missing}`)}),
          missing: read(${JSON.stringify(fixture.missing)}),
          readable: read(${JSON.stringify(fixture.readable)}),
          privateAliasDenied: read(${JSON.stringify(privateAlias)}).code !== null,
        };
        process.stdout.write(JSON.stringify({ mutations, reads }));`,
      );

      expect(output).toEqual({
        mutations: {
          chmodRoot: false,
          chmodFile: false,
          chmodParent: false,
          chmodReadable: false,
          rewriteReadable: false,
          rewriteDenied: false,
          unlinkReadable: false,
          replaceReadable: false,
          createMissing: false,
          hardLinkReadable: false,
          chmodAlias: false,
        },
        reads: {
          deniedFile: { code: "EACCES" },
          deniedParent: { code: "EACCES" },
          fileAlias: { code: "EACCES" },
          parentAlias: { code: "EACCES" },
          readableAlias: { code: null, value: fixture.readableBytes },
          procFile: { code: "EACCES" },
          procParent: { code: "EACCES" },
          procReadable: { code: null, value: fixture.readableBytes },
          procMissing: { code: "ENOENT" },
          missing: { code: "ENOENT" },
          readable: { code: null, value: fixture.readableBytes },
          privateAliasDenied: true,
        },
      });
      await assertUnchangedFixtures(fixture);
    });
  }, 30_000);

  it("blocks bind/remount bypass both directly and through a nested user/mount namespace", async () => {
    await withFixture(async (fixture) => {
      await assertHostPreconditions(fixture);
      const versions = await qualifyNamespaceControl(fixture);
      const directAlias = join(fixture.workspace, "direct-mount");
      const nestedAlias = join(fixture.workspace, "nested-mount");
      await mkdir(directAlias);
      await mkdir(nestedAlias);
      const nestedSource = `${subprocessSource}
        ${namespaceIdentitySource}
        ${mountAttackSource(fixture.inputs, nestedAlias)}
        const mutation = operation => { try { operation(); return true; } catch { return false; } };
        const read = path => {
          try { return { code: null, value: fs.readFileSync(path, "utf8") }; }
          catch (error) { return { code: error.code || "UNKNOWN" }; }
        };
        process.stdout.write(JSON.stringify({
          mount: attack(),
          chmodFile: mutation(() => fs.chmodSync(${JSON.stringify(fixture.deniedFile)}, 0o600)),
          chmodParent: mutation(() => fs.chmodSync(${JSON.stringify(fixture.deniedParent)}, 0o700)),
          deniedFile: read(${JSON.stringify(fixture.deniedFile)}),
          deniedParent: read(${JSON.stringify(fixture.childFile)}),
          readable: read(${JSON.stringify(fixture.readable)}),
        }));`;
      const output = (await executeCandidate(
        fixture,
        `${subprocessSource}
        ${mountAttackSource(fixture.inputs, directAlias)}
        const versions = [run("/usr/bin/unshare", ["--version"]), run("/usr/bin/mount", ["--version"])];
        const direct = attack();
        const previousNamespaces = [fs.readlinkSync("/proc/self/ns/user"), fs.readlinkSync("/proc/self/ns/mnt")];
        const nestedScript = "const previousNamespaces = " + JSON.stringify(previousNamespaces) + ";" + ${JSON.stringify(nestedSource)};
        const nested = run("/usr/bin/unshare", [...${JSON.stringify(namespaceArgs)}, process.execPath, "-e", nestedScript], 4000);
        process.stdout.write(JSON.stringify({ versions, direct, nested }));
      `,
      )) as { versions: SubprocessResult[]; direct: MountAttempt; nested: SubprocessResult };
      expect(output.versions).toEqual(versions);
      assertMountDenied(output.direct);
      if (output.nested.status === 0) {
        expect(output.nested.stderr).toBe("");
        const nested = JSON.parse(output.nested.stdout) as {
          mount: MountAttempt;
          chmodFile: boolean;
          chmodParent: boolean;
          deniedFile: unknown;
          deniedParent: unknown;
          readable: unknown;
        };
        assertMountDenied(nested.mount);
        expect(nested.chmodFile).toBe(false);
        expect(nested.chmodParent).toBe(false);
        expect(nested.deniedFile).toEqual({ code: "EACCES" });
        expect(nested.deniedParent).toEqual({ code: "EACCES" });
        expect(nested.readable).toEqual({ code: null, value: fixture.readableBytes });
      } else {
        // Host control proved these exact options/tools usable. Only an explicit permission
        // denial is accepted here, not missing binaries, resource exhaustion or invalid options.
        expect(output.nested.stdout).toBe("");
        expect(output.nested.status).toBe(1);
        expect(output.nested.stderr).toMatch(
          /^unshare: .*?(?:Operation not permitted|Permission denied)\s*$/s,
        );
      }
      await assertUnchangedFixtures(fixture);
    });
  }, 30_000);
});

interface SubprocessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface MountAttempt {
  readonly stage: "bind" | "remount";
  readonly result: SubprocessResult;
}

const subprocessSource = `
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const run = (executable, args, timeout = 1000) => {
    const result = spawnSync(executable, args, {
      encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 16384,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    if (result.error || result.signal !== null || result.status === null) {
      throw new Error("Probe tool did not complete: " + executable + ": " + String(result.error || result.signal));
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
`;

// unshare(1): private propagation prevents mounts affecting the parent namespace;
// --pid/--kill-child confines and terminates descendants if its supervisor is killed.
// https://man7.org/linux/man-pages/man1/unshare.1.html
const namespaceIdentitySource = `
  const currentNamespaces = [fs.readlinkSync("/proc/self/ns/user"), fs.readlinkSync("/proc/self/ns/mnt")];
  if (process.getuid() !== 0 || currentNamespaces.some((value, index) => value === previousNamespaces[index])) {
    throw new Error("Fresh user and mount namespaces were not established");
  }
`;

function mountAttackSource(source: string, target: string): string {
  // Only remount a mount successfully created by this attempt. A non-mountpoint EINVAL
  // must never count as a successful defense against remounting a read-only bind.
  return `
    const attack = () => {
      const bound = run("/usr/bin/mount", ["--no-mtab", "--bind", ${JSON.stringify(source)}, ${JSON.stringify(target)}]);
      if (bound.status !== 0) return { stage: "bind", result: bound };
      return { stage: "remount", result: run("/usr/bin/mount", ["--no-mtab", "--options", "remount,bind,rw", ${JSON.stringify(source)}, ${JSON.stringify(target)}]) };
    };
  `;
}

function assertMountDenied(attempt: MountAttempt): void {
  expect(["bind", "remount"]).toContain(attempt.stage);
  expect(attempt.result.status).not.toBe(0);
  expect(attempt.result.stdout).toBe("");
  expect(attempt.result.stderr).toMatch(
    /permission denied|operation not permitted|must be superuser|read-only/i,
  );
}

async function qualifyNamespaceControl(fixture: Fixture): Promise<SubprocessResult[]> {
  const options = {
    encoding: "utf8" as const,
    timeout: 7000,
    killSignal: "SIGKILL" as const,
    maxBuffer: 16384,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  };
  const versions: SubprocessResult[] = [];
  for (const executable of ["/usr/bin/unshare", "/usr/bin/mount"]) {
    const result = await execFile(executable, ["--version"], { ...options, timeout: 1000 });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("util-linux");
    versions.push({ status: 0, stdout: result.stdout, stderr: result.stderr });
  }
  const source = join(fixture.workspace, "namespace-control-source");
  const target = join(fixture.workspace, "namespace-control-target");
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(source, "control.txt"), "before");
  const previousNamespaces = await Promise.all([
    readlink("/proc/self/ns/user"),
    readlink("/proc/self/ns/mnt"),
  ]);
  // No mount command runs in the controller namespace. The child first verifies both
  // fresh namespace identities and uses only these disposable scratch directories.
  // The same bind/remount syntax must work outside SRT, including the RO->RW change.
  // https://man7.org/linux/man-pages/man8/mount.8.html
  const script = `const previousNamespaces = ${JSON.stringify(previousNamespaces)};
    ${subprocessSource}
    ${namespaceIdentitySource}
    const source = ${JSON.stringify(source)};
    const target = ${JSON.stringify(target)};
    const checkedMount = args => {
      const result = run("/usr/bin/mount", ["--no-mtab", ...args]);
      if (result.status !== 0 || result.stdout !== "" || result.stderr !== "") throw new Error(JSON.stringify(result));
    };
    checkedMount(["--bind", source, target]);
    checkedMount(["--options", "remount,bind,ro", source, target]);
    let readOnlyError = null;
    try { fs.writeFileSync(target + "/control.txt", "forbidden"); } catch (error) { readOnlyError = error.code; }
    if (readOnlyError !== "EROFS") throw new Error("Read-only mount control was ineffective");
    checkedMount(["--options", "remount,bind,rw", source, target]);
    fs.writeFileSync(target + "/control.txt", "after");
    process.stdout.write(JSON.stringify({ namespacesDistinct: true, readOnlyError, value: fs.readFileSync(target + "/control.txt", "utf8") }));
  `;
  fixture.executionUnconfirmed = true;
  const result = await execFile(
    "/usr/bin/unshare",
    [...namespaceArgs, process.execPath, "-e", script],
    options,
  );
  fixture.executionUnconfirmed = false;
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    namespacesDistinct: true,
    readOnlyError: "EROFS",
    value: "after",
  });
  expect(
    await Promise.all([readlink("/proc/self/ns/user"), readlink("/proc/self/ns/mnt")]),
  ).toEqual(previousNamespaces);
  await expect(readFile(join(source, "control.txt"), "utf8")).resolves.toBe("after");
  // The private bind vanished with its namespace; the original empty target is visible again.
  await expect(readdir(target)).resolves.toEqual([]);
  return versions;
}

const readOperationSource = `
  const fs = require("node:fs");
  const read = path => {
    try { return { code: null, value: fs.readFileSync(path, "utf8") }; }
    catch (error) { return { code: typeof error.code === "string" ? error.code : "UNKNOWN" }; }
  };
`;

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly inputs: string;
  readonly verifier: string;
  readonly deniedFile: string;
  readonly deniedParent: string;
  readonly childFile: string;
  readonly readable: string;
  readonly missing: string;
  readonly expectations: string;
  readonly readableBytes: string;
  readonly deniedBytes: string;
  readonly childBytes: string;
  readonly expectationBytes: string;
  executionUnconfirmed: boolean;
  integrityUnconfirmed: boolean;
  baseline?: FixtureTree;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-verifier-fixture-")));
  const inputs = join(root, "inputs");
  const verifier = join(root, "verifier");
  const deniedParent = join(inputs, "denied-parent");
  const token = randomUUID();
  const readableBytes = `synthetic-readable-${token}`;
  const fixture: Fixture = {
    root,
    workspace: join(root, "workspace"),
    inputs,
    verifier,
    deniedFile: join(inputs, "denied.txt"),
    deniedParent,
    childFile: join(deniedParent, "child.txt"),
    readable: join(inputs, "readable.txt"),
    missing: join(inputs, "missing.txt"),
    expectations: join(verifier, "expectations.json"),
    readableBytes,
    deniedBytes: `synthetic-denied-${token}`,
    childBytes: `synthetic-child-${token}`,
    expectationBytes: JSON.stringify({
      deniedFile: { code: "EACCES" },
      deniedParent: { code: "EACCES" },
      missing: { code: "ENOENT" },
      readable: { code: null, value: readableBytes },
      privateExpectations: true,
      workspaceWritable: true,
    }),
    executionUnconfirmed: false,
    integrityUnconfirmed: false,
  };
  const failures: unknown[] = [];
  try {
    for (const path of [fixture.workspace, inputs, verifier, deniedParent]) {
      await mkdir(path, { mode: 0o700 });
    }
    for (const [path, bytes] of [
      [fixture.deniedFile, fixture.deniedBytes],
      [fixture.childFile, fixture.childBytes],
      [fixture.readable, fixture.readableBytes],
      [fixture.expectations, fixture.expectationBytes],
    ] as const) {
      await writeFile(path, bytes, { mode: 0o600 });
    }
    await chmod(fixture.deniedFile, 0);
    await chmod(deniedParent, 0);
    fixture.baseline = await captureFixtureTree(fixture);
    await run(fixture);
  } catch (error) {
    failures.push(error);
  }
  try {
    if (fixture.executionUnconfirmed || fixture.integrityUnconfirmed) {
      throw new Error(
        `Execution settlement or fixture identity unconfirmed; retained fixture ${root}`,
      );
    }
    if (fixture.baseline !== undefined) await assertUnchangedFixtures(fixture);
    // Only test-owned paths are restored, and only after command settlement is confirmed.
    for (const [path, mode] of [
      [inputs, 0o700],
      [deniedParent, 0o700],
      [fixture.deniedFile, 0o600],
    ] as const) {
      await chmod(path, mode).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch (error) {
    failures.push(new Error(`Fixture cleanup failed; retained path ${root}`, { cause: error }));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Probe and fixture cleanup failed");
}

async function assertHostPreconditions(fixture: Fixture): Promise<void> {
  // Root/capability bypass or a broken setup fails qualification instead of skipping it.
  await expect(readFile(fixture.deniedFile)).rejects.toMatchObject({ code: "EACCES" });
  await expect(readFile(fixture.childFile)).rejects.toMatchObject({ code: "EACCES" });
  await expect(readFile(fixture.missing)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(fixture.readable, "utf8")).resolves.toBe(fixture.readableBytes);
  await expect(readFile(fixture.expectations, "utf8")).resolves.toBe(fixture.expectationBytes);
  expect((await lstat(fixture.inputs)).mode & 0o777).toBe(0o700);
  expect((await lstat(fixture.verifier)).mode & 0o777).toBe(0o700);
  expect((await lstat(fixture.expectations)).mode & 0o777).toBe(0o600);
  expect((await lstat(fixture.deniedFile)).mode & 0o777).toBe(0);
  expect((await lstat(fixture.deniedParent)).mode & 0o777).toBe(0);
  expect((await lstat(fixture.readable)).mode & 0o777).toBe(0o600);
}

async function assertUnchangedFixtures(fixture: Fixture): Promise<void> {
  if (fixture.baseline === undefined) throw new Error("Missing fixture identity baseline");
  fixture.integrityUnconfirmed = true;
  expect(await captureFixtureTree(fixture, fixture.baseline)).toEqual(fixture.baseline);
  await assertHostPreconditions(fixture);
  fixture.integrityUnconfirmed = false;
}

interface FixtureEntry {
  readonly dev: string;
  readonly ino: string;
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  children?: string[];
  bytes?: string;
  target?: string;
}

type FixtureTree = Record<string, FixtureEntry>;

async function captureFixtureTree(fixture: Fixture, baseline?: FixtureTree): Promise<FixtureTree> {
  const tree: FixtureTree = {};
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 4 || Object.keys(tree).length >= 32)
      throw new Error("Fixture inventory exceeded bound");
    const path = relative === "." ? fixture.root : join(fixture.root, relative);
    const info = await lstat(path, { bigint: true });
    const entry: FixtureEntry = {
      dev: String(info.dev),
      ino: String(info.ino),
      type: info.isDirectory()
        ? "directory"
        : info.isFile()
          ? "file"
          : info.isSymbolicLink()
            ? "symlink"
            : "other",
      mode: Number(info.mode),
    };
    if (baseline !== undefined) {
      const expected = baseline[relative];
      if (expected === undefined) throw new Error(`Unexpected fixture entry: ${relative}`);
      // Identity/type checks precede chmod or traversal: never follow a replaced parent/link.
      expect(entry, `Fixture identity: ${relative}`).toEqual({
        dev: expected.dev,
        ino: expected.ino,
        type: expected.type,
        mode: expected.mode,
      });
    }
    tree[relative] = entry;
    // The workspace itself is anchored, but its candidate-owned contents are intentionally mutable.
    if (path === fixture.workspace) return;
    if (entry.type === "symlink") {
      entry.target = await readlink(path);
      return;
    }
    if (entry.type !== "file" && entry.type !== "directory")
      throw new Error(`Unexpected fixture type: ${relative}`);
    if (entry.type === "file" && info.size > 4096n)
      throw new Error("Fixture content exceeded bound");
    const originalMode = entry.mode & 0o7777;
    const comparisonMode = originalMode | (entry.type === "directory" ? 0o500 : 0o400);
    if (comparisonMode !== originalMode) await chmod(path, comparisonMode);
    try {
      if (entry.type === "file") {
        entry.bytes = await readFile(path, "utf8");
      } else {
        entry.children = (await readdir(path)).sort();
        if (baseline !== undefined)
          expect(entry.children, `Fixture inventory: ${relative}`).toEqual(
            baseline[relative]?.children,
          );
        for (const name of entry.children)
          await visit(relative === "." ? name : join(relative, name), depth + 1);
      }
    } finally {
      if (comparisonMode !== originalMode) await chmod(path, originalMode);
    }
  };
  await visit(".", 0);
  return tree;
}

async function executeCandidate(fixture: Fixture, script: string): Promise<unknown> {
  const production = createProductionCommandSandbox("native", fixture.workspace);
  const supportPaths = Object.freeze([fixture.inputs]);
  const sandbox: CommandSandbox = {
    prepare: (request) => production.prepare({ ...request, runtimeSupportPaths: supportPaths }),
  };
  const executor = new CommandNodeExecutor({ sandbox, preparationSettlementMs: 5_000 });
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), COMMAND_TIMEOUT_MS + 1_000);
  fixture.executionUnconfirmed = true;
  try {
    const outcome = await executor.execute(
      {
        id: "fixture-probe",
        type: "command",
        dependsOn: [],
        command: {
          executable: process.execPath,
          args: ["-e", script],
          timeoutMs: COMMAND_TIMEOUT_MS,
        },
      },
      {
        runId: `fixture-${randomUUID()}`,
        workflowId: "verification-observer-fixture",
        attempt: 1,
        cwd: fixture.workspace,
        projectRoot: fixture.workspace,
        protectedPaths: [fixture.verifier],
        signal: cancellation.signal,
      },
    );
    fixture.executionUnconfirmed =
      outcome.status === "failed" &&
      (outcome.error.sideEffectStatus === "uncertain" ||
        outcome.error.code === "command_sandbox_cleanup_failed");
    expect(outcome.status, JSON.stringify(outcome)).toBe("succeeded");
    if (outcome.evidence?.kind !== "command") throw new Error("Missing real command evidence");
    expect(outcome.evidence.sandbox).toMatchObject({
      backend: "anthropic-sandbox-runtime",
      backendVersion: "0.0.70",
      profile: "workspace-write-network-deny-v1",
    });
    expect(outcome.evidence).toMatchObject({
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      stderr: "",
      timedOut: false,
      aborted: false,
    });
    return JSON.parse(outcome.evidence.stdout);
  } finally {
    clearTimeout(timer);
  }
}
