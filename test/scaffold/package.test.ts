import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  name?: string;
  scripts?: Record<string, string>;
}

describe("package contract", () => {
  it("pins the embedded runtime and exposes the Flow binary", async () => {
    const manifestUrl = new URL("../../package.json", import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as PackageManifest;

    expect(manifest.name).toBe("@synaptiai/flow-harness");
    expect(manifest.bin).toEqual({ flow: "dist/cli/main.js" });
    expect(manifest.engines?.node).toBe(">=22.19.0");
    expect(manifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(manifest.dependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.84.0");
    expect(manifest.scripts?.check).toContain("npm run typecheck");
    expect(manifest.scripts?.check).toContain("npm run test");
    expect(manifest.scripts?.check).toContain("npm run build");
  });
});
