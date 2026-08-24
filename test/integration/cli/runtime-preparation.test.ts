import { describe, expect, it, vi } from "vitest";

import { main } from "../../../src/cli/main.js";

describe("runtime preparation CLI", () => {
  it("prepares the fixed Prime Agent runtime", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const preparePrimeRuntime = vi.fn(async () => ({
      descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
      imageId: `sha256:${"a".repeat(64)}`,
      imageManifestSha256: "b".repeat(64),
      sbomSha256: "c".repeat(64),
    }));

    const exitCode = await main(
      ["runtime", "prepare", "prime-agent"],
      { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
      { cwd: "/project", preparePrimeRuntime },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(preparePrimeRuntime).toHaveBeenCalledWith({ cwd: "/project", signal: undefined });
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      prepared: true,
      descriptorPath: "/project/.flow/runtime/prime-agent/oci-attestation.json",
      imageId: `sha256:${"a".repeat(64)}`,
      imageManifestSha256: "b".repeat(64),
      sbomSha256: "c".repeat(64),
    });
  });

  it("prepares the reproducible Lean proof runtime in the selected project", async () => {
    const stdout: string[] = [];
    const prepareLeanProofRuntime = vi.fn(async () => ({
      descriptorPath: "/project/.flow/proof-runtime/attestation.json",
      imageDigest: `sha256:${"d".repeat(64)}`,
      buildAttestationDigest: "e".repeat(64),
      dependencyManifestDigest: "f".repeat(64),
      profileDigest: "1".repeat(64),
      canonicalTag: `flow-lean-proof:sha256-${"d".repeat(64)}`,
    }));

    const exitCode = await main(
      ["runtime", "prepare", "lean-proof"],
      { stdout: (text) => stdout.push(text), stderr: () => undefined },
      { cwd: "/project", prepareLeanProofRuntime },
    );

    expect(exitCode).toBe(0);
    expect(prepareLeanProofRuntime).toHaveBeenCalledWith({ cwd: "/project", signal: undefined });
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      prepared: true,
      descriptorPath: "/project/.flow/proof-runtime/attestation.json",
      imageDigest: `sha256:${"d".repeat(64)}`,
    });
  });

  it("rejects every other runtime command", async () => {
    const stderr: string[] = [];

    const exitCode = await main(
      ["runtime", "prepare", "omp"],
      { stdout: () => undefined, stderr: (text) => stderr.push(text) },
      { cwd: "/project" },
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toMatch(/runtime prepare requires prime-agent or lean-proof/i);
  });
});
