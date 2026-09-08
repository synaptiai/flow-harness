import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ownedTest } from "../fixtures/owned-test-scope.js";

const execFile = promisify(execFileCallback);
const launcher = fileURLToPath(
  new URL("../../native/verification-observer/build.mjs", import.meta.url),
);
const sourceRoot = process.env.FLOW_TEST_RELAY_SOURCE_ROOT;
const names = [
  "socat_1.8.1.3.orig.tar.bz2",
  "socat_1.8.1.3-1.dsc",
  "musl-1.2.6.tar.gz",
  "musl-1.2.6.tar.gz.asc",
  "iconv.patch",
  "qsort.patch",
  "resolver.patch",
] as const;

async function check(root: string) {
  return execFile(process.execPath, [launcher, "--check-relay-sources", root], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 3_000,
    maxBuffer: 32_768,
  });
}

it(
  "routes relay source admission separately from executable builds",
  ownedTest(async (scope) => {
    const root = await scope.temporaryDirectory("flow-relay-empty-");
    await expect(check(root)).rejects.toThrow("relay source integrity: inventory mismatch");
  }),
);

it(
  "rejects invalid source before creating a relay build context",
  ownedTest(async (scope) => {
    const owner = await scope.temporaryDirectory("flow-relay-context-");
    const source = join(owner, "source");
    await mkdir(source);
    await expect(
      execFile(
        process.execPath,
        [launcher, "--freeze-relay-context", source, join(owner, "context")],
        {
          timeout: 3_000,
          maxBuffer: 32_768,
        },
      ),
    ).rejects.toThrow("relay source integrity: inventory mismatch");
  }),
);

// Inputs must be the actual authenticated public archives and patch files.
// No generated archive-shaped data or successful-build substitute is accepted.
describe.skipIf(sourceRoot === undefined)("selected relay source admission", () => {
  it(
    "captures the restricted profile recipe separately from the unwrapped baseline",
    ownedTest(async (scope) => {
      const owner = await scope.temporaryDirectory("flow-relay-profile-");
      const source = join(owner, "source");
      const output = join(owner, "profile");
      await mkdir(source);
      for (const name of names)
        await copyFile(join(requiredSourceRoot(), name), join(source, name));
      const result = await execFile(
        process.execPath,
        [launcher, "--freeze-relay-profile-context", source, output],
        { timeout: 3_000, maxBuffer: 32_768 },
      );
      const evidence = JSON.parse(result.stdout);
      expect(evidence.baselineOnly).toBe(false);
      expect(evidence.profile).toBe("host-bridge-ipv4-loopback-v1");
      expect(evidence.relayQualified).toBe(false);
      expect(Object.keys(evidence.inputs)).toHaveLength(17);
      const wrapper = await readFile(
        new URL("../../native/verification-relay/restricted-relay.c", import.meta.url),
      );
      expect(await readFile(join(output, "restricted-relay.c"))).toEqual(wrapper);
      expect(evidence.inputs["restricted-relay.c"]).toBe(
        createHash("sha256").update(wrapper).digest("hex"),
      );
      for (const [name, sourcePath] of [
        ["restricted-relay.LICENSE", "../../native/verification-relay/restricted-relay.LICENSE"],
        ["Flow-Apache-2.0.LICENSE", "../../LICENSE"],
      ] as const) {
        const license = await readFile(new URL(sourcePath, import.meta.url));
        expect(await readFile(join(output, name))).toEqual(license);
        expect(evidence.inputs[name]).toBe(createHash("sha256").update(license).digest("hex"));
      }
      const baseline = join(owner, "baseline");
      await execFile(process.execPath, [launcher, "--freeze-relay-context", source, baseline], {
        timeout: 3_000,
        maxBuffer: 32_768,
      });
      await expect(lstat(join(baseline, "restricted-relay.c"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }),
  );

  it(
    "checks the actual release bundle without claiming build or runtime qualification",
    ownedTest(async (scope) => {
      const root = await scope.temporaryDirectory("flow-relay-source-");
      for (const name of names) await copyFile(join(requiredSourceRoot(), name), join(root, name));
      const before = await Promise.all(names.map((name) => readFile(join(root, name))));
      const result = await check(root);
      expect(result.stderr).toBe("");
      const manifest = await readFile(
        new URL("../../native/verification-relay/source-manifest.json", import.meta.url),
      );
      expect(JSON.parse(result.stdout)).toEqual({
        verified: true,
        sourceOnly: true,
        inputCount: 7,
        sourceManifestSha256: createHash("sha256").update(manifest).digest("hex"),
        relayQualified: false,
      });
      expect(await Promise.all(names.map((name) => readFile(join(root, name))))).toEqual(before);
    }),
  );

  it(
    "captures a separate build context from authentic bytes and refuses replacement",
    ownedTest(async (scope) => {
      const owner = await scope.temporaryDirectory("flow-relay-freeze-");
      const source = join(owner, "source");
      const output = join(owner, "context");
      await mkdir(source);
      for (const name of names)
        await copyFile(join(requiredSourceRoot(), name), join(source, name));
      const args = [launcher, "--freeze-relay-context", source, output];
      const result = await execFile(process.execPath, args, { timeout: 3_000, maxBuffer: 32_768 });
      const evidence = JSON.parse(result.stdout) as {
        inputs: Record<string, string>;
        baselineOnly: boolean;
        relayQualified: boolean;
      };
      expect(evidence.baselineOnly).toBe(true);
      expect(evidence.relayQualified).toBe(false);
      expect(Object.keys(evidence.inputs)).toHaveLength(14);
      for (const [path, hash] of Object.entries(evidence.inputs)) {
        expect(
          createHash("sha256")
            .update(await readFile(join(output, path)))
            .digest("hex"),
        ).toBe(hash);
      }
      await expect(execFile(process.execPath, args, { timeout: 3_000 })).rejects.toThrow("EEXIST");
      const captured = await readFile(join(output, "sources/resolver.patch"));
      await writeFile(join(source, "resolver.patch"), "changed after capture");
      expect(await readFile(join(output, "sources/resolver.patch"))).toEqual(captured);
      const rejected = join(owner, "rejected");
      await expect(
        execFile(process.execPath, [launcher, "--freeze-relay-context", source, rejected], {
          timeout: 3_000,
        }),
      ).rejects.toThrow("relay source integrity:");
      await expect(lstat(rejected)).rejects.toMatchObject({ code: "ENOENT" });
    }),
  );

  it.for(names)("rejects same-size mutation of authenticated input %s", (name, context) =>
    ownedTest(async (scope) => {
      const root = await scope.temporaryDirectory("flow-relay-mutated-");
      for (const entry of names)
        await copyFile(join(requiredSourceRoot(), entry), join(root, entry));
      const handle = await open(join(root, name), "r+");
      try {
        const byte = Buffer.alloc(1);
        expect((await handle.read(byte, 0, 1, 0)).bytesRead).toBe(1);
        byte[0] = (byte[0] as number) ^ 1;
        expect((await handle.write(byte, 0, 1, 0)).bytesWritten).toBe(1);
      } finally {
        await handle.close();
      }
      await expect(check(root)).rejects.toThrow("relay source integrity: digest mismatch");
    })(context),
  );

  it.for(["symlink", "directory", "oversized", "manifest", "missing", "fifo"] as const)(
    "rejects an invalid source bundle: %s",
    (mode, context) =>
      ownedTest(async (scope) => {
        const root = await scope.temporaryDirectory("flow-relay-invalid-");
        for (const entry of names)
          await copyFile(join(requiredSourceRoot(), entry), join(root, entry));
        const path = join(root, "resolver.patch");
        if (mode === "manifest") {
          await writeFile(
            join(root, "source-manifest.json"),
            JSON.stringify({ version: 1, inputs: [] }),
          );
        } else if (mode === "oversized") {
          const file = await open(path, "a");
          try {
            await file.write(Buffer.from("\n"));
          } finally {
            await file.close();
          }
        } else {
          await rm(path);
          if (mode === "symlink") await symlink(join(requiredSourceRoot(), "resolver.patch"), path);
          else if (mode === "directory") await mkdir(path);
          else if (mode === "fifo") await execFile("/usr/bin/mkfifo", [path], { timeout: 3_000 });
        }
        await expect(check(root)).rejects.toThrow("relay source integrity:");
      })(context),
  );

  it(
    "rejects an indirect source root even when every input is authentic",
    ownedTest(async (scope) => {
      const owner = await scope.temporaryDirectory("flow-relay-indirect-");
      const root = join(owner, "source");
      await mkdir(root);
      for (const entry of names)
        await copyFile(join(requiredSourceRoot(), entry), join(root, entry));
      const alias = join(owner, "alias");
      await symlink(root, alias);
      await expect(check(alias)).rejects.toThrow("relay source integrity: indirect root");
    }),
  );
});

function requiredSourceRoot(): string {
  if (sourceRoot === undefined) throw new Error("Explicit authenticated source bundle required");
  return sourceRoot;
}
