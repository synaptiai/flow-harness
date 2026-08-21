import { describe, expect, it, vi } from "vitest";

import { inspectPreparedPrimeRuntime } from "../../../../src/infrastructure/oci/prime-environment-doctor.js";

describe("Prime environment doctor", () => {
  it("reopens the exact prepared attestation without lifecycle mutation", async () => {
    const readAttestation = vi.fn(async () => undefined);
    const signal = new AbortController().signal;

    await inspectPreparedPrimeRuntime("/workspace/project", signal, {
      platform: "linux",
      architecture: "x64",
      readAttestation,
    });

    expect(readAttestation).toHaveBeenCalledWith(
      "/workspace/project/.flow/runtime/prime-agent/oci-attestation.json",
      signal,
    );
  });

  it.each([
    { platform: "darwin", architecture: "x64" },
    { platform: "linux", architecture: "arm64" },
  ])("rejects unsupported $platform/$architecture before attestation access", async (host) => {
    const readAttestation = vi.fn();

    await expect(
      inspectPreparedPrimeRuntime("/workspace/project", new AbortController().signal, {
        ...host,
        readAttestation,
      }),
    ).rejects.toThrow("prepared Prime runtime requires Linux on x64");
    expect(readAttestation).not.toHaveBeenCalled();
  });

  it("preserves exact cancellation after attestation settlement", async () => {
    const cancellation = new Error("PRIVATE_CANCELLATION");
    const controller = new AbortController();

    await expect(
      inspectPreparedPrimeRuntime("/workspace/project", controller.signal, {
        platform: "linux",
        architecture: "x64",
        readAttestation: async () => {
          controller.abort(cancellation);
        },
      }),
    ).rejects.toBe(cancellation);
  });
});
