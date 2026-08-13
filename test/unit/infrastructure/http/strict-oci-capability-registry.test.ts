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
  type OciRegistryCredentialProvider,
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

  it("authenticates once to the exact token realm and clears owned secret material", async () => {
    const fixture = registryFixture({ requireCredentials: true });
    const password = Buffer.from("PRIVATE_PASSWORD");
    const credentialProvider: OciRegistryCredentialProvider = vi.fn(async (challenge, signal) => {
      expect(signal.aborted).toBe(false);
      expect(challenge).toEqual({
        realm: "https://auth.example.test/token",
        service: "registry.example.test",
        scope: "repository:flow/review:pull",
      });
      return { username: "PRIVATE_USER", password };
    });

    await expect(
      fixture.registry.acquire(fixture.reference, undefined, credentialProvider),
    ).resolves.toMatchObject({ capabilityBundle: bundle, sigstoreBundle: sigstore });

    expect(credentialProvider).toHaveBeenCalledOnce();
    expect(fixture.observedSensitiveAuthorizations).toEqual([
      {
        url: "https://auth.example.test/token?service=registry.example.test&scope=repository%3Aflow%2Freview%3Apull",
        authorization: `Basic ${Buffer.from("PRIVATE_USER:PRIVATE_PASSWORD").toString("base64")}`,
      },
    ]);
    expect(password.every((value) => value === 0)).toBe(true);
    expect(
      fixture.openPinnedResponse.mock.calls.every(
        ([request]) =>
          request.sensitiveAuthorization === undefined ||
          request.sensitiveAuthorization.every((value) => value === 0),
      ),
    ).toBe(true);
    expect(
      fixture.openPinnedResponse.mock.calls
        .filter(([request]) => new URL(request.url).hostname !== "auth.example.test")
        .every(([request]) => request.sensitiveAuthorization === undefined),
    ).toBe(true);
  });

  it("captures each provider-controlled credential property exactly once", async () => {
    const fixture = registryFixture({ requireCredentials: true });
    const password = Buffer.from("PRIVATE_PASSWORD");
    const otherPassword = Buffer.from("PRIVATE_OTHER_PASSWORD");
    let usernameReads = 0;
    let passwordReads = 0;

    await expect(
      fixture.registry.acquire(fixture.reference, undefined, async () => ({
        get username() {
          usernameReads += 1;
          return usernameReads === 1 ? "PRIVATE_USER" : "PRIVATE:SWAPPED";
        },
        get password() {
          passwordReads += 1;
          return passwordReads === 1 ? password : otherPassword;
        },
      })),
    ).resolves.toMatchObject({ capabilityBundle: bundle });

    expect(usernameReads).toBe(1);
    expect(passwordReads).toBe(1);
    expect(password.every((value) => value === 0)).toBe(true);
    expect(otherPassword.toString("utf8")).toBe("PRIVATE_OTHER_PASSWORD");
    otherPassword.fill(0);
  });

  it.each([
    "",
    "user name",
    "user:name",
    "user\nname",
    "user\rname",
    "user\0name",
    "é",
    "a".repeat(257),
  ])("rejects invalid private registry username %j before authenticated I/O", async (username) => {
    const fixture = registryFixture({ requireCredentials: true });
    const password = Buffer.from("PRIVATE_PASSWORD");

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, async () => ({
        username,
        password,
      })),
      "acquire private registry token",
    );

    expect(password.every((value) => value === 0)).toBe(true);
    expect(fixture.observedSensitiveAuthorizations).toEqual([]);
  });

  it("normalizes a private credential-provider failure before token I/O", async () => {
    const fixture = registryFixture({ requireCredentials: true });

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, async () => {
        throw new Error("PRIVATE_CREDENTIAL_FAILURE");
      }),
      "acquire private registry token",
    );

    expect(fixture.observedSensitiveAuthorizations).toEqual([]);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["one byte over", Buffer.alloc(16_385, 0x61)],
    ["NUL", Buffer.from("PRIVATE\0PASSWORD")],
    ["LF", Buffer.from("PRIVATE\nPASSWORD")],
    ["CR", Buffer.from("PRIVATE\rPASSWORD")],
    ["fatal UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects an invalid private registry password buffer: %s", async (_label, password) => {
    const fixture = registryFixture({ requireCredentials: true });

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, async () => ({
        username: "PRIVATE_USER",
        password,
      })),
      "acquire private registry token",
    );

    expect(password.every((value) => value === 0)).toBe(true);
    expect(fixture.observedSensitiveAuthorizations).toEqual([]);
  });

  it("validates the exact challenge before invoking a private credential provider", async () => {
    const fixture = registryFixture({
      challenge:
        'Bearer realm="https://auth.example.test/token",service="registry.example.test",scope="repository:flow/review:push"',
    });
    const credentialProvider: OciRegistryCredentialProvider = vi.fn();

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, credentialProvider),
      "acquire private registry token",
    );

    expect(credentialProvider).not.toHaveBeenCalled();
    expect(fixture.observedSensitiveAuthorizations).toEqual([]);
  });

  it("validates the token realm public address before invoking a private credential provider", async () => {
    const fixture = registryFixture();
    fixture.resolveHostname.mockImplementation(async (hostname) => [
      {
        address: hostname === "auth.example.test" ? "127.0.0.1" : "93.184.216.34",
        family: 4 as const,
      },
    ]);
    const credentialProvider: OciRegistryCredentialProvider = vi.fn();

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, credentialProvider),
      "acquire private registry token",
    );

    expect(credentialProvider).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).toHaveBeenCalledOnce();
  });

  it("uses the total acquisition deadline while a credential provider is stalled", async () => {
    const fixture = registryFixture({ timeoutMs: 10 });
    const credentialProvider: OciRegistryCredentialProvider = vi.fn(
      async (): Promise<never> => await new Promise<never>(() => undefined),
    );

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, credentialProvider),
      "acquire OCI artifact",
    );

    expect(credentialProvider).toHaveBeenCalledOnce();
    expect(fixture.openPinnedResponse).toHaveBeenCalledOnce();
    expect(fixture.closes[0]).toHaveBeenCalledOnce();
  });

  it("clears credentials that settle after acquisition cancellation", async () => {
    const fixture = registryFixture({ requireCredentials: true });
    const controller = new AbortController();
    const password = Buffer.from("PRIVATE_LATE_PASSWORD");
    let resolveCredentials: (credentials: {
      readonly username: string;
      readonly password: Buffer;
    }) => void = () => undefined;
    const credentialProvider: OciRegistryCredentialProvider = vi.fn(
      async () =>
        await new Promise<{ readonly username: string; readonly password: Buffer }>((resolve) => {
          resolveCredentials = resolve;
        }),
    );
    const pending = fixture.registry.acquire(
      fixture.reference,
      controller.signal,
      credentialProvider,
    );
    await vi.waitFor(() => expect(credentialProvider).toHaveBeenCalledOnce());

    controller.abort(new Error("operator cancelled private registry acquisition"));
    await expectClosedFailure(pending, "acquire OCI artifact");
    resolveCredentials({ username: "PRIVATE_USER", password });

    await vi.waitFor(() => expect(password.every((value) => value === 0)).toBe(true));
    expect(fixture.openPinnedResponse).toHaveBeenCalledOnce();
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
    ["refresh token", { token: "PRIVATE_TOKEN", refresh_token: "PRIVATE_REFRESH" }],
    ["empty token", { token: "" }],
    ["non-string token", { token: 7 }],
  ])("rejects a non-canonical anonymous token response: %s", async (_label, tokenBody) => {
    const fixture = registryFixture({ tokenBody });

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference),
      "acquire anonymous registry token",
    );
  });

  it.each(["token", "access_token"] as const)(
    "accepts the exact Bearer bound through %s",
    async (field) => {
      const token = "T".repeat(16_384);
      const fixture = registryFixture({ tokenBody: { [field]: token } });

      await expect(fixture.registry.acquire(fixture.reference)).resolves.toMatchObject({
        capabilityBundle: bundle,
      });
      expect(
        fixture.openPinnedResponse.mock.calls
          .map(([request]) => request.headers.authorization)
          .filter((authorization) => authorization !== undefined),
      ).toEqual([`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
    },
  );

  it.each(["token", "access_token"] as const)(
    "rejects byte 16,385 through %s before the authorized manifest read",
    async (field) => {
      const fixture = registryFixture({ tokenBody: { [field]: "T".repeat(16_385) } });

      await expectClosedFailure(
        fixture.registry.acquire(fixture.reference),
        "acquire anonymous registry token",
      );
      expect(fixture.openPinnedResponse).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [
      "token-service authentication refusal",
      { tokenStatus: 403 },
      "acquire private registry token",
    ],
    ["insufficient manifest scope", { authorizedManifestStatus: 403 }, "read OCI manifest"],
  ] as const)("rejects %s without reading artifact layers", async (_label, options, stage) => {
    const fixture = registryFixture({ ...options, requireCredentials: true });
    const password = Buffer.from("PRIVATE_PASSWORD");

    await expectClosedFailure(
      fixture.registry.acquire(fixture.reference, undefined, async () => ({
        username: "PRIVATE_USER",
        password,
      })),
      stage,
    );

    expect(password.every((value) => value === 0)).toBe(true);
    expect(
      fixture.openPinnedResponse.mock.calls.some(([request]) =>
        new URL(request.url).pathname.includes("/blobs/"),
      ),
    ).toBe(false);
    expect(fixture.closes.every((close) => close.mock.calls.length === 1)).toBe(true);
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
  readonly tokenStatus?: number;
  readonly authorizedManifestStatus?: number;
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
  readonly requireCredentials?: boolean;
}

function registryFixture(options: RegistryFixtureOptions = {}) {
  const bundleBytes = options.bundle ?? bundle;
  const manifest = manifestBytes(bundleBytes, sigstore);
  const manifestDigest = digest(manifest);
  const canonicalReference = `registry.example.test/flow/review@${manifestDigest}`;
  const closes: ReturnType<typeof vi.fn>[] = [];
  const observedSensitiveAuthorizations: {
    readonly url: string;
    readonly authorization: string;
  }[] = [];
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
        const sensitiveAuthorization = request.sensitiveAuthorization?.toString("ascii");
        if (sensitiveAuthorization !== undefined) {
          observedSensitiveAuthorizations.push({
            url: request.url,
            authorization: sensitiveAuthorization,
          });
        }
        if (
          options.requireCredentials === true &&
          sensitiveAuthorization !==
            `Basic ${Buffer.from("PRIVATE_USER:PRIVATE_PASSWORD").toString("base64")}`
        ) {
          return response(401, Buffer.alloc(0), closes);
        }
        if (options.stallToken) {
          return await new Promise(() => undefined);
        }
        if (options.tokenRedirect) {
          return response(302, Buffer.alloc(0), closes, {
            location: "https://other.example.test/token",
          });
        }
        return response(
          options.tokenStatus ?? 200,
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
        return response(options.authorizedManifestStatus ?? 200, manifest, closes, {
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
    observedSensitiveAuthorizations,
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
