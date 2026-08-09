import { Resolver as NodeResolver } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as nodeRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { LookupFunction } from "node:net";

import {
  type CapabilityBundleFetcher,
  createStrictCapabilityBundleFetcher,
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
  type ResolvedNetworkAddress,
} from "./strict-capability-bundle-fetcher.js";

export interface NodeHttpsDnsResolver {
  readonly resolve4: (hostname: string) => Promise<readonly string[]>;
  readonly resolve6: (hostname: string) => Promise<readonly string[]>;
  readonly cancel: () => void;
}

export type NodeHttpsRequest = (
  url: URL,
  options: HttpsRequestOptions,
  receiveResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface NodeHttpsCapabilityBundleTransport {
  readonly resolveHostname: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly ResolvedNetworkAddress[]>;
  readonly openPinnedResponse: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
}

export interface NodeHttpsCapabilityBundleDependencies {
  readonly createResolver: () => NodeHttpsDnsResolver;
  readonly request: NodeHttpsRequest;
}

export function createNodeHttpsCapabilityBundleTransport(
  dependencies: NodeHttpsCapabilityBundleDependencies,
): NodeHttpsCapabilityBundleTransport {
  return Object.freeze({
    async resolveHostname(
      hostname: string,
      signal: AbortSignal,
    ): Promise<readonly ResolvedNetworkAddress[]> {
      if (signal.aborted) {
        throw signal.reason;
      }
      const resolver = dependencies.createResolver();
      const aborted = (): void => resolver.cancel();
      signal.addEventListener("abort", aborted, { once: true });
      try {
        const [ipv4, ipv6] = await Promise.allSettled([
          resolver.resolve4(hostname),
          resolver.resolve6(hostname),
        ]);
        if (signal.aborted) {
          throw signal.reason;
        }
        const addresses: ResolvedNetworkAddress[] = [];
        collectResolvedAddresses(addresses, ipv4, 4);
        collectResolvedAddresses(addresses, ipv6, 6);
        return Object.freeze(addresses);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    },

    async openPinnedResponse(request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all === true) {
          callback(null, [request.address]);
          return;
        }
        callback(null, request.address.address, request.address.family);
      };
      return await new Promise<PinnedHttpsResponse>((resolve, reject) => {
        const handle = dependencies.request(
          new URL(request.url),
          {
            method: "GET",
            agent: false,
            headers: request.headers,
            signal: request.signal,
            lookup: pinnedLookup,
          },
          (response) => {
            resolve(
              Object.freeze({
                statusCode: response.statusCode ?? 0,
                headers: Object.freeze({ ...response.headers }),
                body: response,
                close: () => response.destroy(),
              }),
            );
          },
        );
        handle.once("error", reject);
        handle.end();
      });
    },
  });
}

export function createProductionCapabilityBundleFetcher(): CapabilityBundleFetcher {
  const transport = createNodeHttpsCapabilityBundleTransport({
    createResolver: () => new NodeResolver(),
    request: nodeRequest,
  });
  return createStrictCapabilityBundleFetcher(transport);
}

function collectResolvedAddresses(
  target: ResolvedNetworkAddress[],
  result: PromiseSettledResult<readonly string[]>,
  family: 4 | 6,
): void {
  if (result.status === "fulfilled") {
    for (const address of result.value) {
      target.push(Object.freeze({ address, family }));
    }
    return;
  }
  if (!isMissingDnsRecord(result.reason)) {
    throw result.reason;
  }
}

function isMissingDnsRecord(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENODATA" || error.code === "ENOTFOUND")
  );
}
