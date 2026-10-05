import { describe, expect, it } from "vitest";

import { primeCleanupCommandTimeoutMs } from "../../../../src/infrastructure/oci/production-prime-oci-preparation.js";

describe("production Prime OCI preparation cleanup", () => {
  it("gives only builder and image removal the long cleanup deadline", () => {
    expect(primeCleanupCommandTimeoutMs(["buildx", "rm", "--force", "flow-prime-builder-1"])).toBe(
      600_000,
    );
    expect(
      primeCleanupCommandTimeoutMs(["image", "rm", "--force", "flow-prime-runtime:sha256-0"]),
    ).toBe(600_000);
    for (const args of [
      ["container", "ls", "--all"],
      ["container", "inspect", "flow-prime-builder-1"],
      ["container", "rm", "--force", "flow-prime-probe-1"],
      ["image", "ls", "--quiet"],
      ["buildx", "ls"],
      ["image", "inspect", "flow-prime-runtime:sha256-0"],
      [],
    ]) {
      expect(primeCleanupCommandTimeoutMs(args), args.join(" ")).toBe(30_000);
    }
  });
});
