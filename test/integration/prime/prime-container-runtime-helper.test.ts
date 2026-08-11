import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startVerifiedPrimeContainer } from "../../fixtures/prime/prime-container-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("verified Prime container runtime helper", () => {
  it("uses the full Docker ID in protocol evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-helper-"));
    temporaryDirectories.push(root);
    const executable = join(root, "docker");
    const logPath = join(root, "args.json");
    const containerId = "a".repeat(64);
    await writeFile(
      executable,
      `#!${process.execPath}\n` +
        `const fs = require("node:fs");\n` +
        `const args = process.argv.slice(2);\n` +
        `fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args));\n` +
        `const cid = args.find((value) => value.startsWith("--cidfile="));\n` +
        `fs.writeFileSync(cid.slice("--cidfile=".length), ${JSON.stringify(containerId)} + "\\n");\n` +
        `process.stdin.resume();\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);

    const transport = await startVerifiedPrimeContainer(`sha256:${"b".repeat(64)}`, {
      dockerExecutable: executable,
      imageDevice: { path: "/dev/test-image", major: 8, minor: 1 },
      seccompPath: join(root, "seccomp.json"),
      temporaryRoot: root,
    });
    await transport.closeInput();
    await transport.release();

    expect(transport.containerId).toBe(containerId);
    const args = JSON.parse(await readFile(logPath, "utf8")) as readonly string[];
    expect(args).toContain("--pull=never");
    expect(args).toContain("--network=none");
    expect(args).toContain("--log-driver=none");
    expect(args).toContain("--no-healthcheck");
    expect(args).toContain("--device-read-bps=/dev/test-image:67108864");
    expect(args).toContain("--device-read-iops=/dev/test-image:4096");
    expect(args).toContain(`--security-opt=seccomp=${join(root, "seccomp.json")}`);
  });
});
