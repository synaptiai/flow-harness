import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  auditPrimePythonLock,
  parsePrimePythonRequirements,
} from "../../../../src/infrastructure/oci/prime-dependency-audit.js";

describe("Prime dependency audit", () => {
  it("parses the exact package versions in the Python lock", () => {
    expect(parsePrimePythonRequirements(lockSource())).toEqual([
      { name: "example-one", version: "1.2.3" },
      { name: "example_two", version: "4.5.6" },
    ]);
  });

  it("accepts a locked Python set with no known vulnerabilities", async () => {
    const lockPath = await writeLock(lockSource());
    const query = vi.fn(async () => [[], []] as const);

    await expect(auditPrimePythonLock({ lockPath, query })).resolves.toEqual({
      packages: 2,
      vulnerabilities: 0,
    });
    expect(query).toHaveBeenCalledWith([
      { name: "example-one", version: "1.2.3" },
      { name: "example_two", version: "4.5.6" },
    ]);
  });

  it("rejects any known vulnerability in the locked Python set", async () => {
    const lockPath = await writeLock(lockSource());

    await expect(
      auditPrimePythonLock({
        lockPath,
        query: async () => [["GHSA-example-1111"], []],
      }),
    ).rejects.toThrow(/GHSA-example-1111/);
  });
});

async function writeLock(source: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-audit-")));
  const path = join(root, "python-requirements.lock");
  await writeFile(path, source);
  return path;
}

function lockSource(): string {
  return [
    "# generated lock",
    "example-one==1.2.3 \\",
    `    --hash=sha256:${"a".repeat(64)}`,
    "example_two==4.5.6 \\",
    `    --hash=sha256:${"b".repeat(64)}`,
    "",
  ].join("\n");
}
