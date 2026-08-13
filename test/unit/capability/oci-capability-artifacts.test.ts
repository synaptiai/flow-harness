import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertOciDescriptorBytes,
  FLOW_CAPABILITY_ARTIFACT_TYPE,
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  MAX_OCI_CAPABILITY_MANIFEST_BYTES,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  parseOciCapabilityArtifactManifest,
  parseOciCapabilityArtifactReference,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../src/domain/capability/oci-capability-artifacts.js";

describe("OCI capability artifacts", () => {
  it("parses one canonical public repository and exact manifest digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;

    expect(
      parseOciCapabilityArtifactReference(`registry.example.test/flow/review@${digest}`),
    ).toEqual({
      canonical: `registry.example.test/flow/review@${digest}`,
      registryOrigin: "https://registry.example.test",
      repository: "flow/review",
      manifestDigest: digest,
    });
  });

  it.each([
    "registry.example.test/flow/review:latest",
    "registry.example.test/flow/review",
    `registry.example.test/flow/review@sha512:${"a".repeat(128)}`,
    `registry.example.test/Flow/review@sha256:${"a".repeat(64)}`,
    `REGISTRY.example.test/flow/review@sha256:${"a".repeat(64)}`,
    `https://registry.example.test/flow/review@sha256:${"a".repeat(64)}`,
    `user@registry.example.test/flow/review@sha256:${"a".repeat(64)}`,
    `registry.example.test:443/flow/review@sha256:${"a".repeat(64)}`,
    `registry.example.test/flow/review@sha256:${"A".repeat(64)}`,
    `registry.example.test/flow/review@sha256:${"a".repeat(64)}?token=private`,
    `registry.example.test/flow/review@sha256:${"a".repeat(64)}#fragment`,
    `localhost/flow/review@sha256:${"a".repeat(64)}`,
    `127.0.0.1/flow/review@sha256:${"a".repeat(64)}`,
    ` registry.example.test/flow/review@sha256:${"a".repeat(64)}`,
  ])("rejects mutable or non-canonical registry authority %j", (reference) => {
    expect(() => parseOciCapabilityArtifactReference(reference)).toThrow(
      /canonical public OCI repository.*exact sha256 digest/i,
    );
  });

  it("parses a digest-pinned strict two-layer capability artifact manifest", () => {
    const manifest = manifestBytes();
    const manifestDigest = digest(manifest);

    expect(parseOciCapabilityArtifactManifest(manifest, manifestDigest)).toEqual({
      digest: manifestDigest,
      bytes: manifest.byteLength,
      bundle: {
        mediaType: FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
        digest: `sha256:${"b".repeat(64)}`,
        size: 1_024,
      },
      sigstoreBundle: {
        mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
        digest: `sha256:${"c".repeat(64)}`,
        size: 2_048,
      },
    });
  });

  it("checks the manifest digest before JSON parsing", () => {
    const malformed = Buffer.from("PRIVATE malformed JSON");

    expect(() => parseOciCapabilityArtifactManifest(malformed, `sha256:${"0".repeat(64)}`)).toThrow(
      /OCI capability manifest digest mismatch/i,
    );
    expect(() => parseOciCapabilityArtifactManifest(malformed, digest(malformed))).toThrow(
      /OCI capability manifest JSON/i,
    );
  });

  it.each([
    ["media type", { mediaType: "application/vnd.oci.image.index.v1+json" }],
    ["artifact type", { artifactType: "application/vnd.example.other.v1" }],
    ["schema version", { schemaVersion: 1 }],
    [
      "config digest",
      {
        config: {
          mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
          digest: `sha256:${"0".repeat(64)}`,
          size: 2,
        },
      },
    ],
    [
      "config size",
      {
        config: {
          mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
          digest: OCI_EMPTY_CONFIG_DIGEST,
          size: 3,
        },
      },
    ],
    ["extra top-level field", { subject: { digest: `sha256:${"d".repeat(64)}` } }],
  ])("rejects a contradictory %s", (_label, change) => {
    const candidate = { ...manifestObject(), ...change };
    const source = Buffer.from(JSON.stringify(candidate));

    expect(() => parseOciCapabilityArtifactManifest(source, digest(source))).toThrow();
  });

  it("requires exactly the bundle and Sigstore layers in canonical order", () => {
    const canonical = manifestObject();
    const reversed = Buffer.from(
      JSON.stringify({ ...canonical, layers: [...canonical.layers].reverse() }),
    );
    const extra = Buffer.from(
      JSON.stringify({
        ...canonical,
        layers: [
          ...canonical.layers,
          {
            mediaType: "application/octet-stream",
            digest: `sha256:${"d".repeat(64)}`,
            size: 1,
          },
        ],
      }),
    );

    expect(() => parseOciCapabilityArtifactManifest(reversed, digest(reversed))).toThrow();
    expect(() => parseOciCapabilityArtifactManifest(extra, digest(extra))).toThrow();
  });

  it.each([
    ["alternate bundle media type", { mediaType: "application/octet-stream" }],
    ["alternate digest algorithm", { digest: `sha512:${"b".repeat(128)}` }],
    ["uppercase digest", { digest: `sha256:${"B".repeat(64)}` }],
    ["zero bytes", { size: 0 }],
    ["unexpected annotation", { annotations: { private: "marker" } }],
  ])("rejects a bundle descriptor with %s", (_label, change) => {
    const canonical = manifestObject();
    const source = Buffer.from(
      JSON.stringify({
        ...canonical,
        layers: [{ ...canonical.layers[0], ...change }, canonical.layers[1]],
      }),
    );

    expect(() => parseOciCapabilityArtifactManifest(source, digest(source))).toThrow();
  });

  it("rejects duplicate JSON keys before manifest schema validation", () => {
    const source = Buffer.from(
      JSON.stringify(manifestObject()).replace(
        '"schemaVersion":2',
        '"schemaVersion":2,"schemaVersion":2',
      ),
    );

    expect(() => parseOciCapabilityArtifactManifest(source, digest(source))).toThrow(
      /duplicate object key.*schemaVersion/i,
    );
  });

  it("accepts the exact manifest byte limit and rejects one additional byte", () => {
    const canonical = manifestBytes();
    const exact = Buffer.concat([
      canonical,
      Buffer.alloc(MAX_OCI_CAPABILITY_MANIFEST_BYTES - canonical.byteLength, 0x20),
    ]);
    const overflow = Buffer.concat([exact, Buffer.from(" ")]);

    expect(parseOciCapabilityArtifactManifest(exact, digest(exact)).bytes).toBe(
      MAX_OCI_CAPABILITY_MANIFEST_BYTES,
    );
    expect(() => parseOciCapabilityArtifactManifest(overflow, digest(overflow))).toThrow(
      /OCI capability manifest.*bytes/i,
    );
  });

  it("checks descriptor size and digest before layer parsing", () => {
    const content = Buffer.from("PRIVATE exact layer bytes");
    const descriptor = {
      mediaType: FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
      digest: digest(content),
      size: content.byteLength,
    } as const;

    expect(() =>
      assertOciDescriptorBytes(descriptor, content, "capability bundle layer"),
    ).not.toThrow();
    expect(() =>
      assertOciDescriptorBytes(
        { ...descriptor, size: content.byteLength + 1 },
        content,
        "capability bundle layer",
      ),
    ).toThrow(/byte count mismatch/i);
    expect(() =>
      assertOciDescriptorBytes(
        { ...descriptor, digest: `sha256:${"0".repeat(64)}` },
        content,
        "capability bundle layer",
      ),
    ).toThrow(/digest mismatch/i);
  });
});

function manifestBytes(): Buffer {
  return Buffer.from(JSON.stringify(manifestObject()));
}

function manifestObject() {
  return {
    schemaVersion: 2,
    mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    artifactType: FLOW_CAPABILITY_ARTIFACT_TYPE,
    config: {
      mediaType: OCI_EMPTY_CONFIG_MEDIA_TYPE,
      digest: OCI_EMPTY_CONFIG_DIGEST,
      size: 2,
    },
    layers: [
      {
        mediaType: FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
        digest: `sha256:${"b".repeat(64)}`,
        size: 1_024,
      },
      {
        mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
        digest: `sha256:${"c".repeat(64)}`,
        size: 2_048,
      },
    ],
  };
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
