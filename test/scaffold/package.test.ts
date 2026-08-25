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
  exports?: Record<string, never>;
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

    expect(manifest.name).toBe("@synapti/flow-harness");
    expect(manifest.version).toBe("0.1.0-alpha.3");
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
    expect(manifest.bin).toEqual({ flow: "dist/cli/launcher.js" });
    expect(manifest.exports).toEqual({});
    expect(manifest.engines?.node).toBe(">=26.7.0");
    expect(manifest.os).toEqual(["darwin", "linux"]);
    expect(manifest.files).toContain("docs");
    expect(manifest.files).toContain("compatibility");
    expect(manifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(manifest.files).toContain("npm-shrinkwrap.json");
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
    expect(manifest.scripts?.["release:prepare"]).toBe(
      "npm run build && node scripts/build-package-release.mjs",
    );
    expect(manifest.scripts?.["release:verify"]).toBe("node scripts/verify-package.mjs --release");
    for (const lifecycle of [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepack",
      "postpack",
    ]) {
      expect(manifest.scripts?.[lifecycle]).toBeUndefined();
    }
  });

  it("runs the environment doctor through the installed package", async () => {
    const verifier = await readFile(
      new URL("../../scripts/verify-package.mjs", import.meta.url),
      "utf8",
    );

    expect(verifier).toContain('await run(flowBinary, ["doctor"]');
    expect(verifier).toContain('join(consumerRoot, "node_modules", "@synapti", "flow-harness")');
    expect(verifier).not.toContain(
      'join(consumerRoot, "node_modules", "@synaptiai", "flow-harness")',
    );
    expect(verifier).toContain(
      '"Package release failed during installed native sandbox diagnostic"',
    );
    expect(verifier).toContain("withPackageReleaseStage");
    for (const stage of [
      "build package source",
      "load package verification modules",
      "resolve package source revision",
      "create package artifact",
      "verify package artifact",
      "install package artifact",
      "verify installed package",
      "verify installed compatibility",
      "run installed quick start",
      "inspect quick-start project",
      "verify installed diagnostic",
      "compare quick-start project",
      "verify quick-start browser",
      "verify installed prime boundary",
      "cleanup package verification",
    ]) {
      expect(verifier).toContain(stage);
    }
    expect(verifier).toContain('["quickstart", projectRoot, "--run-id", "packed-quickstart"]');
    expect(verifier).not.toContain('["init", projectRoot]');
    expect(verifier).toContain("operationFailed");
    expect(verifier).toContain("readInstalledDoctorReport");
    expect(verifier).toContain('doctorReport.target, "project"');
    expect(verifier).toContain("doctorReport.ok, true");
    expect(verifier).toContain("quickstartProjectBeforeDoctor");
    expect(verifier).toContain("snapshotProjectFiles(projectRoot)");
    expect(verifier).toContain('"the quick-start project snapshot is incomplete"');
    expect(verifier).toContain('"the quick-start project snapshot omits filesystem identity"');
    expect(verifier).toContain('"flow doctor changed the quick-start project"');
    expect(verifier).toContain('"docs/reference/tools-and-capabilities.md"');
    expect(verifier).toContain('"docs/specs/flow-public-capability-catalog-v1.json"');
    expect(verifier).toContain('"runtime.host"');
    expect(verifier).toContain('"sandbox.native"');
    expect(verifier).toContain('["compatibility", "check"]');
    expect(verifier).toContain("verifyRejectedPackageImports");
    expect(verifier).toContain('"@synapti/flow-harness/dist/cli/main.js"');
    expect(verifier).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("publishes one exact production dependency tree for the CLI application", async () => {
    const shrinkwrap = JSON.parse(
      await readFile(new URL("../../npm-shrinkwrap.json", import.meta.url), "utf8"),
    ) as {
      readonly name?: string;
      readonly version?: string;
      readonly lockfileVersion?: number;
      readonly packages?: Readonly<Record<string, { readonly dev?: boolean }>>;
    };

    expect(shrinkwrap).toMatchObject({
      name: "@synapti/flow-harness",
      version: "0.1.0-alpha.3",
      lockfileVersion: 3,
    });
    expect(shrinkwrap.packages?.[""]?.dev).not.toBe(true);
    expect(shrinkwrap.packages?.["node_modules/zod"]?.dev).not.toBe(true);
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
    expect(workflow.match(/node-version: 26\.7\.0/g)).toHaveLength(3);
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
