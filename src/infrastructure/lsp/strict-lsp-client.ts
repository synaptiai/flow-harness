import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LanguageServerSnapshot } from "../../domain/capability/language-server.js";
import { validateLanguageServerSnapshot } from "../../domain/capability/language-server.js";
import {
  normalizeSemanticRequest,
  normalizeSemanticResult,
  type SemanticRequest,
  type SemanticResult,
} from "../../domain/semantic/semantic-code.js";
import { parseStrictJson, type StrictJsonValue } from "../../domain/strict-json.js";

export const MAX_LSP_HEADER_BYTES = 8 * 1024;
export const MAX_LSP_MESSAGE_BYTES = 1024 * 1024;
export const MAX_LSP_MESSAGES = 64;
export const MAX_LSP_SOURCE_BYTES = 1024 * 1024;

export type StrictLspClientErrorCode =
  | "semantic_protocol_failed"
  | "semantic_operation_unsupported"
  | "semantic_request_invalid"
  | "semantic_response_limit_exceeded";

export class StrictLspClientError extends Error {
  override readonly name = "StrictLspClientError";

  constructor(readonly code: StrictLspClientErrorCode) {
    super(
      code === "semantic_protocol_failed"
        ? "semantic language-service protocol failed"
        : code === "semantic_operation_unsupported"
          ? "semantic operation is not supported"
          : code === "semantic_request_invalid"
            ? "semantic request is invalid"
            : "semantic response limit was exceeded",
    );
  }
}

export interface StrictLspTransport {
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
}

export interface StrictLspQueryInput {
  readonly transport: StrictLspTransport;
  readonly languageServer: LanguageServerSnapshot;
  readonly projectRoot: string;
  readonly projectPaths: readonly string[];
  readonly source: {
    readonly path: string;
    readonly content: Uint8Array;
  };
  readonly request: unknown;
  readonly signal?: AbortSignal | undefined;
}

export class LspMessageDecoder {
  #buffer = Buffer.alloc(0);
  #expectedBodyBytes: number | undefined;
  #messages = 0;

  push(input: Uint8Array): readonly StrictJsonValue[] {
    try {
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(input)]);
      const output: StrictJsonValue[] = [];
      while (true) {
        if (this.#expectedBodyBytes === undefined) {
          this.#assertCrLfGrammar();
          const boundary = this.#buffer.indexOf("\r\n\r\n");
          if (boundary < 0) {
            if (this.#buffer.byteLength > MAX_LSP_HEADER_BYTES) {
              throw new StrictLspClientError("semantic_protocol_failed");
            }
            return output;
          }
          if (boundary + 4 > MAX_LSP_HEADER_BYTES) {
            throw new StrictLspClientError("semantic_protocol_failed");
          }
          this.#expectedBodyBytes = parseHeader(this.#buffer.subarray(0, boundary));
          this.#buffer = this.#buffer.subarray(boundary + 4);
        }
        if (this.#buffer.byteLength < this.#expectedBodyBytes) {
          return output;
        }
        const body = this.#buffer.subarray(0, this.#expectedBodyBytes);
        this.#buffer = this.#buffer.subarray(this.#expectedBodyBytes);
        this.#expectedBodyBytes = undefined;
        this.#messages += 1;
        if (this.#messages > MAX_LSP_MESSAGES) {
          throw new StrictLspClientError("semantic_response_limit_exceeded");
        }
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
        const value = parseStrictJson(decoded, {
          maxDepth: 32,
          maxNodes: 50_000,
          valueLabel: "language-service message",
        });
        if (!isRecord(value)) {
          throw new StrictLspClientError("semantic_protocol_failed");
        }
        output.push(normalizeJson(value));
      }
    } catch (error) {
      if (error instanceof StrictLspClientError) {
        throw error;
      }
      throw new StrictLspClientError("semantic_protocol_failed");
    }
  }

  finish(): readonly StrictJsonValue[] {
    if (this.#buffer.byteLength !== 0 || this.#expectedBodyBytes !== undefined) {
      throw new StrictLspClientError("semantic_protocol_failed");
    }
    return [];
  }

  #assertCrLfGrammar(): void {
    for (let index = 0; index < this.#buffer.byteLength; index += 1) {
      const byte = this.#buffer[index];
      if (byte === 0x0a && this.#buffer[index - 1] !== 0x0d) {
        throw new StrictLspClientError("semantic_protocol_failed");
      }
      if (
        byte === 0x0d &&
        index + 1 < this.#buffer.byteLength &&
        this.#buffer[index + 1] !== 0x0a
      ) {
        throw new StrictLspClientError("semantic_protocol_failed");
      }
    }
  }
}

export async function runStrictLspQuery(input: StrictLspQueryInput): Promise<SemanticResult> {
  input.signal?.throwIfAborted();
  try {
    const languageServer = validateLanguageServerSnapshot(input.languageServer);
    const request = normalizeSemanticRequest(input.request);
    const projectRoot = validateProjectRoot(input.projectRoot);
    if (
      request.path !== input.source.path ||
      input.source.content.byteLength > MAX_LSP_SOURCE_BYTES ||
      !input.projectPaths.includes(input.source.path)
    ) {
      throw new StrictLspClientError("semantic_request_invalid");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.source.content);
    const languageId = selectLanguageId(languageServer, request.path);
    const connection = new StrictLspConnection(input.transport, input.signal);
    const initialize = await connection.request("initialize", {
      processId: null,
      rootUri: pathToFileURL(projectRoot).href,
      capabilities: {
        textDocument: {
          definition: {},
          references: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          diagnostic: {},
        },
        workspace: { applyEdit: false, workspaceFolders: false },
      },
      initializationOptions: languageServer.initializationOptions ?? null,
      workspaceFolders: null,
      clientInfo: { name: "flow-harness", version: "1" },
    });
    assertOperationCapability(initialize, request.operation);
    await connection.notify("initialized", {});
    const sourceUri = pathToFileURL(resolve(projectRoot, request.path)).href;
    await connection.notify("textDocument/didOpen", {
      textDocument: { uri: sourceUri, languageId, version: 1, text },
    });
    const rawResult = await requestOperation(connection, request, sourceUri);
    const result = translateResult(rawResult, request, projectRoot, input.projectPaths);
    const shutdown = await connection.request("shutdown", null);
    if (shutdown !== null) {
      throw new StrictLspClientError("semantic_protocol_failed");
    }
    await connection.notify("exit", null);
    return result;
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof StrictLspClientError) {
      throw error;
    }
    throw new StrictLspClientError("semantic_protocol_failed");
  }
}

class StrictLspConnection {
  readonly #decoder = new LspMessageDecoder();
  readonly #pending: StrictJsonValue[] = [];
  #nextId = 1;

  constructor(
    private readonly transport: StrictLspTransport,
    private readonly signal?: AbortSignal,
  ) {}

  async request(method: string, params: StrictJsonValue): Promise<StrictJsonValue> {
    const id = this.#nextId;
    this.#nextId += 1;
    await this.#write({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const message = await this.#nextMessage();
      if (!isRecord(message) || message.jsonrpc !== "2.0") {
        throw new StrictLspClientError("semantic_protocol_failed");
      }
      if (message.id === id) {
        if ("error" in message || !("result" in message)) {
          throw new StrictLspClientError("semantic_protocol_failed");
        }
        return message.result as StrictJsonValue;
      }
      if (typeof message.method === "string" && !("id" in message)) {
        if (
          message.method === "window/logMessage" ||
          message.method === "window/showMessage" ||
          message.method === "textDocument/publishDiagnostics"
        ) {
          continue;
        }
      }
      throw new StrictLspClientError("semantic_protocol_failed");
    }
  }

  async notify(method: string, params: StrictJsonValue): Promise<void> {
    await this.#write({ jsonrpc: "2.0", method, params });
  }

  async #write(message: StrictJsonValue): Promise<void> {
    this.signal?.throwIfAborted();
    await this.transport.write(encodeMessage(message), this.signal);
    this.signal?.throwIfAborted();
  }

  async #nextMessage(): Promise<StrictJsonValue> {
    while (this.#pending.length === 0) {
      this.signal?.throwIfAborted();
      const chunk = await this.transport.read(this.signal);
      this.signal?.throwIfAborted();
      if (chunk === null) {
        this.#decoder.finish();
        throw new StrictLspClientError("semantic_protocol_failed");
      }
      this.#pending.push(...this.#decoder.push(chunk));
    }
    const message = this.#pending.shift();
    if (message === undefined) {
      throw new StrictLspClientError("semantic_protocol_failed");
    }
    return message;
  }
}

async function requestOperation(
  connection: StrictLspConnection,
  request: SemanticRequest,
  uri: string,
): Promise<StrictJsonValue> {
  if (request.operation === "diagnostics") {
    return connection.request("textDocument/diagnostic", { textDocument: { uri } });
  }
  const params = {
    textDocument: { uri },
    position: { line: request.position.line, character: request.position.character },
    ...(request.operation === "references" ? { context: { includeDeclaration: true } } : {}),
  };
  return connection.request(
    request.operation === "definition"
      ? "textDocument/definition"
      : request.operation === "references"
        ? "textDocument/references"
        : "textDocument/hover",
    params,
  );
}

function translateResult(
  raw: StrictJsonValue,
  request: SemanticRequest,
  projectRoot: string,
  projectPaths: readonly string[],
): SemanticResult {
  try {
    if (request.operation === "diagnostics") {
      if (!isRecord(raw) || raw.kind !== "full" || !Array.isArray(raw.items)) {
        throw new Error("diagnostics shape");
      }
      return normalizeSemanticResult(
        {
          operation: request.operation,
          diagnostics: raw.items.map((item) => translateDiagnostic(item, request.path)),
        },
        projectPaths,
      );
    }
    if (request.operation === "definition" || request.operation === "references") {
      const items = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      return normalizeSemanticResult(
        {
          operation: request.operation,
          locations: items.map((item) => translateLocation(item, projectRoot)),
        },
        projectPaths,
      );
    }
    if (raw === null) {
      return normalizeSemanticResult({ operation: "hover", hover: null }, projectPaths);
    }
    if (!isRecord(raw) || !isRecord(raw.contents)) {
      throw new Error("hover shape");
    }
    const format = raw.contents.kind;
    const value = raw.contents.value;
    if ((format !== "markdown" && format !== "plaintext") || typeof value !== "string") {
      throw new Error("hover content");
    }
    return normalizeSemanticResult(
      {
        operation: "hover",
        hover: {
          path: request.path,
          range: raw.range ?? {
            start: request.position,
            end: request.position,
          },
          format,
          value,
        },
      },
      projectPaths,
    );
  } catch {
    throw new StrictLspClientError("semantic_protocol_failed");
  }
}

function translateDiagnostic(value: unknown, path: string): unknown {
  if (!isRecord(value)) {
    throw new Error("diagnostic shape");
  }
  const severity =
    value.severity === 1
      ? "error"
      : value.severity === 2
        ? "warning"
        : value.severity === 3
          ? "information"
          : value.severity === 4
            ? "hint"
            : undefined;
  if (severity === undefined || typeof value.message !== "string") {
    throw new Error("diagnostic value");
  }
  const code =
    typeof value.code === "string" ||
    (typeof value.code === "number" && Number.isSafeInteger(value.code))
      ? String(value.code)
      : undefined;
  return {
    path,
    range: value.range,
    severity,
    ...(code === undefined ? {} : { code }),
    message: value.message,
  };
}

function translateLocation(value: unknown, projectRoot: string): unknown {
  if (!isRecord(value) || typeof value.uri !== "string") {
    throw new Error("location shape");
  }
  let absolutePath: string;
  try {
    absolutePath = fileURLToPath(value.uri);
  } catch {
    throw new Error("location URI");
  }
  const path = relative(projectRoot, absolutePath);
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("foreign location");
  }
  return { path: path.split(sep).join("/"), range: value.range };
}

function assertOperationCapability(
  value: StrictJsonValue,
  operation: SemanticRequest["operation"],
): void {
  if (!isRecord(value) || !isRecord(value.capabilities)) {
    throw new StrictLspClientError("semantic_protocol_failed");
  }
  const capability =
    operation === "diagnostics"
      ? value.capabilities.diagnosticProvider
      : operation === "definition"
        ? value.capabilities.definitionProvider
        : operation === "references"
          ? value.capabilities.referencesProvider
          : value.capabilities.hoverProvider;
  if (capability !== true && !isRecord(capability)) {
    throw new StrictLspClientError("semantic_operation_unsupported");
  }
}

function selectLanguageId(languageServer: LanguageServerSnapshot, path: string): string {
  const selected = languageServer.languages.find((language) =>
    language.suffixes.some((suffix) => path.endsWith(suffix)),
  );
  if (selected === undefined) {
    throw new StrictLspClientError("semantic_request_invalid");
  }
  return selected.id;
}

function validateProjectRoot(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\0")) {
    throw new StrictLspClientError("semantic_request_invalid");
  }
  return value;
}

function encodeMessage(message: StrictJsonValue): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > MAX_LSP_MESSAGE_BYTES) {
    throw new StrictLspClientError("semantic_response_limit_exceeded");
  }
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"), body]);
}

function parseHeader(value: Uint8Array): number {
  const lines = Buffer.from(value).toString("ascii").split("\r\n");
  let contentLength: number | undefined;
  for (const line of lines) {
    const [name, headerValue, ...extra] = line.split(":");
    if (name === undefined || extra.length > 0 || headerValue === undefined) {
      throw new StrictLspClientError("semantic_protocol_failed");
    }
    if (name.toLowerCase() === "content-length") {
      if (contentLength !== undefined || !/^(?:0|[1-9][0-9]*)$/.test(headerValue.trim())) {
        throw new StrictLspClientError("semantic_protocol_failed");
      }
      contentLength = Number(headerValue.trim());
    } else if (name.toLowerCase() !== "content-type") {
      throw new StrictLspClientError("semantic_protocol_failed");
    }
  }
  if (
    contentLength === undefined ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_LSP_MESSAGE_BYTES
  ) {
    throw new StrictLspClientError("semantic_protocol_failed");
  }
  return contentLength;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeJson(value: StrictJsonValue): StrictJsonValue {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}
