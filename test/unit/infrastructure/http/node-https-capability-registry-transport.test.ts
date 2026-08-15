import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  FLOW_CAPABILITY_ARTIFACT_TYPE,
  FLOW_CAPABILITY_BUNDLE_LAYER_MEDIA_TYPE,
  OCI_EMPTY_CONFIG_DIGEST,
  OCI_EMPTY_CONFIG_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
} from "../../../../src/domain/capability/oci-capability-artifacts.js";
import {
  createNodeHttpsOciCapabilityRegistry,
  type NodeHttpsDnsResolver,
  type NodeHttpsRequest,
} from "../../../../src/infrastructure/http/node-https-capability-bundle-transport.js";

describe("Node HTTPS OCI capability registry transport", () => {
  it("acquires a credential-free artifact through DNS-pinned Node HTTPS responses", async () => {
    const capabilityBundle = Buffer.from("exact capability bundle bytes");
    const sigstoreBundle = Buffer.from("exact Sigstore bundle bytes");
    const manifest = manifestBytes(capabilityBundle, sigstoreBundle);
    const manifestDigest = digest(manifest);
    const reference = `registry.example.test/flow/review@${manifestDigest}`;
    const resolver: NodeHttpsDnsResolver = {
      resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
      resolve6: vi.fn().mockResolvedValue([]),
      cancel: vi.fn(),
    };
    const request = vi.fn((url, _options, receiveResponse) => {
      const parsed = new URL(url);
      const response = parsed.pathname.includes("/manifests/")
        ? incomingResponse(manifest, {
            "content-type": OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            "docker-content-digest": manifestDigest,
          })
        : parsed.pathname.endsWith(digest(capabilityBundle))
          ? incomingResponse(capabilityBundle)
          : incomingResponse(sigstoreBundle);
      receiveResponse(response);
      const handle = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
      handle.end = vi.fn();
      return handle;
    }) as unknown as NodeHttpsRequest;
    const registry = createNodeHttpsOciCapabilityRegistry({
      createResolver: vi.fn(() => resolver),
      request,
    });

    await expect(registry.acquire(reference)).resolves.toMatchObject({
      reference: { canonical: reference },
      capabilityBundle,
      sigstoreBundle,
    });

    expect(request).toHaveBeenCalledTimes(3);
    for (const [_url, options] of vi.mocked(request).mock.calls) {
      expect(options.headers).not.toHaveProperty("authorization");
      expect(options.lookup).toBeTypeOf("function");
      if (options.lookup === undefined) {
        throw new Error("expected pinned HTTPS lookup");
      }
      await expect(invokeLookup(options.lookup)).resolves.toEqual({
        address: "93.184.216.34",
        family: 4,
      });
    }
  });
});

function incomingResponse(body: Buffer, headers: Readonly<Record<string, string>> = {}) {
  const response = Readable.from([body]) as Readable & {
    statusCode: number;
    headers: Readonly<Record<string, string>>;
  };
  response.statusCode = 200;
  response.headers = { "content-length": String(body.byteLength), ...headers };
  return response;
}

function manifestBytes(bundle: Buffer, sigstore: Buffer): Buffer {
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
          digest: digest(bundle),
          size: bundle.byteLength,
        },
        {
          mediaType: SIGSTORE_BUNDLE_LAYER_MEDIA_TYPE,
          digest: digest(sigstore),
          size: sigstore.byteLength,
        },
      ],
    }),
  );
}

function digest(content: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function invokeLookup(
  lookup: NonNullable<Parameters<NodeHttpsRequest>[1]["lookup"]>,
): Promise<{ readonly address: string; readonly family: number }> {
  return await new Promise((resolve, reject) => {
    lookup("registry.example.test", {}, (error, address, family) => {
      if (error !== null || typeof address !== "string" || family === undefined) {
        reject(error ?? new Error("expected one pinned address"));
        return;
      }
      resolve({ address, family });
    });
  });
}
