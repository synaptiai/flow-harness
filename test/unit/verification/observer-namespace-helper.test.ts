import { describe, expect, it } from "vitest";

import {
  admitObserverNamespaceHelper,
  type ObserverHelperFileSystem,
} from "../../../src/infrastructure/verification/observer-namespace-helper.js";

const helperPath = "/opt/flow/observer/observer-apply-seccomp";
const digest = "a".repeat(64);

interface Entry {
  readonly kind: "file" | "directory";
  readonly uid: number;
  readonly mode: number;
  readonly size?: number;
}

function fileSystem(
  overrides: Record<string, Partial<Entry>> = {},
  options: { readonly realpath?: string; readonly digest?: string } = {},
): ObserverHelperFileSystem & { readonly reads: string[] } {
  const entries: Record<string, Entry> = {
    "/": { kind: "directory", uid: 0, mode: 0o755 },
    "/opt": { kind: "directory", uid: 0, mode: 0o755 },
    "/opt/flow": { kind: "directory", uid: 0, mode: 0o755 },
    "/opt/flow/observer": { kind: "directory", uid: 0, mode: 0o755 },
    [helperPath]: { kind: "file", uid: 0, mode: 0o755, size: 900_000 },
  };
  for (const [path, change] of Object.entries(overrides)) {
    const current = entries[path];
    if (current === undefined) throw new Error(`unknown fixture path ${path}`);
    entries[path] = { ...current, ...change };
  }
  const reads: string[] = [];
  return {
    reads,
    realpath: async (path) => options.realpath ?? path,
    lstat: async (path) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return {
        isFile: () => entry.kind === "file",
        isDirectory: () => entry.kind === "directory",
        uid: entry.uid,
        mode: entry.mode,
        size: entry.size ?? 4096,
      };
    },
    readDigest: async (path) => {
      reads.push(path);
      return options.digest ?? digest;
    },
  };
}

describe("observer namespace helper admission", () => {
  it("admits a root-owned helper in root-owned directories with the expected digest", async () => {
    const files = fileSystem();
    await expect(
      admitObserverNamespaceHelper({ path: helperPath, sha256: digest }, files),
    ).resolves.toEqual({ kind: "admitted", helper: { path: helperPath, sha256: digest } });
    expect(files.reads).toEqual([helperPath]);
  });

  it.each([
    ["a relative path", { path: "observer-apply-seccomp", sha256: digest }],
    ["an unnormalized path", { path: "/opt/flow/../flow/observer/x", sha256: digest }],
    ["an uppercase digest", { path: helperPath, sha256: "A".repeat(64) }],
    ["a short digest", { path: helperPath, sha256: "a".repeat(63) }],
  ])("rejects %s before touching the filesystem", async (_name, candidate) => {
    const files = fileSystem();
    const result = await admitObserverNamespaceHelper(candidate, files);
    expect(result.kind).toBe("rejected");
    expect(files.reads).toEqual([]);
  });

  it.each([
    ["a symbolic link", {}, { realpath: "/opt/flow/real-helper" }],
    ["a helper owned by another user", { [helperPath]: { uid: 1001 } }, {}],
    ["a group-writable helper", { [helperPath]: { mode: 0o775 } }, {}],
    ["a world-writable helper", { [helperPath]: { mode: 0o757 } }, {}],
    ["a non-executable helper", { [helperPath]: { mode: 0o644 } }, {}],
    ["a directory in place of the helper", { [helperPath]: { kind: "directory" as const } }, {}],
    ["an oversized helper", { [helperPath]: { size: 16 * 1024 * 1024 + 1 } }, {}],
    ["a parent owned by another user", { "/opt/flow/observer": { uid: 1001 } }, {}],
    ["a world-writable ancestor", { "/opt": { mode: 0o1777 } }, {}],
    ["a group-writable root", { "/": { mode: 0o775 } }, {}],
    ["mismatched helper bytes", {}, { digest: "b".repeat(64) }],
  ] as const)("rejects %s", async (_name, overrides, options) => {
    const result = await admitObserverNamespaceHelper(
      { path: helperPath, sha256: digest },
      fileSystem(overrides, options),
    );
    expect(result.kind).toBe("rejected");
  });

  it("rejects a helper it cannot inspect instead of throwing", async () => {
    const result = await admitObserverNamespaceHelper(
      { path: "/opt/flow/observer/missing", sha256: digest },
      fileSystem(),
    );
    expect(result).toEqual({ kind: "rejected", reason: "helper could not be inspected" });
  });
});
