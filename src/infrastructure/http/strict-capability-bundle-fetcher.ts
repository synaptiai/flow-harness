import { isIP } from "node:net";

import { MAX_CAPABILITY_BUNDLE_BYTES } from "../../domain/capability/capability-bundles.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_SOURCE_URL_BYTES = 4_096;
const MAX_ERROR_BYTES = 16_384;

export interface ResolvedNetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PinnedHttpsRequest {
  readonly url: string;
  readonly hostname: string;
  readonly address: ResolvedNetworkAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export interface PinnedHttpsResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly close: () => void;
}

export type CapabilityBundleFetchErrorCode =
  | "invalid_url"
  | "non_public_address"
  | "redirect_denied"
  | "response_failed"
  | "response_too_large"
  | "timeout"
  | "aborted"
  | "transport_failed";

export class CapabilityBundleFetchError extends Error {
  override readonly name = "CapabilityBundleFetchError";

  constructor(
    readonly code: CapabilityBundleFetchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface CapabilityBundleFetcher {
  fetch(source: string, signal?: AbortSignal): Promise<Buffer>;
}

export interface StrictCapabilityBundleFetcherOptions {
  readonly resolveHostname: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly ResolvedNetworkAddress[]>;
  readonly openPinnedResponse: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
  readonly maximumBytes?: number;
  readonly timeoutMs?: number;
}

export function createStrictCapabilityBundleFetcher(
  options: StrictCapabilityBundleFetcherOptions,
): CapabilityBundleFetcher {
  const maximumBytes = options.maximumBytes ?? MAX_CAPABILITY_BUNDLE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("capability bundle response limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `capability bundle fetch timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`,
    );
  }

  return {
    async fetch(source: string, signal?: AbortSignal): Promise<Buffer> {
      const url = parseCapabilityBundleSourceUrl(source);
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const operationSignal =
        signal === undefined ? deadlineSignal : AbortSignal.any([signal, deadlineSignal]);
      let response: PinnedHttpsResponse | undefined;
      try {
        throwIfAborted(operationSignal);
        const addresses = await resolveSourceAddresses(
          url.hostname,
          operationSignal,
          options.resolveHostname,
        );
        const address = requirePublicNetworkAddress(addresses);
        response = await awaitFactoryWithSignal(
          () =>
            options.openPinnedResponse({
              url: url.toString(),
              hostname: url.hostname,
              address,
              headers: Object.freeze({
                accept: "application/vnd.synapti.flow-capability-bundle+json",
                "user-agent": "flow-harness",
              }),
              signal: operationSignal,
            }),
          operationSignal,
        );
        requireSuccessfulStatus(response.statusCode);
        const declaredBytes = parseContentLength(response.headers["content-length"]);
        if (declaredBytes !== undefined && declaredBytes > maximumBytes) {
          throw new CapabilityBundleFetchError(
            "response_too_large",
            `capability bundle response exceeds ${maximumBytes} bytes`,
          );
        }
        const content = await awaitWithSignal(
          readBoundedBody(response.body, maximumBytes, operationSignal),
          operationSignal,
        );
        if (declaredBytes !== undefined && declaredBytes !== content.byteLength) {
          throw new CapabilityBundleFetchError(
            "response_failed",
            `capability bundle response length mismatch: declared ${declaredBytes}, received ${content.byteLength}`,
          );
        }
        return content;
      } catch (error) {
        if (error instanceof CapabilityBundleFetchError) {
          throw error;
        }
        if (operationSignal.aborted) {
          throw new CapabilityBundleFetchError(
            signal?.aborted === true ? "aborted" : "timeout",
            signal?.aborted === true
              ? "capability bundle acquisition was aborted"
              : `capability bundle acquisition exceeded ${timeoutMs}ms`,
            { cause: error },
          );
        }
        throw new CapabilityBundleFetchError(
          "transport_failed",
          boundedMessage(
            `capability bundle transport failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
          { cause: error },
        );
      } finally {
        try {
          response?.close();
        } catch {
          // Cleanup cannot replace the bounded acquisition result.
        }
      }
    },
  };
}

function parseCapabilityBundleSourceUrl(source: string): URL {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_URL_BYTES) {
    throw new CapabilityBundleFetchError("invalid_url", "capability bundle source URL is too long");
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch (error) {
    throw new CapabilityBundleFetchError(
      "invalid_url",
      "capability bundle source must be an absolute HTTPS URL",
      { cause: error },
    );
  }
  if (
    source !== url.toString() ||
    source.includes("?") ||
    source.includes("#") ||
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.hostname.length === 0
  ) {
    throw new CapabilityBundleFetchError(
      "invalid_url",
      "capability bundle source must be HTTPS without credentials, query, or fragment",
    );
  }
  return url;
}

async function resolveSourceAddresses(
  hostname: string,
  signal: AbortSignal,
  resolveHostname: StrictCapabilityBundleFetcherOptions["resolveHostname"],
): Promise<readonly ResolvedNetworkAddress[]> {
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(literal);
  if (family === 4 || family === 6) {
    return Object.freeze([{ address: literal, family }]);
  }
  return await awaitFactoryWithSignal(() => resolveHostname(hostname, signal), signal);
}

export function requirePublicNetworkAddress(
  addresses: readonly ResolvedNetworkAddress[],
): ResolvedNetworkAddress {
  if (addresses.length === 0) {
    throw new CapabilityBundleFetchError(
      "transport_failed",
      "capability bundle hostname resolved to no addresses",
    );
  }
  for (const address of addresses) {
    if (!isPublicNetworkAddress(address)) {
      throw new CapabilityBundleFetchError(
        "non_public_address",
        `capability bundle hostname resolved to a non-public address (${address.address})`,
      );
    }
  }
  const selected = addresses[0];
  if (selected === undefined) {
    throw new CapabilityBundleFetchError(
      "transport_failed",
      "capability bundle hostname resolved to no addresses",
    );
  }
  return Object.freeze({ ...selected });
}

function isPublicNetworkAddress(input: ResolvedNetworkAddress): boolean {
  if (input.family === 4) {
    const octets = parseIpv4(input.address);
    if (octets === undefined) {
      return false;
    }
    const [first = 0, second = 0, third = 0] = octets;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  const hextets = parseIpv6(input.address);
  if (hextets === undefined) {
    return false;
  }
  const first = hextets[0] ?? 0;
  const second = hextets[1] ?? 0;
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && second < 0x0200) &&
    !(first === 0x2001 && second === 0x0db8) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second <= 0x0fff)
  );
}

function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => (/^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

function parseIpv6(value: string): readonly number[] | undefined {
  if (isIP(value) !== 6 || value.includes(".")) {
    return undefined;
  }
  const halves = value.toLowerCase().split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left = halves[0]?.length === 0 ? [] : (halves[0]?.split(":") ?? []);
  const right = halves.length === 1 || halves[1]?.length === 0 ? [] : (halves[1]?.split(":") ?? []);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  const parsed = parts.map((part) =>
    /^[a-f0-9]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1,
  );
  return parsed.length === 8 && parsed.every((part) => part >= 0 && part <= 0xffff)
    ? parsed
    : undefined;
}

function requireSuccessfulStatus(statusCode: number): void {
  if (statusCode >= 300 && statusCode <= 399) {
    throw new CapabilityBundleFetchError(
      "redirect_denied",
      `capability bundle source returned denied redirect status ${statusCode}`,
    );
  }
  if (statusCode < 200 || statusCode > 299) {
    throw new CapabilityBundleFetchError(
      "response_failed",
      `capability bundle source returned HTTP status ${statusCode}`,
    );
  }
}

function parseContentLength(value: string | readonly string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CapabilityBundleFetchError(
      "response_failed",
      "capability bundle source returned an invalid Content-Length header",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CapabilityBundleFetchError(
      "response_failed",
      "capability bundle source returned an invalid Content-Length header",
    );
  }
  return parsed;
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal.aborted) {
      throw signal.reason;
    }
    const content = Buffer.from(chunk);
    total += content.byteLength;
    if (total > maximumBytes) {
      throw new CapabilityBundleFetchError(
        "response_too_large",
        `capability bundle response exceeds ${maximumBytes} bytes`,
      );
    }
    chunks.push(content);
  }
  return Buffer.concat(chunks, total);
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function awaitFactoryWithSignal<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return await awaitWithSignal(operation(), signal);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  return bytes.byteLength <= MAX_ERROR_BYTES
    ? message
    : `${bytes.subarray(0, MAX_ERROR_BYTES - 24).toString("utf8")}… [truncated]`;
}
