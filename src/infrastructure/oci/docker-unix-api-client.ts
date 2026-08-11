import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import { parseStrictJson } from "../../domain/strict-json.js";
import type { PrimeOciAttachedTransport } from "./attached-prime-oci-operator.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_ATTACH_STDERR_BYTES = 65_536;
const DEFAULT_MAX_ATTACH_STDOUT_FRAME_BYTES = 1_048_581;
const MAX_REQUEST_BYTES = 1_048_576;
const containerReferencePattern = /^(?:[a-f0-9]{64}|flow-prime-[a-f0-9]{32}|flow-prime-global-v1)$/;
const imageReferencePattern = /^sha256:[a-f0-9]{64}$/;

export interface DockerUnixApiRequest {
  readonly socketPath: string;
  readonly method: "DELETE" | "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface DockerUnixApiResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface DockerUnixApiTransport {
  request(request: DockerUnixApiRequest): Promise<DockerUnixApiResponse>;
}

export interface DockerUnixAttachRequest {
  readonly socketPath: string;
  readonly path: string;
  readonly maxStderrBytes: number;
  readonly maxStdoutFrameBytes: number;
  readonly signal?: AbortSignal;
}

export interface DockerUnixAttachTransport {
  attach(request: DockerUnixAttachRequest): Promise<PrimeOciAttachedTransport>;
}

export interface DockerUnixApiClientOptions {
  readonly socketPath: string;
  readonly apiVersion: string;
  readonly transport?: DockerUnixApiTransport;
  readonly attachTransport?: DockerUnixAttachTransport;
  readonly maxResponseBytes?: number;
  readonly maxAttachStderrBytes?: number;
  readonly maxAttachStdoutFrameBytes?: number;
}

export class DockerUnixApiClient {
  readonly #apiPrefix: string;
  readonly #attachTransport: DockerUnixAttachTransport;
  readonly #maxAttachStderrBytes: number;
  readonly #maxAttachStdoutFrameBytes: number;
  readonly #maxResponseBytes: number;
  readonly #socketPath: string;
  readonly #transport: DockerUnixApiTransport;

  constructor(options: DockerUnixApiClientOptions) {
    if (options.socketPath !== "/var/run/docker.sock") {
      throw new Error("Docker API client requires the canonical local Unix socket");
    }
    if (!/^\d+\.\d+$/.test(options.apiVersion)) {
      throw new Error("Docker API version is invalid");
    }
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error("Docker API response limit is invalid");
    }
    this.#socketPath = options.socketPath;
    this.#apiPrefix = `/v${options.apiVersion}`;
    this.#transport = options.transport ?? new NodeDockerUnixApiTransport();
    this.#attachTransport = options.attachTransport ?? new NodeDockerUnixAttachTransport();
    this.#maxResponseBytes = maxResponseBytes;
    this.#maxAttachStderrBytes = boundedPositiveInteger(
      options.maxAttachStderrBytes ?? DEFAULT_MAX_ATTACH_STDERR_BYTES,
      "Docker attach standard-error limit",
    );
    this.#maxAttachStdoutFrameBytes = boundedPositiveInteger(
      options.maxAttachStdoutFrameBytes ?? DEFAULT_MAX_ATTACH_STDOUT_FRAME_BYTES,
      "Docker attach standard-output frame limit",
    );
  }

  async createContainer(
    name: string,
    configuration: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    assertContainerReference(name);
    const response = await this.#request(
      "POST",
      `${this.#apiPrefix}/containers/create?name=${encodeURIComponent(name)}`,
      JSON.stringify(configuration),
      signal,
    );
    assertStatus(response, [201], "create");
    const body = parseObject(response.body, "Docker create response");
    if (typeof body.Id !== "string" || !/^[a-f0-9]{64}$/.test(body.Id)) {
      throw new Error("Docker create response has an invalid container ID");
    }
    return body.Id;
  }

  async ping(signal?: AbortSignal): Promise<void> {
    const response = await this.#request("GET", "/_ping", undefined, signal);
    if (response.statusCode !== 200 || response.body !== "OK") {
      throw new Error(`Docker ping returned status ${response.statusCode}`);
    }
  }

  async readVersion(signal?: AbortSignal): Promise<string> {
    const response = await this.#request("GET", `${this.#apiPrefix}/version`, undefined, signal);
    assertStatus(response, [200], "version");
    return response.body;
  }

  async readInfo(signal?: AbortSignal): Promise<string> {
    const response = await this.#request("GET", `${this.#apiPrefix}/info`, undefined, signal);
    assertStatus(response, [200], "information");
    return response.body;
  }

  async inspectImage(
    reference: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    if (!imageReferencePattern.test(reference)) {
      throw new Error("Docker image reference is invalid");
    }
    const response = await this.#request(
      "GET",
      `${this.#apiPrefix}/images/${encodeURIComponent(reference)}/json`,
      undefined,
      signal,
    );
    if (response.statusCode === 404) {
      return null;
    }
    assertStatus(response, [200], "image inspect");
    return parseObject(response.body, "Docker image inspect response");
  }

  async inspectContainer(
    reference: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    assertContainerReference(reference);
    const response = await this.#request(
      "GET",
      `${this.#apiPrefix}/containers/${reference}/json`,
      undefined,
      signal,
    );
    if (response.statusCode === 404) {
      return null;
    }
    assertStatus(response, [200], "inspect");
    return parseObject(response.body, "Docker inspect response");
  }

  async startContainer(reference: string, signal?: AbortSignal): Promise<void> {
    assertContainerReference(reference);
    const response = await this.#request(
      "POST",
      `${this.#apiPrefix}/containers/${reference}/start`,
      undefined,
      signal,
    );
    assertStatus(response, [204, 304], "start");
  }

  async stopContainer(
    reference: string,
    graceSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    assertContainerReference(reference);
    if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 30) {
      throw new Error("Docker stop grace is invalid");
    }
    const response = await this.#request(
      "POST",
      `${this.#apiPrefix}/containers/${reference}/stop?t=${graceSeconds}`,
      undefined,
      signal,
    );
    assertStatus(response, [204, 304, 404], "stop");
  }

  async removeContainer(reference: string, signal?: AbortSignal): Promise<void> {
    assertContainerReference(reference);
    const response = await this.#request(
      "DELETE",
      `${this.#apiPrefix}/containers/${reference}?force=1&v=1`,
      undefined,
      signal,
    );
    assertStatus(response, [204, 404], "remove");
  }

  async attachContainer(
    reference: string,
    signal?: AbortSignal,
  ): Promise<PrimeOciAttachedTransport> {
    assertContainerReference(reference);
    throwIfAborted(signal);
    return this.#attachTransport.attach({
      socketPath: this.#socketPath,
      path: `${this.#apiPrefix}/containers/${reference}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0`,
      maxStderrBytes: this.#maxAttachStderrBytes,
      maxStdoutFrameBytes: this.#maxAttachStdoutFrameBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #request(
    method: DockerUnixApiRequest["method"],
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DockerUnixApiResponse> {
    throwIfAborted(signal);
    if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error(`Docker API request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    const response = await this.#transport.request({
      socketPath: this.#socketPath,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      maxResponseBytes: this.#maxResponseBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    if (Buffer.byteLength(response.body, "utf8") > this.#maxResponseBytes) {
      throw new Error(`Docker API response exceeds ${this.#maxResponseBytes} bytes`);
    }
    return response;
  }
}

export interface DockerRawStreamChunk {
  readonly stream: "stdout" | "stderr";
  readonly payload: Buffer;
}

export class DockerRawStreamDecoder {
  readonly #maxStderrBytes: number;
  readonly #maxStdoutFrameBytes: number;
  #pending = Buffer.alloc(0);
  #stderrBytes = 0;
  #finished = false;

  constructor(options: { readonly maxStderrBytes: number; readonly maxStdoutFrameBytes?: number }) {
    this.#maxStderrBytes = boundedPositiveInteger(
      options.maxStderrBytes,
      "Docker standard-error limit",
    );
    this.#maxStdoutFrameBytes = boundedPositiveInteger(
      options.maxStdoutFrameBytes ?? DEFAULT_MAX_ATTACH_STDOUT_FRAME_BYTES,
      "Docker standard-output frame limit",
    );
  }

  push(bytes: Uint8Array): DockerRawStreamChunk[] {
    if (this.#finished) {
      throw new Error("Docker raw-stream decoder is already finished");
    }
    if (bytes.byteLength > 0) {
      this.#pending = Buffer.concat([this.#pending, Buffer.from(bytes)]);
    }
    const chunks: DockerRawStreamChunk[] = [];
    while (this.#pending.byteLength >= 8) {
      const stream = this.#pending.readUInt8(0);
      if (
        stream !== 1 ||
        this.#pending.readUInt8(1) !== 0 ||
        this.#pending.readUInt8(2) !== 0 ||
        this.#pending.readUInt8(3) !== 0
      ) {
        if (stream !== 2) {
          throw new Error("Docker attach stream has an invalid multiplex header");
        }
        if (
          this.#pending.readUInt8(1) !== 0 ||
          this.#pending.readUInt8(2) !== 0 ||
          this.#pending.readUInt8(3) !== 0
        ) {
          throw new Error("Docker attach stream has an invalid multiplex header");
        }
      }
      const payloadLength = this.#pending.readUInt32BE(4);
      if (stream === 1 && payloadLength > this.#maxStdoutFrameBytes) {
        throw new Error(`Docker standard-output frame exceeds ${this.#maxStdoutFrameBytes} bytes`);
      }
      if (stream === 2 && this.#stderrBytes + payloadLength > this.#maxStderrBytes) {
        throw new Error(`Docker standard error exceeds ${this.#maxStderrBytes} bytes`);
      }
      const frameLength = 8 + payloadLength;
      if (this.#pending.byteLength < frameLength) {
        break;
      }
      const payload = Buffer.from(this.#pending.subarray(8, frameLength));
      this.#pending = this.#pending.subarray(frameLength);
      if (stream === 2) {
        this.#stderrBytes += payloadLength;
      }
      chunks.push({ stream: stream === 1 ? "stdout" : "stderr", payload });
    }
    return chunks;
  }

  finish(): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (this.#pending.byteLength !== 0) {
      throw new Error("Docker attach stream ends with a partial multiplex frame");
    }
  }
}

export class NodeDockerUnixApiTransport implements DockerUnixApiTransport {
  request(input: DockerUnixApiRequest): Promise<DockerUnixApiResponse> {
    throwIfAborted(input.signal);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: input.socketPath,
          method: input.method,
          path: input.path,
          headers:
            input.body === undefined
              ? { Accept: "application/json" }
              : {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(input.body, "utf8"),
                },
          signal: input.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > input.maxResponseBytes) {
              request.destroy(
                new Error(`Docker API response exceeds ${input.maxResponseBytes} bytes`),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.once("error", reject);
      if (input.body !== undefined) {
        request.write(input.body);
      }
      request.end();
    });
  }
}

export class NodeDockerUnixAttachTransport implements DockerUnixAttachTransport {
  attach(input: DockerUnixAttachRequest): Promise<PrimeOciAttachedTransport> {
    throwIfAborted(input.signal);
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: input.socketPath,
        method: "POST",
        path: input.path,
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
        signal: input.signal,
      });
      request.once("upgrade", (_response, socket, head) => {
        resolve(new NodeDockerAttachedTransport(socket, head, input));
      });
      request.once("response", (response) => {
        response.resume();
        reject(new Error(`Docker attach returned status ${response.statusCode ?? 0}`));
      });
      request.once("error", reject);
      request.end();
    });
  }
}

class NodeDockerAttachedTransport implements PrimeOciAttachedTransport {
  readonly output: AsyncIterable<Uint8Array>;

  constructor(
    private readonly socket: Duplex,
    head: Buffer,
    input: Pick<DockerUnixAttachRequest, "maxStderrBytes" | "maxStdoutFrameBytes">,
  ) {
    this.output = stdoutChunks(socket, head, input);
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.from(bytes), (error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async closeInput(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.socket.writableEnded || this.socket.destroyed) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.end((error?: Error | null) => {
        if (error !== undefined && error !== null) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async release(): Promise<void> {
    if (this.socket.destroyed) {
      return;
    }
    this.socket.destroy();
  }
}

async function* stdoutChunks(
  socket: Duplex,
  head: Buffer,
  input: Pick<DockerUnixAttachRequest, "maxStderrBytes" | "maxStdoutFrameBytes">,
): AsyncIterable<Uint8Array> {
  const decoder = new DockerRawStreamDecoder(input);
  if (head.byteLength > 0) {
    for (const chunk of decoder.push(head)) {
      if (chunk.stream === "stdout") {
        yield chunk.payload;
      }
    }
  }
  for await (const bytes of socket) {
    for (const chunk of decoder.push(bytes as Uint8Array)) {
      if (chunk.stream === "stdout") {
        yield chunk.payload;
      }
    }
  }
  decoder.finish();
}

function parseObject(body: string, label: string): Record<string, unknown> {
  const value = parseStrictJson(body, {
    maxDepth: 64,
    maxNodes: 200_000,
    valueLabel: label,
  });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function assertContainerReference(reference: string): void {
  if (!containerReferencePattern.test(reference)) {
    throw new Error("Docker container reference is invalid");
  }
}

function assertStatus(
  response: DockerUnixApiResponse,
  accepted: readonly number[],
  operation: string,
): void {
  if (!accepted.includes(response.statusCode)) {
    throw new Error(`Docker ${operation} returned status ${response.statusCode}`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error(String(reason ?? "Docker request cancelled"));
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
