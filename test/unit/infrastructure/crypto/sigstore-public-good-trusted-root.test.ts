import { createHash } from "node:crypto";

import { TrustedRoot } from "@sigstore/protobuf-specs";
import { describe, expect, it } from "vitest";

import {
  createSigstorePublicGoodTrustedRoot,
  SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SOURCE,
} from "../../../../src/infrastructure/sigstore-public-good-trusted-root.js";

describe("shipped Sigstore public-good trusted root", () => {
  it("binds one immutable official root-signing target", () => {
    expect(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SOURCE).toEqual({
      repository: "https://github.com/sigstore/root-signing",
      commit: "e2dd69e9013072c308f5dd1800c27a8c2491cca2",
      targetsVersion: 14,
      bytes: 6_787,
      sha256: "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66",
      canonicalBytes: 5_775,
      canonicalSha256: "45e4fc0bc5bbd7d0bb053489d0e1db8d97582802f5c4d96df1ee4e995084ac2a",
    });
  });

  it("loads all proof authorities without a network or filesystem input", () => {
    const root = createSigstorePublicGoodTrustedRoot();

    expect(root.mediaType).toBe("application/vnd.dev.sigstore.trustedroot+json;version=0.1");
    expect(root.tlogs).toHaveLength(2);
    expect(root.certificateAuthorities).toHaveLength(2);
    expect(root.ctlogs).toHaveLength(2);
    expect(root.timestampAuthorities).toHaveLength(1);
    const canonical = Buffer.from(JSON.stringify(TrustedRoot.toJSON(root)));
    expect(canonical).toHaveLength(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SOURCE.canonicalBytes);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SOURCE.canonicalSha256,
    );
  });
});
