import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

import { parseStrictJson } from "../../domain/strict-json.js";
import type { PrimeOciAttachedTransport } from "./attached-prime-oci-operator.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_ATTACH_STDERR_BYTES = 65_536;
const DEFAULT_MAX_ATTACH_STDOUT_FRAME_BYTES = 1_048_581;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 1_048_576;
const containerReferencePattern =
  /^(?:[a-f0-9]{64}|flow-prime-[a-f0-9]{32}|flow-prime-global-v1|flow-command-[a-f0-9]{32})$/;
const imageReferencePattern = /^sha256:[a-f0-9]{64}$/;

export interface DockerUnixApiRequest {
  readonly socketPath: string;
  readonly method: "DELETE" | "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs?: null;
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

export interface DockerCommandAttachRequest {
  readonly socketPath: string;
  readonly path: string;
  readonly maxFrameBytes: number;
  readonly signal?: AbortSignal;
}

export interface DockerCommandAttachedTransport {
  readonly output: AsyncIterable<DockerRawStreamChunk>;
  release(): Promise<void>;
}

export interface DockerUnixCommandAttachTransport {
  attach(request: DockerCommandAttachRequest): Promise<DockerCommandAttachedTransport>;
}

export interface NodeDockerUnixTransportOptions {
  readonly requestTimeoutMs?: number;
}

export interface DockerUnixApiClientOptions {
  readonly socketPath: string;
  readonly apiVersion: string;
  readonly transport?: DockerUnixApiTransport;
  readonly attachTransport?: DockerUnixAttachTransport;
  readonly commandAttachTransport?: DockerUnixCommandAttachTransport;
  readonly maxResponseBytes?: number;
  readonly maxAttachStderrBytes?: number;
  readonly maxAttachStdoutFrameBytes?: number;
}

export class DockerUnixApiClient {
  readonly #apiPrefix: string;
  readonly #attachTransport: DockerUnixAttachTransport;
  readonly #commandAttachTransport: DockerUnixCommandAttachTransport;
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
    this.#commandAttachTransport =
      options.commandAttachTransport ?? new NodeDockerUnixCommandAttachTransport();
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
    if (![204, 304].includes(response.statusCode)) {
      throw new Error(dockerStartFailureMessage(response));
    }
  }

  async waitContainer(reference: string, signal?: AbortSignal): Promise<number> {
    assertContainerReference(reference);
    const response = await this.#request(
      "POST",
      `${this.#apiPrefix}/containers/${reference}/wait?condition=not-running`,
      undefined,
      signal,
      signal === undefined ? undefined : null,
    );
    assertStatus(response, [200], "wait");
    let body: Record<string, unknown>;
    try {
      body = parseObject(response.body, "Docker wait response");
    } catch (error) {
      throw new Error("Docker wait response is invalid", { cause: error });
    }
    if (
      !Number.isSafeInteger(body.StatusCode) ||
      (body.StatusCode as number) < 0 ||
      (body.StatusCode as number) > 255
    ) {
      throw new Error("Docker wait response has an invalid status code");
    }
    if (body.Error !== undefined && body.Error !== null) {
      const error = asDockerObject(body.Error, "Docker wait error");
      if (typeof error.Message !== "string") {
        throw new Error("Docker wait response has an invalid error");
      }
      if (error.Message.length > 0) {
        throw new Error("Docker wait reported a container error");
      }
    }
    return body.StatusCode as number;
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

  async attachCommandContainer(
    reference: string,
    signal?: AbortSignal,
  ): Promise<DockerCommandAttachedTransport> {
    assertContainerReference(reference);
    throwIfAborted(signal);
    return this.#commandAttachTransport.attach({
      socketPath: this.#socketPath,
      path: `${this.#apiPrefix}/containers/${reference}/attach?stream=1&stdin=0&stdout=1&stderr=1&logs=0`,
      maxFrameBytes: this.#maxAttachStdoutFrameBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #request(
    method: DockerUnixApiRequest["method"],
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    requestTimeoutMs?: null,
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
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
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
      if (payloadLength === 0) {
        continue;
      }
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

class DockerCommandRawStreamDecoder {
  readonly #maxFrameBytes: number;
  #finished = false;
  #pending = Buffer.alloc(0);

  constructor(maxFrameBytes: number) {
    this.#maxFrameBytes = boundedPositiveInteger(
      maxFrameBytes,
      "Docker command output frame limit",
    );
  }

  push(bytes: Uint8Array): DockerRawStreamChunk[] {
    if (this.#finished) {
      throw new Error("Docker command output decoder is already finished");
    }
    if (bytes.byteLength > 0) {
      this.#pending = Buffer.concat([this.#pending, Buffer.from(bytes)]);
    }
    const chunks: DockerRawStreamChunk[] = [];
    while (this.#pending.byteLength >= 8) {
      const stream = this.#pending.readUInt8(0);
      if (
        (stream !== 1 && stream !== 2) ||
        this.#pending.readUInt8(1) !== 0 ||
        this.#pending.readUInt8(2) !== 0 ||
        this.#pending.readUInt8(3) !== 0
      ) {
        throw new Error("Docker command output has an invalid multiplex header");
      }
      const payloadLength = this.#pending.readUInt32BE(4);
      if (payloadLength > this.#maxFrameBytes) {
        throw new Error(`Docker command output frame exceeds ${this.#maxFrameBytes} bytes`);
      }
      const frameLength = 8 + payloadLength;
      if (this.#pending.byteLength < frameLength) {
        break;
      }
      const payload = Buffer.from(this.#pending.subarray(8, frameLength));
      this.#pending = this.#pending.subarray(frameLength);
      if (payloadLength > 0) {
        chunks.push({ stream: stream === 1 ? "stdout" : "stderr", payload });
      }
    }
    return chunks;
  }

  finish(): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (this.#pending.byteLength !== 0) {
      throw new Error("Docker command output ends with a partial multiplex frame");
    }
  }
}

export class NodeDockerUnixApiTransport implements DockerUnixApiTransport {
  readonly #requestTimeoutMs: number;

  constructor(options: NodeDockerUnixTransportOptions = {}) {
    this.#requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Docker API request timeout",
    );
  }

  request(input: DockerUnixApiRequest): Promise<DockerUnixApiResponse> {
    throwIfAborted(input.signal);
    if (input.requestTimeoutMs === null && input.signal === undefined) {
      throw new Error("Docker API signal-owned request requires a cancellation signal");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <T>(callback: (value: T) => void, value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        callback(value);
      };
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
              const error = new Error(
                `Docker API response exceeds ${input.maxResponseBytes} bytes`,
              );
              settle(reject, error);
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.once("aborted", () => {
            settle(reject, new Error("Docker API response was aborted"));
          });
          response.once("error", (error) => settle(reject, error));
          response.once("close", () => {
            if (!response.complete) {
              settle(reject, new Error("Docker API response closed before completion"));
            }
          });
          response.on("end", () => {
            settle(resolve, {
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      const requestTimeoutMs = input.requestTimeoutMs ?? this.#requestTimeoutMs;
      if (input.requestTimeoutMs !== null) {
        timer = setTimeout(() => {
          const error = new Error(`Docker API request exceeded ${requestTimeoutMs}ms`);
          settle(reject, error);
          request.destroy();
        }, requestTimeoutMs);
        timer.unref();
      }
      request.once("error", (error) => settle(reject, error));
      if (input.body !== undefined) {
        request.write(input.body);
      }
      request.end();
    });
  }
}

export class NodeDockerUnixAttachTransport implements DockerUnixAttachTransport {
  readonly #requestTimeoutMs: number;

  constructor(options: NodeDockerUnixTransportOptions = {}) {
    this.#requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Docker attach request timeout",
    );
  }

  attach(input: DockerUnixAttachRequest): Promise<PrimeOciAttachedTransport> {
    throwIfAborted(input.signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <T>(callback: (value: T) => void, value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        callback(value);
      };
      const request = httpRequest({
        socketPath: input.socketPath,
        method: "POST",
        path: input.path,
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
        signal: input.signal,
      });
      request.once("upgrade", (_response, socket, head) => {
        settle(resolve, new NodeDockerAttachedTransport(socket, head, input));
      });
      request.once("response", (response) => {
        response.resume();
        settle(reject, new Error(`Docker attach returned status ${response.statusCode ?? 0}`));
      });
      timer = setTimeout(() => {
        const error = new Error(`Docker attach request exceeded ${this.#requestTimeoutMs}ms`);
        settle(reject, error);
        request.destroy();
      }, this.#requestTimeoutMs);
      timer.unref();
      request.once("error", (error) => settle(reject, error));
      request.end();
    });
  }
}

export class NodeDockerUnixCommandAttachTransport implements DockerUnixCommandAttachTransport {
  readonly #requestTimeoutMs: number;

  constructor(options: NodeDockerUnixTransportOptions = {}) {
    this.#requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Docker command attach request timeout",
    );
  }

  attach(input: DockerCommandAttachRequest): Promise<DockerCommandAttachedTransport> {
    throwIfAborted(input.signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = <T>(callback: (value: T) => void, value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        callback(value);
      };
      const request = httpRequest({
        socketPath: input.socketPath,
        method: "POST",
        path: input.path,
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
        signal: input.signal,
      });
      request.once("upgrade", (_response, socket, head) => {
        settle(resolve, new NodeDockerCommandAttachedTransport(socket, head, input.maxFrameBytes));
      });
      request.once("response", (response) => {
        response.resume();
        settle(
          reject,
          new Error(`Docker command attach returned status ${response.statusCode ?? 0}`),
        );
      });
      timer = setTimeout(() => {
        const error = new Error(
          `Docker command attach request exceeded ${this.#requestTimeoutMs}ms`,
        );
        settle(reject, error);
        request.destroy();
      }, this.#requestTimeoutMs);
      timer.unref();
      request.once("error", (error) => settle(reject, error));
      request.end();
    });
  }
}

export class NodeDockerCommandAttachedTransport implements DockerCommandAttachedTransport {
  readonly output: AsyncIterable<DockerRawStreamChunk>;

  constructor(
    private readonly socket: Duplex,
    head: Buffer,
    maxFrameBytes: number,
  ) {
    this.output = commandOutputChunks(socket, head, maxFrameBytes);
  }

  async release(): Promise<void> {
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

export class NodeDockerAttachedTransport implements PrimeOciAttachedTransport {
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
      this.socket.write(Buffer.from(bytes), (error: Error | null | undefined) => {
        if (error !== undefined && error !== null) {
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
  const stderr: Buffer[] = [];
  let sawStdout = false;
  if (head.byteLength > 0) {
    for (const chunk of decoder.push(head)) {
      if (chunk.stream === "stdout") {
        sawStdout = true;
        yield chunk.payload;
      } else {
        stderr.push(chunk.payload);
      }
    }
  }
  for await (const bytes of socket) {
    for (const chunk of decoder.push(bytes as Uint8Array)) {
      if (chunk.stream === "stdout") {
        sawStdout = true;
        yield chunk.payload;
      } else {
        stderr.push(chunk.payload);
      }
    }
  }
  decoder.finish();
  if (stderr.length > 0) {
    throw new Error(primeContainerFailureMessage(Buffer.concat(stderr), sawStdout));
  }
  if (!sawStdout) {
    throw new Error("Prime container ended before readiness");
  }
}

async function* commandOutputChunks(
  socket: Duplex,
  head: Buffer,
  maxFrameBytes: number,
): AsyncIterable<DockerRawStreamChunk> {
  const decoder = new DockerCommandRawStreamDecoder(maxFrameBytes);
  if (head.byteLength > 0) {
    yield* decoder.push(head);
  }
  for await (const bytes of socket) {
    yield* decoder.push(bytes as Uint8Array);
  }
  decoder.finish();
}

function primeContainerFailureMessage(stderr: Buffer, sawStdout: boolean): string {
  let privateDiagnostic: string;
  try {
    privateDiagnostic = new TextDecoder("utf-8", { fatal: true }).decode(stderr).toLowerCase();
  } catch {
    return sawStdout
      ? "Prime container reported a runtime failure"
      : "Prime container ended before readiness";
  }
  if (privateDiagnostic.endsWith("\n")) {
    privateDiagnostic = privateDiagnostic.slice(0, -1);
  }
  if (privateDiagnostic.includes("\n") || privateDiagnostic.includes("\r")) {
    return sawStdout
      ? "Prime container reported a runtime failure"
      : "Prime container ended before readiness";
  }
  if (!sawStdout) {
    switch (privateDiagnostic) {
      case "measure prime container readiness: prime effective process controls contradict the fixed runtime policy":
        return "Prime container readiness failed while validating process controls";
      case "measure prime container readiness: prime effective resource limits contradict the fixed runtime policy":
        return "Prime container readiness failed while validating resource limits";
      case "measure prime container readiness: prime effective filesystem controls contradict the fixed runtime policy":
        return "Prime container readiness failed while validating filesystem controls";
      case "measure prime container readiness: prime effective network controls contradict the fixed runtime policy":
        return "Prime container readiness failed while validating network controls";
      case "measure prime container readiness: prime effective system files contradict the fixed runtime policy":
        return "Prime container readiness failed while validating system files";
      case "measure prime container readiness: prime effective stream controls contradict the fixed runtime policy":
        return "Prime container readiness failed while validating attached streams";
      case "measure prime container readiness: prime effective log policy contradicts the fixed runtime policy":
        return "Prime container readiness failed while validating the log policy";
      case "measure prime container readiness: prime effective health policy contradicts the fixed runtime policy":
        return "Prime container readiness failed while validating the health policy";
    }
    const readinessPrefix = "measure prime container readiness: ";
    const readinessDiagnostic = privateDiagnostic.slice(readinessPrefix.length);
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, [
        "read prime process status:",
        "linux process status repeats ",
        "linux process status omits ",
        "linux process group list is invalid",
        "linux effective capability set is invalid",
        "linux effective capability bit ",
        "linux no-new-privileges value is invalid",
        "linux seccomp mode is invalid",
        "read prime dumpable state:",
        "read prime seccomp state:",
      ])
    ) {
      return "Prime container readiness failed while reading process evidence";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("prime runtime does not use cgroup version two")
    ) {
      return "Prime container readiness failed while validating the cgroup mode";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, ["read prime cgroup pids.max:", "prime cgroup pids.max "])
    ) {
      return "Prime container readiness failed while validating cgroup PID limits";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, [
        "read prime cgroup memory.max:",
        "prime cgroup memory.max ",
        "read prime cgroup memory.swap.max:",
        "prime cgroup memory.swap.max ",
      ])
    ) {
      return "Prime container readiness failed while validating cgroup memory limits";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, ["read prime cgroup cpu.max:", "prime cgroup cpu.max "])
    ) {
      return "Prime container readiness failed while validating cgroup CPU limits";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, ["read prime cgroup io.max:", "prime cgroup io.max "])
    ) {
      return "Prime container readiness failed while validating image block I/O limits";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, [
        "read prime open files limit:",
        "read prime user processes limit:",
        "read prime file size limit:",
        "read prime core size limit:",
      ])
    ) {
      return "Prime container readiness failed while validating process resource limits";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("read prime mount information:")
    ) {
      return "Prime container readiness failed while reading filesystem mount information";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("linux mount information line ")
    ) {
      return "Prime container readiness failed while parsing filesystem mount information";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("linux mount information repeats ")
    ) {
      return "Prime container readiness found repeated authoritative mount information";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("prime root mount is absent")
    ) {
      return "Prime container readiness did not find the root mount";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, [
        "prime runtime path ",
        "inspect prime tmpfs ",
        "inspect prime tmpfs root ",
      ])
    ) {
      return "Prime container readiness failed while validating runtime tmpfs evidence";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("inspect prime network interfaces:")
    ) {
      return "Prime container readiness failed while reading network interfaces";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      readinessDiagnostic.startsWith("inspect prime network routes:")
    ) {
      return "Prime container readiness failed while reading network routes";
    }
    if (
      privateDiagnostic.startsWith(readinessPrefix) &&
      startsWithAny(readinessDiagnostic, [
        "read docker system file mount information:",
        "parse docker system file mount information:",
        "docker system files are not three read-only mounts",
        "open docker system file ",
        "inspect docker system file ",
        "read docker system file ",
        "docker hostname contradicts the admitted content",
        "docker hosts file contradicts the admitted content",
        "docker resolver file contradicts the admitted content",
      ])
    ) {
      return "Prime container readiness failed while validating system files";
    }
  }
  switch (privateDiagnostic) {
    case "run prime driver: prime driver stage failure: read-supervisor-input":
      return "Prime driver failed while reading its supervisor channel";
    case "run prime driver: prime driver stage failure: write-supervisor-output":
      return "Prime driver failed while writing its supervisor channel";
    case "run prime driver: prime driver stage failure: resolve-workspace":
      return "Prime driver failed while resolving the trial workspace";
    case "run prime driver: prime driver stage failure: load-sdk":
      return "Prime driver failed while loading the native SDK";
    case "run prime driver: prime driver stage failure: load-agent-sdk":
      return "Prime driver failed while loading the native agent SDK";
    case "run prime driver: prime driver stage failure: load-ai-sdk":
      return "Prime driver failed while loading the native AI SDK";
    case "run prime driver: prime driver stage failure: initialize-sdk":
      return "Prime driver failed while configuring the native SDK";
    case "run prime driver: prime driver stage failure: create-ipython-tool":
      return "Prime driver failed while creating the IPython tool";
    case "run prime driver: prime driver stage failure: start-ipython-kernel":
      return "Prime driver failed while starting the persistent IPython kernel";
    case "run prime driver: prime driver stage failure: prepare-ipython-kernel-connection":
      return "Prime driver failed while preparing the IPython kernel connection";
    case "run prime driver: prime driver stage failure: launch-ipython-kernel":
      return "Prime driver failed while launching the persistent IPython kernel";
    case "run prime driver: prime driver stage failure: resolve-ipython-kernel-connection":
      return "Prime driver failed while resolving the IPython kernel connection";
    case "run prime driver: prime driver stage failure: probe-ipython-kernel":
      return "Prime driver failed while probing the persistent IPython kernel";
    case "run prime driver: prime driver stage failure: bootstrap-ipython-kernel":
      return "Prime driver failed while preparing the IPython runtime";
    case "run prime driver: prime driver stage failure: create-sdk-session":
      return "Prime driver failed while creating the native SDK session";
    case "run prime driver: prime driver stage failure: validate-sdk-session":
      return "Prime driver failed while validating the native SDK session";
    case "run prime driver: prime driver stage failure: observe-sdk-session":
      return "Prime driver failed while observing the native SDK session";
    case "run prime driver: prime driver stage failure: dispose-sdk-session":
      return "Prime driver failed while settling the native SDK session";
    case "run prime driver: prime driver stage failure: unexpected":
      return "Prime driver failed unexpectedly";
    case "run prime driver: prime driver relay failed while validating bootstrap":
      return "Prime driver relay failed while validating its bootstrap";
    case "run prime driver: prime driver relay failed while writing bootstrap to the driver":
      return "Prime driver relay failed while sending its bootstrap";
    case "run prime driver: prime driver relay failed while reading the driver channel":
      return "Prime driver relay failed while reading the driver channel";
    case "run prime driver: prime driver relay failed while validating a driver frame":
      return "Prime driver relay failed while validating a driver frame";
    case "run prime driver: prime driver relay failed while writing the host channel":
      return "Prime driver relay failed while writing the host channel";
    case "run prime driver: prime driver relay failed while reading the host channel":
      return "Prime driver relay failed while reading the host channel";
    case "run prime driver: prime driver relay failed while validating a host frame":
      return "Prime driver relay failed while validating a host frame";
    case "run prime driver: prime driver relay failed while writing the driver channel":
      return "Prime driver relay failed while writing the driver channel";
  }
  const runDriverPrefix = "run prime driver: ";
  const runDriverDiagnostic = privateDiagnostic.slice(runDriverPrefix.length);
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    startsWithAny(runDriverDiagnostic, [
      "prime driver process options are incomplete",
      "create prime driver socket:",
      "create prime driver socket descriptors",
      "create prime driver hardening pipe:",
      "open null device for prime driver:",
      "prime driver user and group must be set together",
      "prime driver supplemental group is negative",
      "create prime driver diagnostic pipe:",
      "start prime driver:",
      "close parent copy of prime driver socket:",
      "close parent copy of prime hardening pipe:",
      "close parent copy of prime driver diagnostic:",
    ])
  ) {
    return "Prime driver failed while starting its restricted process";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    startsWithAny(runDriverDiagnostic, [
      "prime driver hardening proof is invalid",
      "prime driver hardening proof timed out",
    ])
  ) {
    return "Prime driver failed while proving process hardening";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    startsWithAny(runDriverDiagnostic, [
      "prime driver relay input is incomplete",
      "parse prime inner ",
      "prime inner ",
      "read prime inner frame:",
      "write prime inner frame:",
      "prime driver traffic exceeds ",
      "prime driver must send ready ",
      "prime driver sent more than one ready ",
      "prime container frame type ",
      "read prime container frame ",
      "write prime container frame ",
    ])
  ) {
    return "Prime driver failed while relaying its private protocol";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    startsWithAny(runDriverDiagnostic, [
      "read prime driver diagnostic:",
      "prime driver diagnostic exceeds ",
    ])
  ) {
    return "Prime driver failed while reading its private diagnostic";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    runDriverDiagnostic.startsWith("prime driver exited with code ")
  ) {
    return "Prime driver process exited before terminal settlement";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    runDriverDiagnostic === "prime driver was terminated by a signal before terminal settlement"
  ) {
    return "Prime driver process was terminated before terminal settlement";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    runDriverDiagnostic ===
      "prime driver did not settle after its private channel closed without a diagnostic"
  ) {
    return "Prime driver process stalled without a private diagnostic";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    runDriverDiagnostic ===
      "prime driver did not settle after its private channel closed with an unclassified diagnostic"
  ) {
    return "Prime driver process stalled with an unclassified private diagnostic";
  }
  if (
    privateDiagnostic.startsWith(runDriverPrefix) &&
    runDriverDiagnostic === "close prime driver relay channel"
  ) {
    return "Prime driver failed while closing its private relay channel";
  }
  if (privateDiagnostic.startsWith("settle prime kernel service: close prime kernel listener: ")) {
    return "Prime container failed while closing its kernel listener";
  }
  const kernelServicePrefix = "settle prime kernel service: run prime kernel service: ";
  const kernelServiceDiagnostic = privateDiagnostic.slice(kernelServicePrefix.length);
  if (
    privateDiagnostic.startsWith(kernelServicePrefix) &&
    kernelServiceDiagnostic.startsWith("accept kernel proxy request: ")
  ) {
    return "Prime container failed while accepting a kernel request";
  }
  if (
    privateDiagnostic.startsWith(kernelServicePrefix) &&
    kernelServiceDiagnostic === "prime session requested more than one python kernel"
  ) {
    return "Prime container rejected an additional Python kernel request";
  }
  if (
    privateDiagnostic.startsWith(kernelServicePrefix) &&
    (kernelServiceDiagnostic.includes("kernel peer") ||
      kernelServiceDiagnostic.startsWith("kernel request peer user "))
  ) {
    return "Prime container failed while validating the kernel request peer";
  }
  if (
    privateDiagnostic.startsWith(kernelServicePrefix) &&
    (kernelServiceDiagnostic.startsWith("read kernel request") ||
      kernelServiceDiagnostic.startsWith("kernel request "))
  ) {
    return "Prime container failed while reading a kernel request";
  }
  if (
    privateDiagnostic.startsWith(kernelServicePrefix) &&
    (kernelServiceDiagnostic.startsWith("write kernel response: ") ||
      kernelServiceDiagnostic === "kernel response cannot be encoded")
  ) {
    return "Prime container failed while returning a kernel result";
  }
  if (privateDiagnostic.startsWith(kernelServicePrefix)) {
    return "Prime container failed while settling its active kernel request";
  }
  if (
    privateDiagnostic.startsWith("settle prime kernel service: reconcile prime python processes: ")
  ) {
    return "Prime container failed while reconciling Python processes";
  }
  if (privateDiagnostic.startsWith("capture prime workspace: ")) {
    return "Prime container failed while capturing its result workspace";
  }
  if (privateDiagnostic.startsWith("write prime result: ")) {
    return "Prime container failed while publishing its result";
  }
  if (privateDiagnostic.startsWith("write prime settlement: ")) {
    return "Prime container failed while publishing its settlement";
  }
  if (
    startsWithAny(privateDiagnostic, [
      "prime supervisor must start",
      "set prime supervisor core limit:",
      "disable prime supervisor dumpable state:",
    ])
  ) {
    return "Prime container failed while applying supervisor hardening";
  }
  if (
    startsWithAny(privateDiagnostic, [
      "create prime private path ",
      "set prime private path owner ",
      "set prime private path mode ",
      "create kernel supervisor directory:",
      "remove stale kernel supervisor socket:",
      "listen on kernel supervisor socket:",
      "set kernel supervisor socket owner:",
      "set kernel supervisor socket mode:",
      "close kernel supervisor listener:",
    ])
  ) {
    return "Prime container failed while preparing its private runtime";
  }
  if (
    startsWithAny(privateDiagnostic, [
      "read prime container frame ",
      "unknown prime container frame type:",
      "parse prime readiness challenge:",
      "prime readiness challenge violates the closed schema",
      "prime preparation ",
    ])
  ) {
    return "Prime container failed while reading attached protocol input";
  }
  return sawStdout
    ? "Prime container reported a runtime failure"
    : "Prime container ended before readiness";
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

function asDockerObject(value: unknown, label: string): Record<string, unknown> {
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

function dockerStartFailureMessage(response: DockerUnixApiResponse): string {
  const privateMessage = parseDockerErrorMessage(response.body)?.toLowerCase();
  if (privateMessage === undefined) {
    return `Docker start returned status ${response.statusCode}`;
  }
  const hasUnclassifiedMissingObject = privateMessage.includes("no such file or directory");
  const hasUnclassifiedOpen =
    hasUnclassifiedMissingObject && /(?:^|: )(?:open|openat|openat2)(?: |:)/u.test(privateMessage);
  if (
    privateMessage.includes("oci runtime create failed") &&
    privateMessage.includes("fork/exec ")
  ) {
    return "Docker start failed while launching the selected container runtime";
  }
  if (hasUnclassifiedMissingObject && privateMessage.includes("failed to write bundle spec:")) {
    return "Docker start failed while writing the container runtime bundle";
  }
  if (
    hasUnclassifiedMissingObject &&
    /(?:^|: )open (?:[^:\n]*\/)?config\.json:/u.test(privateMessage)
  ) {
    return "Docker start failed while reading the container runtime bundle";
  }
  if (
    hasUnclassifiedOpen &&
    privateMessage.includes("failed to start shim:") &&
    privateMessage.includes("open shim log pipe:")
  ) {
    return "Docker start failed while opening the container runtime shim log";
  }
  if (
    hasUnclassifiedOpen &&
    privateMessage.includes("failed to start shim:") &&
    privateMessage.includes("failed to create temp file:")
  ) {
    return "Docker start failed while publishing the container runtime shim address";
  }
  if (
    hasUnclassifiedOpen &&
    privateMessage.includes("failed to start shim:") &&
    privateMessage.includes("shim-binary-path")
  ) {
    return "Docker start failed while recording the container runtime shim identity";
  }
  if (hasUnclassifiedOpen && privateMessage.includes("failed to start shim:")) {
    return "Docker start failed while opening a container runtime shim startup object";
  }
  if (includesAny(privateMessage, ["io.max", "blkio", "block io"])) {
    return "Docker start failed while applying container block I/O controls";
  }
  if (includesAny(privateMessage, ["memory.max", "memory.swap", "memory limit"])) {
    return "Docker start failed while applying container memory controls";
  }
  if (includesAny(privateMessage, ["cpu.max", "cpu quota", "cpu period"])) {
    return "Docker start failed while applying container CPU controls";
  }
  if (includesAny(privateMessage, ["pids.max", "pids limit", "pid limit"])) {
    return "Docker start failed while applying container PID controls";
  }
  if (includesAny(privateMessage, ["rlimit", "resource limit", "setrlimit"])) {
    return "Docker start failed while applying container process limits";
  }
  if (privateMessage.includes("cgroup")) {
    return "Docker start failed while applying container cgroup controls";
  }
  if (privateMessage.includes("seccomp")) {
    return "Docker start failed while applying the container seccomp policy";
  }
  if (
    includesAny(privateMessage, [
      "mount",
      "rootfs",
      "tmpfs",
      "masked path",
      "readonly path",
      "read-only path",
      "can't mask path",
      "pivot_root",
      "pivot root",
    ]) ||
    (privateMessage.includes("can't make") && privateMessage.includes("read-only"))
  ) {
    return "Docker start failed while applying container filesystem isolation";
  }
  if (includesAny(privateMessage, ["chdir to cwd", "current working directory"])) {
    return "Docker start failed while entering the container working directory";
  }
  if (includesAny(privateMessage, ["setup user", "setuid", "setgid", "setgroups"])) {
    return "Docker start failed while applying the container user identity";
  }
  if (includesAny(privateMessage, ["capabilit", "apply caps", "bounding set", "keep caps"])) {
    return "Docker start failed while applying container capabilities";
  }
  if (includesAny(privateMessage, ["set_no_new_privs", "no-new-privileges"])) {
    return "Docker start failed while applying no-new-privileges";
  }
  if (privateMessage.includes("apparmor")) {
    return "Docker start failed while applying the container AppArmor policy";
  }
  if (
    /(?:^|[^a-z])exec(?::| \/)/u.test(privateMessage) ||
    privateMessage.includes("executable file not found")
  ) {
    return "Docker start failed while executing the container entrypoint";
  }
  if (
    includesAny(privateMessage, [
      "exec fds",
      "exec fifo",
      "log pipe",
      "pipe fds",
      "init process i/o",
      "cloexec",
    ])
  ) {
    return "Docker start failed while setting up container runtime file descriptors";
  }
  if (
    includesAny(privateMessage, [
      "init pipe",
      "sync pipe",
      "sync ready",
      "bootstrap data to pipe",
      "final child's pid from pipe",
      "pid from init pipe",
    ])
  ) {
    return "Docker start failed while synchronizing the container runtime process";
  }
  if (privateMessage.includes("container process is already dead")) {
    return "Docker start failed because the container runtime process ended early";
  }
  if (privateMessage.includes("store init state")) {
    return "Docker start failed while recording container runtime state";
  }
  if (
    includesAny(privateMessage, [
      "unable to retrieve oci runtime error",
      "oci runtime create failed: exit status",
    ])
  ) {
    return "Docker start failed before the container runtime returned a diagnostic";
  }
  if (
    includesAny(privateMessage, [
      "failed to open stdin fifo",
      "failed to open stdout fifo",
      "failed to open stderr fifo",
    ])
  ) {
    return "Docker start failed while opening container runtime streams";
  }
  if (includesAny(privateMessage, ["failed to start io pipe copy", "unable to copy pipes"])) {
    return "Docker start failed while copying container runtime streams";
  }
  if (privateMessage.includes("failed to retrieve oci runtime container pid")) {
    return "Docker start failed while reading the container runtime process identity";
  }
  if (privateMessage.includes('runtime "io.containerd.runc.v2" binary not installed')) {
    return "Docker start failed while launching the container runtime shim";
  }
  if (privateMessage.includes("unable to create safe /proc/self/exe clone for runc init")) {
    return "Docker start failed while preparing the container runtime init binary";
  }
  if (
    includesAny(privateMessage, ["unable to create new parent process", "unable to start init"])
  ) {
    return "Docker start failed while launching the container runtime init process";
  }
  if (
    includesAny(privateMessage, [
      "error creating device nodes",
      "error setting up ptmx",
      "error setting up /dev symlinks",
      "error reopening /dev/null inside container",
      "stat /dev/null",
    ])
  ) {
    return "Docker start failed while preparing isolated container devices";
  }
  if (
    includesAny(privateMessage, [
      "unable to join session keyring",
      "unable to mod keyring permissions",
      "sethostname:",
      "setdomainname:",
      "can't get pdeath signal",
      "can't restore pdeath signal",
    ])
  ) {
    return "Docker start failed while applying the container runtime init policy";
  }
  if (
    includesAny(privateMessage, [
      "/proc/sys/net/ipv4/ping_group_range",
      "/proc/sys/net/ipv4/ip_unprivileged_port_start",
    ])
  ) {
    return "Docker start failed while applying container runtime network defaults";
  }
  if (includesAny(privateMessage, ["permission denied"])) {
    return "Docker start failed while applying the container process policy";
  }
  if (
    hasUnclassifiedMissingObject &&
    /(?:^|: )(?:mkdir|mkdirat|mknod|symlink)(?: |:)/u.test(privateMessage)
  ) {
    return "Docker start failed while creating a container runtime object";
  }
  if (
    hasUnclassifiedOpen &&
    privateMessage.includes("failed to create shim task:") &&
    privateMessage.includes("oci runtime create failed")
  ) {
    return "Docker start failed while opening an OCI runtime create object";
  }
  if (hasUnclassifiedOpen && privateMessage.includes("failed to create shim task:")) {
    return "Docker start failed while opening a container runtime task object";
  }
  if (hasUnclassifiedOpen) {
    return "Docker start failed while opening a container runtime object";
  }
  if (
    hasUnclassifiedMissingObject &&
    /(?:^|: )(?:stat|lstat|statfs)(?: |:)/u.test(privateMessage)
  ) {
    return "Docker start failed while inspecting a container runtime object";
  }
  if (hasUnclassifiedMissingObject && /(?:^|: )readlink(?: |:)/u.test(privateMessage)) {
    return "Docker start failed while resolving a container runtime link";
  }
  if (hasUnclassifiedMissingObject && /(?:^|: )(?:chdir|getwd)(?: |:)/u.test(privateMessage)) {
    return "Docker start failed while resolving the container runtime working directory";
  }
  const hasUnclassifiedExecution = /(?:^|[^a-z])exec(?:[^a-z]|$)/u.test(privateMessage);
  if (hasUnclassifiedExecution && hasUnclassifiedMissingObject) {
    return "Docker start failed while resolving a runtime execution object";
  }
  if (hasUnclassifiedExecution) {
    return "Docker start failed during runtime execution setup";
  }
  if (hasUnclassifiedMissingObject) {
    return "Docker start failed because a runtime object was missing";
  }
  if (
    includesAny(privateMessage, [
      "create task",
      "create shim task",
      "oci runtime create",
      "runc create",
    ])
  ) {
    return "Docker start failed while creating the container runtime task";
  }
  return `Docker start returned status ${response.statusCode}`;
}

function parseDockerErrorMessage(body: string): string | undefined {
  try {
    const parsed = parseStrictJson(body, {
      maxDepth: 4,
      maxNodes: 32,
      valueLabel: "Docker error response",
    });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const message = (parsed as Record<string, unknown>).message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function includesAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function startsWithAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.startsWith(candidate));
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
