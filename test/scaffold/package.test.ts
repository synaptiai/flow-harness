import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  author?: string;
  bin?: Record<string, string>;
  bugs?: { url?: string };
  description?: string;
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  homepage?: string;
  keywords?: string[];
  name?: string;
  os?: string[];
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
  version?: string;
}

describe("package contract", () => {
  it("pins the embedded runtime and exposes the Flow binary", async () => {
    const manifestUrl = new URL("../../package.json", import.meta.url);
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as PackageManifest;

    expect(manifest.name).toBe("@synaptiai/flow-harness");
    expect(manifest.version).toBe("0.0.0");
    expect(manifest.description).toBe(
      "Provider-neutral coding-agent harness with deterministic workflow graphs, durable evidence, and fail-closed sandboxed execution",
    );
    expect(manifest.author).toBe("Synapti AI");
    expect(manifest.homepage).toBe("https://github.com/synaptiai/flow-harness#readme");
    expect(manifest.bugs).toEqual({ url: "https://github.com/synaptiai/flow-harness/issues" });
    expect(manifest.publishConfig).toEqual({ access: "public" });
    expect(manifest.keywords).toEqual(
      expect.arrayContaining([
        "agent-harness",
        "coding-agents",
        "workflow-engine",
        "sandbox",
        "typescript",
      ]),
    );
    expect(manifest.bin).toEqual({ flow: "dist/cli/main.js" });
    expect(manifest.engines?.node).toBe(">=22.19.0");
    expect(manifest.os).toEqual(["darwin", "linux"]);
    expect(manifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(manifest.files).toContain("SECURITY.md");
    expect(manifest.files).toContain("SUPPORT.md");
    expect(manifest.dependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.84.0");
    expect(manifest.dependencies?.typebox).toBe("1.3.7");
    expect(manifest.scripts?.build).toContain("npm run clean");
    expect(manifest.scripts?.clean).toContain("rmSync('dist'");
    expect(manifest.scripts?.check).toContain("npm run typecheck");
    expect(manifest.scripts?.check).toContain("npm run test");
    expect(manifest.scripts?.check).toContain("npm run build");
  });
});
