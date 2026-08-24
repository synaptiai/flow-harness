import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Lean proof runtime package boundary", () => {
  it("ships the complete fixed proof appliance and preparation command", async () => {
    const packageManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly files?: readonly string[] };

    expect(packageManifest.files).toContain("proof-container");
    expect(packageManifest.files).toContain("scripts/prepare-proof-runtime.mjs");
    for (const path of [
      "proof-container/Dockerfile",
      "proof-container/build-inputs.json",
      "proof-container/profile.json",
      "proof-container/go.mod",
      "proof-container/cmd/flow-proof-supervisor/main.go",
      "proof-container/cmd/flow-proof-supervisor/containment_linux.go",
      "scripts/prepare-proof-runtime.mjs",
    ]) {
      await expect(access(resolve(repositoryRoot, path))).resolves.toBeUndefined();
    }
  });

  it("binds the authoritative build manifest to the executed Docker recipe", async () => {
    const inputs = JSON.parse(
      await readFile(resolve(repositoryRoot, "proof-container/build-inputs.json"), "utf8"),
    ) as {
      readonly sourceDateEpoch: number;
      readonly baseImages: Readonly<Record<"golang" | "rust" | "debian", string>>;
      readonly lean: { readonly url: string; readonly sha256: string };
      readonly mathlib: { readonly url: string; readonly sha256: string };
      readonly safeVerify: { readonly url: string; readonly sha256: string };
      readonly lean4export: { readonly url: string; readonly sha256: string };
      readonly nanoda: { readonly url: string; readonly sha256: string };
    };
    const [dockerfile, preparation] = await Promise.all([
      readFile(resolve(repositoryRoot, "proof-container/Dockerfile"), "utf8"),
      readFile(resolve(repositoryRoot, "scripts/prepare-proof-runtime.mjs"), "utf8"),
    ]);

    expect(dockerfile).toContain(`ARG GO_IMAGE=${inputs.baseImages.golang}`);
    expect(dockerfile).toContain(`ARG RUST_IMAGE=${inputs.baseImages.rust}`);
    expect(dockerfile).toContain(`ARG DEBIAN_IMAGE=${inputs.baseImages.debian}`);
    expect(dockerfile).toContain(`ARG SOURCE_DATE_EPOCH=${inputs.sourceDateEpoch}`);
    for (const source of [
      inputs.lean,
      inputs.mathlib,
      inputs.safeVerify,
      inputs.lean4export,
      inputs.nanoda,
    ]) {
      expect(dockerfile).toContain(`--checksum=sha256:${source.sha256}`);
      expect(dockerfile).toContain(source.url);
    }
    expect(preparation).toContain("GO_IMAGE: buildInputs.baseImages.golang");
    expect(preparation).toContain("RUST_IMAGE: buildInputs.baseImages.rust");
    expect(preparation).toContain("DEBIAN_IMAGE: buildInputs.baseImages.debian");
    expect(preparation).toContain("SOURCE_DATE_EPOCH: String(buildInputs.sourceDateEpoch)");
  });

  it("seeds TLS trust from a pinned stage before reading Debian snapshots", async () => {
    const dockerfile = await readFile(
      resolve(repositoryRoot, "proof-container/Dockerfile"),
      "utf8",
    );
    const trustSeed = dockerfile.indexOf(
      "COPY --from=supervisor-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
    );
    const snapshotRead = dockerfile.indexOf(
      "https://snapshot.debian.org/archive/debian/20260823T000000Z",
    );

    expect(trustSeed).toBeGreaterThanOrEqual(0);
    expect(snapshotRead).toBeGreaterThan(trustSeed);
  });

  it("isolates toolchain build phases and retains bounded failure diagnostics", async () => {
    const [dockerfile, preparation] = await Promise.all([
      readFile(resolve(repositoryRoot, "proof-container/Dockerfile"), "utf8"),
      readFile(resolve(repositoryRoot, "scripts/prepare-proof-runtime.mjs"), "utf8"),
    ]);
    const lean = dockerfile.indexOf("RUN mkdir -p /opt/lean");
    const safeVerify = dockerfile.indexOf("RUN mkdir -p /src/safe-verify /opt/flow/bin");
    const lean4export = dockerfile.indexOf("RUN mkdir -p /src/lean4export");
    const mathlib = dockerfile.indexOf("RUN mkdir -p /src/mathlib-expected /opt/flow/lean-lib");

    expect(lean).toBeGreaterThanOrEqual(0);
    expect(safeVerify).toBeGreaterThan(lean);
    expect(lean4export).toBeGreaterThan(safeVerify);
    expect(mathlib).toBeGreaterThan(lean4export);
    expect(preparation).toContain("const maximumFailureDiagnosticBytes = 65_536;");
    expect(preparation).toContain(".slice(-maximumFailureDiagnosticBytes)");
  });

  it("durably publishes an owner-private attestation", async () => {
    const preparation = await readFile(
      resolve(repositoryRoot, "scripts/prepare-proof-runtime.mjs"),
      "utf8",
    );

    expect(preparation).toContain("constants.O_NOFOLLOW");
    expect(preparation).toContain("await syncDirectory(directory)");
  });

  it("freezes the target before creating the isolated submission phase", async () => {
    const supervisor = await readFile(
      resolve(repositoryRoot, "proof-container/cmd/flow-proof-supervisor/main.go"),
      "utf8",
    );
    const targetCompile = supervisor.indexOf("targetCompile := runLean");
    const targetLock = supervisor.indexOf("lockCompilerTree(paths.targetRoot)");
    const targetFreeze = supervisor.indexOf("freezeTargetArtifact(paths)");
    const submissionPrepare = supervisor.indexOf("prepareSubmissionWorkspace(req, paths)");
    const submissionCompile = supervisor.indexOf("submissionCompile := runLean");

    expect(targetCompile).toBeGreaterThanOrEqual(0);
    expect(targetLock).toBeGreaterThan(targetCompile);
    expect(targetFreeze).toBeGreaterThan(targetLock);
    expect(submissionPrepare).toBeGreaterThan(targetFreeze);
    expect(submissionCompile).toBeGreaterThan(submissionPrepare);
  });
});
