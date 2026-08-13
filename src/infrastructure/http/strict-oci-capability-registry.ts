import { z } from "zod";

import {
  assertOciDescriptorBytes,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  type OciCapabilityArtifactManifest,
  type OciCapabilityArtifactReference,
  type OciContentDescriptor,
  parseOciCapabilityArtifactManifest,
  parseOciCapabilityArtifactReference,
} from "../../domain/capability/oci-capability-artifacts.js";
import { parseStrictJson } from "../../domain/strict-json.js";
import {
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
  type ResolvedNetworkAddress,
  requirePublicNetworkAddress,
} from "./strict-capability-bundle-fetcher.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_BEARER_TOKEN_BYTES = 16 * 1024;
const MAX_CHALLENGE_BYTES = 8 * 1024;
const MAX_REDIRECT_URL_BYTES = 8 * 1024;
const MAX_BLOB_REDIRECTS = 3;

export type OciCapabilityRegistryStage =
  | "validate OCI reference"
  | "resolve OCI registry"
  | "read OCI manifest"
  | "acquire anonymous registry token"
  | "validate OCI manifest"
  | "read capability bundle layer"
  | "read Sigstore bundle layer"
  | "acquire OCI artifact";

export class OciCapabilityRegistryError extends Error {
  override readonly name = "OciCapabilityRegistryError";
  readonly code = "oci_registry_failed" as const;

  constructor(readonly stage: OciCapabilityRegistryStage) {
    super(`OCI capability registry failed during ${stage}`);
  }
}

export interface AcquiredOciCapabilityArtifact {
  readonly reference: OciCapabilityArtifactReference;
  readonly manifest: OciCapabilityArtifactManifest;
  readonly capabilityBundle: Buffer;
  readonly sigstoreBundle: Buffer;
}

export interface StrictOciCapabilityRegistry {
  acquire(reference: string, signal?: AbortSignal): Promise<AcquiredOciCapabilityArtifact>;
}

export interface StrictOciCapabilityRegistryOptions {
  readonly resolveHostname: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly ResolvedNetworkAddress[]>;
  readonly openPinnedResponse: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
  readonly timeoutMs?: number | undefined;
}

interface ResolvedOrigin {
  readonly origin: string;
  readonly hostname: string;
  readonly address: ResolvedNetworkAddress;
}

interface RegistryContext {
  readonly signal: AbortSignal;
  readonly originalRegistryOrigin: string;
  readonly resolvedOrigins: Map<string, ResolvedOrigin>;
  readonly options: StrictOciCapabilityRegistryOptions;
}

interface ReadResponse {
  readonly bytes: Buffer;
  readonly headers: PinnedHttpsResponse["headers"];
}

const tokenResponseSchema = z.union([
  z.object({ token: bearerTokenSchema() }).strict(),
  z.object({ access_token: bearerTokenSchema() }).strict(),
]);

export function createStrictOciCapabilityRegistry(
  options: StrictOciCapabilityRegistryOptions,
): StrictOciCapabilityRegistry {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`OCI acquisition timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`);
  }

  return Object.freeze({
    async acquire(
      referenceSource: string,
      callerSignal?: AbortSignal,
    ): Promise<AcquiredOciCapabilityArtifact> {
      let reference: OciCapabilityArtifactReference;
      try {
        reference = parseOciCapabilityArtifactReference(referenceSource);
      } catch {
        throw new OciCapabilityRegistryError("validate OCI reference");
      }

      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        callerSignal === undefined
          ? deadlineSignal
          : AbortSignal.any([callerSignal, deadlineSignal]);
      const context: RegistryContext = {
        signal,
        originalRegistryOrigin: reference.registryOrigin,
        resolvedOrigins: new Map(),
        options,
      };

      try {
        throwIfAborted(signal);
        await withStage("resolve OCI registry", signal, async () => {
          await resolveOrigin(context, new URL(reference.registryOrigin));
        });

        const manifestUrl = manifestUrlFor(reference);
        let manifestResponse = await withStage("read OCI manifest", signal, async () =>
          readWithoutRedirect(context, manifestUrl, manifestHeaders(), 64 * 1024, undefined),
        );
        let authorization: string | undefined;
        if (manifestResponse.statusCode === 401) {
          manifestResponse.close();
          authorization = await acquireAnonymousToken(
            context,
            manifestResponse.headers["www-authenticate"],
            reference.repository,
          );
          manifestResponse = await withStage("read OCI manifest", signal, async () =>
            readWithoutRedirect(
              context,
              manifestUrl,
              manifestHeaders(authorization),
              64 * 1024,
              undefined,
            ),
          );
        }
        const manifestRead = await withStage("read OCI manifest", signal, async () =>
          requireReadSuccess(manifestResponse, 200),
        );
        const manifest = await withStage("validate OCI manifest", signal, async () => {
          requireHeaderMediaType(
            manifestRead.headers["content-type"],
            OCI_IMAGE_MANIFEST_MEDIA_TYPE,
          );
          requireHeaderDigest(
            manifestRead.headers["docker-content-digest"],
            reference.manifestDigest,
          );
          return parseOciCapabilityArtifactManifest(manifestRead.bytes, reference.manifestDigest);
        });

        const capabilityBundle = await readLayer(
          context,
          reference,
          manifest.bundle,
          authorization,
          "read capability bundle layer",
        );
        const sigstoreBundle = await readLayer(
          context,
          reference,
          manifest.sigstoreBundle,
          authorization,
          "read Sigstore bundle layer",
        );

        throwIfAborted(signal);
        return Object.freeze({
          reference,
          manifest,
          capabilityBundle,
          sigstoreBundle,
        });
      } catch (error) {
        if (error instanceof OciCapabilityRegistryError) {
          throw error;
        }
        throw new OciCapabilityRegistryError("acquire OCI artifact");
      }
    },
  });
}

async function acquireAnonymousToken(
  context: RegistryContext,
  header: string | readonly string[] | undefined,
  repository: string,
): Promise<string> {
  return await withStage("acquire anonymous registry token", context.signal, async () => {
    const challenge = parseBearerChallenge(header, repository);
    const tokenUrl = new URL(challenge.realm);
    tokenUrl.searchParams.set("service", challenge.service);
    tokenUrl.searchParams.set("scope", challenge.scope);
    const response = await readWithoutRedirect(
      context,
      tokenUrl,
      Object.freeze({ accept: "application/json", "user-agent": "flow-harness" }),
      MAX_TOKEN_RESPONSE_BYTES,
      undefined,
    );
    const read = await requireReadSuccess(response, 200);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    const input = parseStrictJson(text, {
      maxDepth: 4,
      maxNodes: 16,
      valueLabel: "OCI registry token response",
    });
    const parsed = tokenResponseSchema.parse(JSON.parse(JSON.stringify(input)));
    return "token" in parsed ? parsed.token : parsed.access_token;
  });
}

async function readLayer(
  context: RegistryContext,
  reference: OciCapabilityArtifactReference,
  descriptor: OciContentDescriptor,
  authorization: string | undefined,
  stage: Extract<
    OciCapabilityRegistryStage,
    "read capability bundle layer" | "read Sigstore bundle layer"
  >,
): Promise<Buffer> {
  return await withStage(stage, context.signal, async () => {
    const url = blobUrlFor(reference, descriptor.digest);
    const response = await readWithBlobRedirects(context, url, authorization, descriptor.size);
    assertOciDescriptorBytes(descriptor, response.bytes, stage);
    return response.bytes;
  });
}

async function readWithBlobRedirects(
  context: RegistryContext,
  initialUrl: URL,
  authorization: string | undefined,
  expectedBytes: number,
): Promise<ReadResponse> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= MAX_BLOB_REDIRECTS; redirects += 1) {
    const headers: Record<string, string> = {
      accept: "application/octet-stream",
      "user-agent": "flow-harness",
    };
    if (current.origin === context.originalRegistryOrigin && authorization !== undefined) {
      headers.authorization = `Bearer ${authorization}`;
    }
    const response = await readWithoutRedirect(
      context,
      current,
      Object.freeze(headers),
      expectedBytes,
      expectedBytes,
    );
    if (!isRedirect(response.statusCode)) {
      return await requireReadSuccess(response, 200);
    }
    response.close();
    if (redirects === MAX_BLOB_REDIRECTS) {
      throw new Error("too many blob redirects");
    }
    current = parseBlobRedirect(response.headers.location, current);
  }
  throw new Error("blob redirect settlement failed");
}

interface DeferredReadResponse {
  readonly statusCode: number;
  readonly headers: PinnedHttpsResponse["headers"];
  readonly close: () => void;
  readonly read: () => Promise<ReadResponse>;
}

async function readWithoutRedirect(
  context: RegistryContext,
  url: URL,
  headers: Readonly<Record<string, string>>,
  maximumBytes: number,
  expectedBytes: number | undefined,
): Promise<DeferredReadResponse> {
  const origin = await resolveOrigin(context, url);
  const response = await openResponse(context, {
    url: url.toString(),
    hostname: origin.hostname,
    address: origin.address,
    headers,
    signal: context.signal,
  });
  let consumed = false;
  let closed = false;
  const close = (): void => {
    if (!closed) {
      closed = true;
      closeResponse(response);
    }
  };
  return Object.freeze({
    statusCode: response.statusCode,
    headers: response.headers,
    close,
    async read(): Promise<ReadResponse> {
      if (consumed) {
        throw new Error("response already consumed");
      }
      consumed = true;
      try {
        const declared = parseContentLength(response.headers["content-length"]);
        if (declared !== undefined && declared > maximumBytes) {
          throw new Error("response exceeds byte limit");
        }
        if (expectedBytes !== undefined && declared !== undefined && declared !== expectedBytes) {
          throw new Error("response length contradicts descriptor");
        }
        const bytes = await awaitWithSignal(
          readBoundedBody(response.body, maximumBytes, context.signal),
          context.signal,
        );
        if (declared !== undefined && bytes.byteLength !== declared) {
          throw new Error("response length mismatch");
        }
        if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
          throw new Error("response bytes contradict descriptor");
        }
        return Object.freeze({ bytes, headers: response.headers });
      } finally {
        close();
      }
    },
  });
}

async function requireReadSuccess(
  response: DeferredReadResponse,
  expectedStatus: number,
): Promise<ReadResponse> {
  if (response.statusCode !== expectedStatus) {
    response.close();
    throw new Error("unexpected response status");
  }
  return await response.read();
}

async function resolveOrigin(context: RegistryContext, url: URL): Promise<ResolvedOrigin> {
  const existing = context.resolvedOrigins.get(url.origin);
  if (existing !== undefined) {
    return existing;
  }
  const addresses = await awaitWithSignal(
    context.options.resolveHostname(url.hostname, context.signal),
    context.signal,
  );
  const resolved = Object.freeze({
    origin: url.origin,
    hostname: url.hostname,
    address: requirePublicNetworkAddress(addresses),
  });
  context.resolvedOrigins.set(url.origin, resolved);
  return resolved;
}

async function openResponse(
  context: RegistryContext,
  request: PinnedHttpsRequest,
): Promise<PinnedHttpsResponse> {
  const pending = context.options.openPinnedResponse(request);
  try {
    const response = await awaitWithSignal(pending, context.signal);
    if (context.signal.aborted) {
      closeResponse(response);
      throw context.signal.reason;
    }
    return response;
  } catch (error) {
    pending.then(closeResponse).catch(() => undefined);
    throw error;
  }
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    throwIfAborted(signal);
    const content = Buffer.from(chunk);
    total += content.byteLength;
    if (total > maximumBytes) {
      throw new Error("response exceeds byte limit");
    }
    if (content.byteLength > 0) {
      chunks.push(content);
    }
  }
  return Buffer.concat(chunks, total);
}

function parseBearerChallenge(
  header: string | readonly string[] | undefined,
  repository: string,
): { readonly realm: string; readonly service: string; readonly scope: string } {
  if (
    typeof header !== "string" ||
    Buffer.byteLength(header, "utf8") === 0 ||
    Buffer.byteLength(header, "utf8") > MAX_CHALLENGE_BYTES ||
    !header.startsWith("Bearer ")
  ) {
    throw new Error("invalid bearer challenge");
  }
  const values = new Map<string, string>();
  for (const source of header.slice("Bearer ".length).split(",")) {
    const match = /^(realm|service|scope)="([^"\\]+)"$/.exec(source.trim());
    if (match === null || values.has(match[1] ?? "")) {
      throw new Error("invalid bearer challenge");
    }
    values.set(match[1] ?? "", match[2] ?? "");
  }
  const realm = values.get("realm");
  const service = values.get("service");
  const scope = values.get("scope");
  if (
    values.size !== 3 ||
    realm === undefined ||
    service === undefined ||
    scope !== `repository:${repository}:pull` ||
    service.length === 0 ||
    Buffer.byteLength(service, "utf8") > 512
  ) {
    throw new Error("invalid bearer challenge");
  }
  const url = new URL(realm);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname !== url.hostname.toLowerCase() ||
    url.toString() !== realm
  ) {
    throw new Error("invalid bearer realm");
  }
  return Object.freeze({ realm, service, scope });
}

function parseBlobRedirect(location: string | readonly string[] | undefined, current: URL): URL {
  if (
    typeof location !== "string" ||
    Buffer.byteLength(location, "utf8") > MAX_REDIRECT_URL_BYTES
  ) {
    throw new Error("invalid blob redirect");
  }
  const target = new URL(location, current);
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    target.port !== "" ||
    target.hostname !== target.hostname.toLowerCase()
  ) {
    throw new Error("invalid blob redirect");
  }
  return target;
}

function manifestUrlFor(reference: OciCapabilityArtifactReference): URL {
  return new URL(
    `/v2/${reference.repository}/manifests/${reference.manifestDigest}`,
    reference.registryOrigin,
  );
}

function blobUrlFor(reference: OciCapabilityArtifactReference, digest: string): URL {
  return new URL(`/v2/${reference.repository}/blobs/${digest}`, reference.registryOrigin);
}

function manifestHeaders(authorization?: string): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
    "user-agent": "flow-harness",
    ...(authorization === undefined ? {} : { authorization: `Bearer ${authorization}` }),
  });
}

function requireHeaderDigest(
  value: string | readonly string[] | undefined,
  expected: string,
): void {
  if (value !== expected) {
    throw new Error("manifest response digest mismatch");
  }
}

function requireHeaderMediaType(
  value: string | readonly string[] | undefined,
  expected: string,
): void {
  if (value !== expected) {
    throw new Error("manifest response media type mismatch");
  }
}

function parseContentLength(value: string | readonly string[] | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("invalid Content-Length");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("invalid Content-Length");
  }
  return parsed;
}

function bearerTokenSchema(): z.ZodString {
  return z
    .string()
    .min(1)
    .max(MAX_BEARER_TOKEN_BYTES)
    .refine((value) =>
      Array.from(value).every((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && point >= 33 && point <= 126;
      }),
    );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function closeResponse(response: PinnedHttpsResponse): void {
  try {
    response.close();
  } catch {
    // Closure failure cannot replace the fixed acquisition result.
  }
}

async function withStage<T>(
  stage: OciCapabilityRegistryStage,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    throwIfAborted(signal);
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new OciCapabilityRegistryError(stage);
  }
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}
