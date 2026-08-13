import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import {
  FLOW_CAPABILITY_ARTIFACT_TYPE,
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../../src/domain/capability/oci-capability-artifacts.js";
import type {
  PinnedHttpsRequest,
  PinnedHttpsResponse,
  ResolvedNetworkAddress,
} from "../../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";
import {
  createStrictOciCapabilityRegistry,
  OciCapabilityRegistryError,
} from "../../../../src/infrastructure/http/strict-oci-capability-registry.js";

const reference = `registry.example.test/flow/review@sha256:${"a".repeat(64)}`;
const bundle = Buffer.from("exact capability bundle bytes");
const sigstore = Buffer.from("exact Sigstore verification bytes");

describe("strict OCI capability registry", () => {
  it("acquires one digest manifest and two exact layers with one anonymous pull token", async () => {
    const fixture = registryFixture();

    await expect(fixture.registry.acquire(fixture.reference)).resolves.toMatchObject({
      reference: { canonical: fixture.reference },
      manifest: { digest: fixture.manifestDigest },
      capabilityBundle: bundle,
      sigstoreBundle: sigstore,
    });

    expect(fixture.resolveHostname.mock.calls.map(([hostname]) => hostname)).toEqual([
      "registry.example.test",
      "auth.example.test",
    ]);
    const requests = fixture.openPinnedResponse.mock.calls.map(([request]) => request);
    expect(requests.map(({ url }) => url)).toEqual([
      `https://registry.example.test/v2/flow/review/manifests/${fixture.manifestDigest}`,
      "https://auth.example.test/token?service=registry.example.test&scope=repository%3Aflow%2Freview%3Apull",
      `https://registry.example.test/v2/flow/review/manifests/${fixture.manifestDigest}`,
      `https://registry.example.test/v2/flow/review/blobs/${digest(bundle)}`,
      `https://registry.example.test/v2/flow/review/blobs/${digest(sigstore)}`,
    ]);
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[1]?.headers.authorization).toBeUndefined();
    expect(requests.slice(2).map(({ headers }) => headers.authorization)).toEqual([
      "Bearer PRIVATE_TOKEN",
      "Bearer PRIVATE_TOKEN",
      "Bearer PRIVATE_TOKEN",
    ]);
    expect(fixture.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    ['Basic realm="https://auth.example.test/token"', "acquire anonymous registry token"],
    [
      'Bearer realm="http://auth.example.test/token",service="registry.example.test",scope="repository:flow/review:pull"',
      "acquire anonymous registry token",
    ],
    [
      'Bearer realm="https://user:PRIVATE@auth.example.test/token",service="registry.example.test",scope="repository:flow/review:pull"',
      "acquire anonymous registry token",
    ],
    [
      'Bearer realm="https://auth.example.test/token",service="registry.example.test",scope="repository:other/review:pull"',
      "acquire anonymous registry token",
    ],
    [
      'Bearer realm="https://auth.example.test/token",service="registry.example.test",scope="repository:flow/review:push"',
      "acquire anonymous registry token",
    ],
    [
      'Bearer realm="https://auth.example.test/token",scope="repository:flow/review:pull"',
      "acquire anonymous registry token",
    ],
  ])("rejects unsafe bearer challenge %j", async (challenge, stage) => {
    const fixture = registryFixture({ challenge });

    await expectClosedFailure(fixture.registry.acquire(fixture.reference), stage);
    expect(JSON.stringify(fixture.openPinnedResponse.mock.calls)).not.toContain("PRIVATE");
  });

  it.each([
    ["extra token field", { token: "PRIVATE_TOKEN", expires_in: 300 }],
    ["both token fields", { token: "PRIVATE_TOKEN", access_token: "PRIVATE_OTHER" }],
    ["empty token", { token: "" }],
    ["non-string token", { token: 7 }],
  ])("rejects a non-canonical anonymous token response: %s", async (_label, tokenBody) => {
    const fixture = registryFixture({ tokenBody });

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference),
      "acquire anonymous registry token",
    );
  });

  it("never sends a registry bearer token to a redirected blob origin", async () => {
    const redirectedBundle = Buffer.from("redirected bundle bytes");
    const fixture = registryFixture({ bundle: redirectedBundle, redirectBundle: true });

    await expect(fixture.registry.acquire(fixture.reference)).resolves.toMatchObject({
      capabilityBundle: redirectedBundle,
    });
    const redirected = fixture.openPinnedResponse.mock.calls
      .map(([request]) => request)
      .find(({ url }) => url.startsWith("https://storage.example.test/"));
    expect(redirected).toMatchObject({
      url: expect.stringContaining("?PRIVATE_SIGNED_QUERY=value"),
      hostname: "storage.example.test",
    });
    expect(redirected?.headers.authorization).toBeUndefined();
    expect(fixture.resolveHostname).toHaveBeenCalledWith(
      "storage.example.test",
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["registry", "registry.example.test"],
    ["token realm", "auth.example.test"],
    ["blob redirect", "storage.example.test"],
  ])("rejects a non-public %s address before opening that origin", async (location, hostname) => {
    const fixture = registryFixture({ redirectBundle: location === "blob redirect" });
    fixture.resolveHostname.mockImplementation(async (requested) => [
      requested === hostname
        ? { address: "127.0.0.1", family: 4 as const }
        : { address: "93.184.216.34", family: 4 as const },
    ]);

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference),
      location === "registry"
        ? "resolve OCI registry"
        : location === "token realm"
          ? "acquire anonymous registry token"
          : "read capability bundle layer",
    );
  });

  it("rejects redirect loops, manifest redirects, and token redirects", async () => {
    await expectClosedFailure(
      registryFixture({ manifestRedirect: true }).registry.acquire(reference),
      "read OCI manifest",
    );
    await expectClosedFailure(
      registryFixture({ tokenRedirect: true }).registry.acquire(reference),
      "acquire anonymous registry token",
    );
    const loop = registryFixture({ redirectBundle: true, redirectLoop: true });
    await expectClosedFailure(
      loop.registry.acquire(loop.reference),
      "read capability bundle layer",
    );
  });

  it.each([
    [
      "manifest digest",
      { manifestDigestHeader: `sha256:${"0".repeat(64)}` },
      "validate OCI manifest",
    ],
    [
      "manifest content type",
      { manifestContentType: "application/vnd.oci.image.index.v1+json" },
      "validate OCI manifest",
    ],
    ["bundle digest", { corruptBundle: true }, "read capability bundle layer"],
    ["bundle size", { bundleContentLengthDelta: 1 }, "read capability bundle layer"],
    ["Sigstore digest", { corruptSigstore: true }, "read Sigstore bundle layer"],
  ])("rejects a contradictory %s before returning bytes", async (_label, options, stage) => {
    const fixture = registryFixture(options);

    await expectClosedFailure(fixture.registry.acquire(fixture.reference), stage);
  });

  it("uses one total deadline across DNS, authentication, manifest, and layers", async () => {
    const fixture = registryFixture({ stallToken: true, timeoutMs: 10 });

    await expectClosedFailure(fixture.registry.acquire(fixture.reference), "acquire OCI artifact");
    expect(fixture.closes[0]).toHaveBeenCalledOnce();
  });

  it("stops before DNS when cancellation is already requested", async () => {
    const fixture = registryFixture();
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_CANCEL"));

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, controller.signal),
      "acquire OCI artifact",
    );
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it("settles cancellation and closes a response whose body stops yielding", async () => {
    const fixture = registryFixture({ stallBundleBody: true });
    const controller = new AbortController();
    const pending = fixture.registry.acquire(fixture.reference, controller.signal);
    await vi.waitFor(() => {
      expect(
        fixture.openPinnedResponse.mock.calls.some(([request]) =>
          request.url.includes(`/blobs/${digest(bundle)}`),
        ),
      ).toBe(true);
    });

    controller.abort(new Error("PRIVATE_CANCEL"));
    const outcome = await Promise.race([
      pending.then(
        () => ({ status: "resolved" as const, error: undefined }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      delay(100).then(() => ({ status: "blocked" as const, error: undefined })),
    ]);

    expect(outcome).toEqual({
      status: "rejected",
      error: new OciCapabilityRegistryError("acquire OCI artifact"),
    });
    expect(fixture.closes.at(-1)).toHaveBeenCalledOnce();
    expect(
      fixture.openPinnedResponse.mock.calls.some(([request]) =>
        request.url.includes(`/blobs/${digest(sigstore)}`),
      ),
    ).toBe(false);
  });

  it("rejects an invalid reference before DNS or HTTP", async () => {
    const fixture = registryFixture();

    await expectClosedFailure(
      fixture.registry.acquire("registry.example.test/flow/review:latest"),
      "validate OCI reference",
    );
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });
});

interface RegistryFixtureOptions {
  readonly bundle?: Buffer;
  readonly challenge?: string;
  readonly tokenBody?: unknown;
  readonly redirectBundle?: boolean;
  readonly redirectLoop?: boolean;
  readonly manifestRedirect?: boolean;
  readonly tokenRedirect?: boolean;
  readonly corruptBundle?: boolean;
  readonly corruptSigstore?: boolean;
  readonly bundleContentLengthDelta?: number;
  readonly manifestDigestHeader?: string;
  readonly manifestContentType?: string;
  readonly stallToken?: boolean;
  readonly stallBundleBody?: boolean;
  readonly timeoutMs?: number;
}

function registryFixture(options: RegistryFixtureOptions = {}) {
  const bundleBytes = options.bundle ?? bundle;
  const manifest = manifestBytes(bundleBytes, sigstore);
  const manifestDigest = digest(manifest);
  const canonicalReference = `registry.example.test/flow/review@${manifestDigest}`;
  const closes: ReturnType<typeof vi.fn>[] = [];
  const resolveHostname = vi.fn(
    async (_hostname: string, _signal: AbortSignal): Promise<readonly ResolvedNetworkAddress[]> => [
      { address: "93.184.216.34", family: 4 as const },
    ],
  );
  let registryManifestCalls = 0;
  const openPinnedResponse = vi.fn(
    async (request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> => {
      const url = new URL(request.url);
      if (url.hostname === "auth.example.test") {
        if (options.stallToken) {
          return await new Promise(() => undefined);
        }
        if (options.tokenRedirect) {
          return response(302, Buffer.alloc(0), closes, {
            location: "https://other.example.test/token",
          });
        }
        return response(
          200,
          Buffer.from(JSON.stringify(options.tokenBody ?? { token: "PRIVATE_TOKEN" })),
          closes,
        );
      }
      if (url.hostname === "storage.example.test") {
        if (options.redirectLoop) {
          return response(307, Buffer.alloc(0), closes, { location: request.url });
        }
        return response(200, bundleBytes, closes);
      }
      if (url.pathname.includes("/manifests/")) {
        registryManifestCalls += 1;
        if (options.manifestRedirect) {
          return response(307, Buffer.alloc(0), closes, {
            location: `https://storage.example.test/manifest/${manifestDigest}`,
          });
        }
        if (registryManifestCalls === 1) {
          return response(401, Buffer.alloc(0), closes, {
            "www-authenticate":
              options.challenge ??
              'Bearer realm="https://auth.example.test/token",service="registry.example.test",scope="repository:flow/review:pull"',
          });
        }
        return response(200, manifest, closes, {
          "docker-content-digest": options.manifestDigestHeader ?? manifestDigest,
          "content-type": options.manifestContentType ?? OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        });
      }
      if (url.pathname.endsWith(digest(bundleBytes))) {
        if (options.redirectBundle) {
          return response(307, Buffer.alloc(0), closes, {
            location: "https://storage.example.test/layer?PRIVATE_SIGNED_QUERY=value",
          });
        }
        const body = options.corruptBundle ? Buffer.from("changed bundle") : bundleBytes;
        if (options.stallBundleBody) {
          const close = vi.fn();
          closes.push(close);
          return {
            statusCode: 200,
            headers: { "content-length": String(bundleBytes.byteLength) },
            body: stalledChunks(body),
            close,
          };
        }
        return response(200, body, closes, {
          "content-length": String(
            bundleBytes.byteLength + (options.bundleContentLengthDelta ?? 0),
          ),
        });
      }
      if (url.pathname.endsWith(digest(sigstore))) {
        return response(
          200,
          options.corruptSigstore ? Buffer.from("changed signature") : sigstore,
          closes,
        );
      }
      throw new Error(`unexpected fixture URL ${request.url}`);
    },
  );
  return {
    reference: canonicalReference,
    manifestDigest,
    closes,
    resolveHostname,
    openPinnedResponse,
    registry: createStrictOciCapabilityRegistry({
      resolveHostname,
      openPinnedResponse,
      timeoutMs: options.timeoutMs,
    }),
  };
}

function response(
  statusCode: number,
  body: Buffer,
  closes: ReturnType<typeof vi.fn>[],
  headers: Readonly<Record<string, string>> = {},
): PinnedHttpsResponse {
  const close = vi.fn();
  closes.push(close);
  return {
    statusCode,
    headers: { "content-length": String(body.byteLength), ...headers },
    body: chunks(body),
    close,
  };
}

async function* chunks(content: Buffer): AsyncIterable<Uint8Array> {
  yield content;
}

async function* stalledChunks(content: Buffer): AsyncIterable<Uint8Array> {
  yield content.subarray(0, 1);
  await new Promise(() => undefined);
}

function manifestBytes(bundleBytes: Buffer, sigstoreBytes: Buffer): Buffer {
  return Buffer.from(
    JSON.stringify({
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
          digest: digest(bundleBytes),
          size: bundleBytes.byteLength,
        },
        {
          mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
          digest: digest(sigstoreBytes),
          size: sigstoreBytes.byteLength,
        },
      ],
    }),
  );
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function expectClosedFailure(promise: Promise<unknown>, stage: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected OCI registry operation to fail");
  } catch (error) {
    expect(error).toEqual(new OciCapabilityRegistryError(stage as never));
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  }
}
