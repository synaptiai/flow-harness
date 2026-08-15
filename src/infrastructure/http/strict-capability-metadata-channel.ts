import { isIP } from "node:net";

import {
  type CapabilityMetadataChannel,
  CapabilityMetadataChannelError,
  type CapabilityMetadataChannelStage,
} from "../../application/capability-metadata-channel.js";
import { MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES } from "../../domain/capability/signed-capability-metadata-envelope.js";
import {
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
  type ResolvedNetworkAddress,
  requirePublicNetworkAddress,
} from "./strict-capability-bundle-fetcher.js";

export const SIGNED_CAPABILITY_METADATA_ENVELOPE_MEDIA_TYPE =
  "application/vnd.synapti.flow-capability-metadata-envelope+json" as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_CHANNEL_URL_BYTES = 4_096;

export interface StrictCapabilityMetadataChannelOptions {
  readonly resolveHostname: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly ResolvedNetworkAddress[]>;
  readonly openPinnedResponse: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
  readonly timeoutMs?: number;
}

export function createStrictCapabilityMetadataChannel(
  options: StrictCapabilityMetadataChannelOptions,
): CapabilityMetadataChannel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`metadata channel timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`);
  }

  return Object.freeze({
    async read(source: string, signal?: AbortSignal): Promise<Buffer> {
      const url = parseChannelUrl(source);
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const operationSignal =
        signal === undefined ? deadlineSignal : AbortSignal.any([signal, deadlineSignal]);
      let response: PinnedHttpsResponse | undefined;
      try {
        throwIfAborted(operationSignal);
        const address = await withStage(
          "resolve metadata channel",
          operationSignal,
          signal,
          async () => {
            const addresses = await resolveAddresses(url.hostname, operationSignal, options);
            return requirePublicNetworkAddress(addresses);
          },
        );
        const responsePromise = Promise.resolve().then(
          async () =>
            await options.openPinnedResponse({
              url: url.toString(),
              hostname: url.hostname,
              address,
              headers: Object.freeze({
                accept: SIGNED_CAPABILITY_METADATA_ENVELOPE_MEDIA_TYPE,
                "user-agent": "flow-harness",
              }),
              signal: operationSignal,
            }),
        );
        let openedResponse: PinnedHttpsResponse;
        try {
          openedResponse = await withStage(
            "open metadata channel",
            operationSignal,
            signal,
            async () => await responsePromise,
          );
        } catch (error) {
          void responsePromise.then(closeResponse, () => undefined);
          throw error;
        }
        response = openedResponse;

        const declaredBytes = await withStage(
          "validate metadata channel response",
          operationSignal,
          signal,
          async () => {
            requireExactResponse(openedResponse);
            return parseContentLength(openedResponse.headers["content-length"]);
          },
        );
        if (
          declaredBytes !== undefined &&
          declaredBytes > MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES
        ) {
          throw new CapabilityMetadataChannelError("bound metadata channel response");
        }

        const content = await withStage(
          "read metadata channel response",
          operationSignal,
          signal,
          async () => await readBoundedBody(openedResponse.body, operationSignal),
        );
        if (declaredBytes !== undefined && declaredBytes !== content.byteLength) {
          throw new CapabilityMetadataChannelError("validate metadata channel response");
        }
        throwIfAborted(operationSignal);
        return content;
      } catch (error) {
        if (signal?.aborted === true) {
          throw signal.reason;
        }
        if (error instanceof CapabilityMetadataChannelError) {
          throw error;
        }
        throw new CapabilityMetadataChannelError("read metadata channel response");
      } finally {
        if (response !== undefined) {
          closeResponse(response);
        }
      }
    },
  });
}

function closeResponse(response: PinnedHttpsResponse): void {
  try {
    response.close();
  } catch {
    // Diagnostic cleanup must not replace the acquisition result.
  }
}

function parseChannelUrl(source: string): URL {
  try {
    if (Buffer.byteLength(source, "utf8") > MAX_CHANNEL_URL_BYTES) {
      throw new Error("channel URL exceeds its bound");
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
      throw new Error("invalid metadata channel URL");
    }
    return url;
  } catch {
    throw new CapabilityMetadataChannelError("validate metadata channel URL");
  }
}

async function resolveAddresses(
  hostname: string,
  signal: AbortSignal,
  options: StrictCapabilityMetadataChannelOptions,
): Promise<readonly ResolvedNetworkAddress[]> {
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(literal);
  if (family === 4 || family === 6) {
    return Object.freeze([{ address: literal, family }]);
  }
  return await options.resolveHostname(hostname, signal);
}

function requireExactResponse(response: PinnedHttpsResponse): void {
  if (
    response.statusCode !== 200 ||
    response.headers["content-type"] !== SIGNED_CAPABILITY_METADATA_ENVELOPE_MEDIA_TYPE
  ) {
    throw new Error("metadata channel response contract mismatch");
  }
}

function parseContentLength(value: string | readonly string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("invalid metadata channel content length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid metadata channel content length");
  }
  return parsed;
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    throwIfAborted(signal);
    const content = Buffer.from(chunk);
    total += content.byteLength;
    if (total > MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES) {
      throw new CapabilityMetadataChannelError("bound metadata channel response");
    }
    if (content.byteLength > 0) {
      chunks.push(content);
    }
  }
  throwIfAborted(signal);
  return Buffer.concat(chunks, total);
}

async function withStage<T>(
  stage: CapabilityMetadataChannelStage,
  operationSignal: AbortSignal,
  operatorSignal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    throwIfAborted(operationSignal);
    const result = await awaitWithSignal(operation, operationSignal);
    throwIfAborted(operationSignal);
    return result;
  } catch (error) {
    if (operatorSignal?.aborted === true) {
      throw operatorSignal.reason;
    }
    if (error instanceof CapabilityMetadataChannelError) {
      throw error;
    }
    throw new CapabilityMetadataChannelError(stage);
  }
}

async function awaitWithSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}
