import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  author?: string;
  bin?: Record<string, string>;
  bugs?: { url?: string };
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
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
    expect(manifest.engines?.node).toBe(">=26.7.0");
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
    expect(manifest.scripts?.["pack:check"]).toBe("node scripts/verify-package.mjs");
  });

  it("keeps the host Node baseline consistent across CI and public prerequisites", async () => {
    const [manifestSource, workflow, readme, contributing] = await Promise.all([
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
      readFile(new URL("../../README.md", import.meta.url), "utf8"),
      readFile(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as PackageManifest;

    expect(manifest.engines?.node).toBe(">=26.7.0");
    expect(manifest.devDependencies?.["@types/node"]).toBe("26.2.0");
    expect(workflow.match(/node-version: 26\.7\.0/g)).toHaveLength(2);
    expect(readme).toContain("Node.js 26.7 or newer");
    expect(contributing).toContain("Node.js 26.7 or newer");
  });

  it("pins the offline Sigstore verifier stack without verifier-owned network clients", async () => {
    const [manifestSource, notices] = await Promise.all([
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as PackageManifest;

    expect(manifest.dependencies?.["@sigstore/bundle"]).toBe("5.0.0");
    expect(manifest.dependencies?.["@sigstore/protobuf-specs"]).toBe("0.5.1");
    expect(manifest.dependencies?.["@sigstore/verify"]).toBe("4.1.2");
    expect(manifest.dependencies?.sigstore).toBeUndefined();
    expect(manifest.dependencies?.["@sigstore/tuf"]).toBeUndefined();
    expect(notices).toContain("`@sigstore/verify` 4.1.2");
    expect(notices).toContain("`@sigstore/bundle` 5.0.0");
    expect(notices).toContain("`@sigstore/protobuf-specs` 0.5.1");
    expect(notices).toContain("e2dd69e9013072c308f5dd1800c27a8c2491cca2");
  });
});
