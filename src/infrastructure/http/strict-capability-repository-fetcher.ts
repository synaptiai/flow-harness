import { isIP } from "node:net";

import type { StagedTufReadResult } from "../tuf/staged-tuf-repository.js";
import {
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
  type ResolvedNetworkAddress,
  requirePublicNetworkAddress,
} from "./strict-capability-bundle-fetcher.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_REPOSITORY_URL_BYTES = 4_096;
const MAX_REPOSITORY_RESPONSE_BYTES = 8 * 1024 * 1024;

export type CapabilityRepositoryFetchStage =
  | "validate URL"
  | "resolve hostname"
  | "open response"
  | "validate response"
  | "bound response"
  | "read response";

export class CapabilityRepositoryFetchError extends Error {
  override readonly name = "CapabilityRepositoryFetchError";
  readonly code = "capability_repository_fetch_failed" as const;

  constructor(readonly stage: CapabilityRepositoryFetchStage) {
    super(`Capability repository fetch failed during ${stage}`);
  }
}

export interface StrictCapabilityRepositoryFetcher {
  read(url: string, maximumBytes: number, signal: AbortSignal): Promise<StagedTufReadResult>;
}

export interface StrictCapabilityRepositoryFetcherOptions {
  readonly resolveHostname: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly ResolvedNetworkAddress[]>;
  readonly openPinnedResponse: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
  readonly timeoutMs?: number;
}

export function createStrictCapabilityRepositoryFetcher(
  options: StrictCapabilityRepositoryFetcherOptions,
): StrictCapabilityRepositoryFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`repository fetch timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`);
  }

  return Object.freeze({
    async read(
      source: string,
      maximumBytes: number,
      signal: AbortSignal,
    ): Promise<StagedTufReadResult> {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 1 ||
        maximumBytes > MAX_REPOSITORY_RESPONSE_BYTES
      ) {
        throw new CapabilityRepositoryFetchError("bound response");
      }
      const url = parseRepositoryUrl(source);
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const operationSignal = AbortSignal.any([signal, deadlineSignal]);
      let response: PinnedHttpsResponse | undefined;
      try {
        throwIfAborted(operationSignal);
        const address = await withStage("resolve hostname", operationSignal, signal, async () => {
          const addresses = await resolveAddresses(url.hostname, operationSignal, options);
          return requirePublicNetworkAddress(addresses);
        });
        const responsePromise = Promise.resolve().then(
          async () =>
            await options.openPinnedResponse({
              url: url.toString(),
              hostname: url.hostname,
              address,
              headers: Object.freeze({
                accept: "application/json, application/octet-stream",
                "user-agent": "flow-harness",
              }),
              signal: operationSignal,
            }),
        );
        try {
          response = await withStage(
            "open response",
            operationSignal,
            signal,
            async () => await responsePromise,
          );
        } catch (error) {
          void responsePromise.then(closeResponse, () => undefined);
          throw error;
        }

        if (response.statusCode >= 300 && response.statusCode <= 399) {
          throw new CapabilityRepositoryFetchError("validate response");
        }
        if (response.statusCode !== 200) {
          throwIfAborted(operationSignal);
          return Object.freeze({ statusCode: response.statusCode, bytes: Buffer.alloc(0) });
        }

        const declaredBytes = await withStage(
          "validate response",
          operationSignal,
          signal,
          async () => parseContentLength(response?.headers["content-length"]),
        );
        if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
          throw new CapabilityRepositoryFetchError("bound response");
        }
        const content = await withStage(
          "read response",
          operationSignal,
          signal,
          async () => await readBoundedBody(response?.body, maximumBytes, operationSignal),
        );
        if (declaredBytes !== undefined && declaredBytes !== content.byteLength) {
          throw new CapabilityRepositoryFetchError("validate response");
        }
        throwIfAborted(operationSignal);
        return Object.freeze({ statusCode: 200, bytes: content });
      } catch (error) {
        if (signal.aborted) {
          throw signal.reason;
        }
        if (error instanceof CapabilityRepositoryFetchError) {
          throw error;
        }
        throw new CapabilityRepositoryFetchError("read response");
      } finally {
        if (response !== undefined) {
          closeResponse(response);
        }
      }
    },
  });
}

function parseRepositoryUrl(source: string): URL {
  try {
    if (Buffer.byteLength(source, "utf8") > MAX_REPOSITORY_URL_BYTES) {
      throw new Error("repository URL exceeds its bound");
    }
    const url = new URL(source);
    if (
      source !== url.toString() ||
      source.includes("?") ||
      source.includes("#") ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === "" ||
      url.hostname !== url.hostname.toLowerCase()
    ) {
      throw new Error("invalid repository URL");
    }
    return url;
  } catch {
    throw new CapabilityRepositoryFetchError("validate URL");
  }
}

async function resolveAddresses(
  hostname: string,
  signal: AbortSignal,
  options: StrictCapabilityRepositoryFetcherOptions,
): Promise<readonly ResolvedNetworkAddress[]> {
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(literal);
  if (family === 4 || family === 6) {
    return Object.freeze([{ address: literal, family }]);
  }
  return await options.resolveHostname(hostname, signal);
}

function parseContentLength(value: string | readonly string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("invalid response length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid response length");
  }
  return parsed;
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array> | undefined,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (body === undefined) {
    throw new Error("missing response body");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    throwIfAborted(signal);
    const content = Buffer.from(chunk);
    total += content.byteLength;
    if (total > maximumBytes) {
      throw new CapabilityRepositoryFetchError("bound response");
    }
    if (content.byteLength > 0) {
      chunks.push(content);
    }
  }
  throwIfAborted(signal);
  return Buffer.concat(chunks, total);
}

async function withStage<T>(
  stage: CapabilityRepositoryFetchStage,
  operationSignal: AbortSignal,
  operatorSignal: AbortSignal,
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    throwIfAborted(operationSignal);
    const result = await awaitWithSignal(operation, operationSignal);
    throwIfAborted(operationSignal);
    return result;
  } catch (error) {
    if (operatorSignal.aborted) {
      throw operatorSignal.reason;
    }
    if (error instanceof CapabilityRepositoryFetchError) {
      throw error;
    }
    throw new CapabilityRepositoryFetchError(stage);
  }
}

async function awaitWithSignal<T>(
  operation: () => Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (!settled) {
        settled = true;
        signal.removeEventListener("abort", aborted);
        callback();
      }
    };
    const aborted = (): void => settle(() => reject(signal.reason));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    Promise.resolve()
      .then(operation)
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

function closeResponse(response: PinnedHttpsResponse): void {
  try {
    response.close();
  } catch {
    // Cleanup cannot replace the acquisition result.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}
