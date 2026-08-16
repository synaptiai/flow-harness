import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { RunPresentationRenderer } from "../../application/run-presentation-session.js";
import {
  MAX_BROWSER_ACTION_BODY_BYTES,
  parseBrowserPresentationActionRequest,
} from "../../domain/presentation/browser-presentation-protocol.js";
import {
  encodeFlowPresentationDocument,
  type FlowPresentationDocument,
  parseFlowPresentationDocument,
} from "../../domain/presentation/flow-presentation.js";
import {
  LOCAL_BROWSER_PRESENTATION_CSS,
  LOCAL_BROWSER_PRESENTATION_HTML,
  LOCAL_BROWSER_PRESENTATION_JAVASCRIPT,
} from "./local-browser-presentation-assets.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const SESSION_CAPABILITY_BYTES = 32;
const SESSION_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CONNECTIONS = 16;
const RESPONSE_WRITE_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINAL_DELIVERY_TIMEOUT_MS = 30_000;

class BrowserActionBodyTooLargeError extends Error {}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export interface BrowserPresentationActionController {
  readonly update: (document: FlowPresentationDocument) => void;
  readonly executeCurrent: (
    documentSequence: number,
    actionId: string,
    options?: { readonly reason?: string },
  ) => Promise<unknown>;
}

export interface LocalBrowserPresentationHostOptions {
  readonly actionController: BrowserPresentationActionController;
  readonly createCapability?: () => Uint8Array;
  readonly terminalDeliveryTimeoutMs?: number;
}

export interface LocalBrowserPresentationSession {
  readonly url: string;
}

export interface BrowserPresentationHost extends RunPresentationRenderer {
  readonly start: () => Promise<LocalBrowserPresentationSession>;
}

export class LocalBrowserPresentationHost implements BrowserPresentationHost {
  readonly #actionController: BrowserPresentationActionController;
  readonly #createCapability: () => Uint8Array;
  readonly #terminalDeliveryTimeoutMs: number;
  #startAttempted = false;
  #server: Server | undefined;
  #origin: string | undefined;
  #expectedHost: string | undefined;
  #capability: Buffer | undefined;
  #latestDocument: FlowPresentationDocument | undefined;
  #latestLine: Buffer | undefined;
  #observer: ServerResponse | undefined;
  readonly #pendingActionKeys = new Set<string>();
  readonly #consumedActionKeys = new Set<string>();
  #terminalDelivery: Promise<void> | undefined;
  #resolveTerminalDelivery: (() => void) | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: LocalBrowserPresentationHostOptions) {
    this.#actionController = options.actionController;
    this.#createCapability =
      options.createCapability ?? (() => randomBytes(SESSION_CAPABILITY_BYTES));
    const terminalDeliveryTimeoutMs =
      options.terminalDeliveryTimeoutMs ?? DEFAULT_TERMINAL_DELIVERY_TIMEOUT_MS;
    if (!Number.isSafeInteger(terminalDeliveryTimeoutMs) || terminalDeliveryTimeoutMs < 1) {
      throw new RangeError("terminal delivery timeout must be a positive safe integer");
    }
    this.#terminalDeliveryTimeoutMs = terminalDeliveryTimeoutMs;
  }

  async start(): Promise<LocalBrowserPresentationSession> {
    if (this.#startAttempted) {
      throw new Error("Cannot start Flow browser presentation: host is already started");
    }
    this.#startAttempted = true;
    let capability: Buffer;
    try {
      const created = this.#createCapability();
      if (created.byteLength !== SESSION_CAPABILITY_BYTES) {
        throw new Error("invalid capability length");
      }
      capability = Buffer.from(created);
    } catch {
      throw new Error("Cannot start Flow browser presentation: create session capability");
    }

    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.maxHeadersCount = 32;
    server.maxConnections = MAX_CONNECTIONS;
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.maxRequestsPerSocket = 16;

    try {
      await listen(server);
      const address = server.address() as AddressInfo | null;
      if (address === null || address.address !== LOOPBACK_ADDRESS || address.family !== "IPv4") {
        throw new Error("unexpected listener address");
      }
      const expectedHost = `${LOOPBACK_ADDRESS}:${address.port}`;
      const origin = `http://${expectedHost}`;
      this.#server = server;
      this.#origin = origin;
      this.#expectedHost = expectedHost;
      this.#capability = capability;
      return { url: `${origin}/#${capability.toString("hex")}` };
    } catch {
      capability.fill(0);
      await closeServer(server);
      throw new Error("Cannot start Flow browser presentation: bind loopback host");
    }
  }

  async render(input: FlowPresentationDocument): Promise<void> {
    let document: FlowPresentationDocument;
    try {
      document = parseFlowPresentationDocument(input);
      const latest = this.#latestDocument;
      if (
        latest !== undefined &&
        (latest.run.runId !== document.run.runId || latest.run.sequence >= document.run.sequence)
      ) {
        throw new Error("document is not newer");
      }
      this.#actionController.update(document);
    } catch {
      throw new Error("Cannot render Flow browser presentation: document is invalid");
    }
    const line = Buffer.from(`${encodeFlowPresentationDocument(document)}\n`, "utf8");
    this.#latestDocument = document;
    this.#latestLine = line;
    this.#consumedActionKeys.clear();
    if (isTerminal(document)) {
      this.#createTerminalDelivery();
    }
    const observer = this.#observer;
    if (observer !== undefined) {
      try {
        await writeWithDeadline(observer, line);
        if (isTerminal(document)) {
          this.#settleTerminalDelivery();
          this.#releaseObserver(observer);
          observer.end();
        }
      } catch {
        this.#releaseObserver(observer);
        observer.destroy();
        throw new Error("Cannot render Flow browser presentation: write document");
      }
    }
  }

  async close(): Promise<void> {
    this.#closePromise ??= this.#closeOwnedResources();
    await this.#closePromise;
  }

  async #closeOwnedResources(): Promise<void> {
    const terminalDelivery = this.#terminalDelivery;
    if (terminalDelivery !== undefined) {
      await waitForOperationOrTimeout(terminalDelivery, this.#terminalDeliveryTimeoutMs);
    }
    const server = this.#server;
    const capability = this.#capability;
    this.#server = undefined;
    this.#origin = undefined;
    this.#expectedHost = undefined;
    this.#capability = undefined;
    this.#latestDocument = undefined;
    this.#latestLine = undefined;
    this.#pendingActionKeys.clear();
    this.#consumedActionKeys.clear();
    this.#terminalDelivery = undefined;
    this.#resolveTerminalDelivery = undefined;
    const observer = this.#observer;
    this.#observer = undefined;
    capability?.fill(0);
    observer?.end();
    if (server !== undefined) {
      await closeServer(server);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers.host !== this.#expectedHost) {
        respond(response, 403, "Browser request is not permitted\n");
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        respond(response, 200, LOCAL_BROWSER_PRESENTATION_HTML, "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && request.url === "/app.css") {
        respond(response, 200, LOCAL_BROWSER_PRESENTATION_CSS, "text/css; charset=utf-8");
        return;
      }
      if (request.method === "GET" && request.url === "/app.js") {
        respond(
          response,
          200,
          LOCAL_BROWSER_PRESENTATION_JAVASCRIPT,
          "text/javascript; charset=utf-8",
        );
        return;
      }
      if (request.url !== "/api/documents" && request.url !== "/api/actions") {
        respond(response, 404, "Browser resource was not found\n");
        return;
      }
      const isDocumentRead = request.method === "GET" && request.url === "/api/documents";
      if (!this.#isSameOriginApiRequest(request, !isDocumentRead)) {
        respond(response, 403, "Browser request is not permitted\n");
        return;
      }
      if (!this.#isAuthorized(request.headers.authorization)) {
        respond(response, 401, "Browser session is not authorized\n");
        return;
      }
      if (request.method === "GET" && request.url === "/api/documents") {
        await this.#handleDocuments(response);
        return;
      }
      if (request.method === "POST" && request.url === "/api/actions") {
        await this.#handleAction(request, response);
        return;
      }
      respond(response, 405, "Browser request method is not permitted\n");
    } catch {
      if (!response.headersSent) {
        respond(response, 500, "Browser request failed\n");
      } else {
        response.destroy();
      }
    }
  }

  async #handleDocuments(response: ServerResponse): Promise<void> {
    if (this.#observer !== undefined) {
      respond(response, 409, "Browser observer is already connected\n");
      return;
    }
    this.#observer = response;
    response.once("close", () => this.#releaseObserver(response));
    response.once("error", () => this.#releaseObserver(response));
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": "application/x-ndjson; charset=utf-8",
    });
    response.flushHeaders();
    const latestLine = this.#latestLine;
    if (latestLine !== undefined) {
      await writeWithDeadline(response, latestLine);
      if (this.#latestDocument !== undefined && isTerminal(this.#latestDocument)) {
        this.#settleTerminalDelivery();
        this.#releaseObserver(response);
        response.end();
      }
    }
  }

  async #handleAction(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers["content-type"] !== "application/json") {
      respond(response, 415, "Browser action media type is not supported\n");
      return;
    }
    if (isDeclaredBodyTooLarge(request.headers["content-length"])) {
      respond(response, 413, "Browser action request is too large\n");
      return;
    }
    try {
      const parsed = parseBrowserPresentationActionRequest(await readBody(request));
      const actionKey = `${parsed.documentSequence}:${parsed.actionId}`;
      if (this.#pendingActionKeys.has(actionKey) || this.#consumedActionKeys.has(actionKey)) {
        throw new Error("action was already submitted");
      }
      this.#pendingActionKeys.add(actionKey);
      try {
        await this.#actionController.executeCurrent(parsed.documentSequence, parsed.actionId, {
          ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
        });
        if (this.#latestDocument?.run.sequence === parsed.documentSequence) {
          this.#consumedActionKeys.add(actionKey);
        }
      } finally {
        this.#pendingActionKeys.delete(actionKey);
      }
      respond(response, 204, "");
    } catch (error) {
      if (error instanceof BrowserActionBodyTooLargeError) {
        respond(response, 413, "Browser action request is too large\n");
        return;
      }
      respond(response, 409, "Browser action was rejected\n");
    }
  }

  #isAuthorized(header: string | undefined): boolean {
    const capability = this.#capability;
    if (capability === undefined || header === undefined || !header.startsWith("Bearer ")) {
      return false;
    }
    const token = header.slice("Bearer ".length);
    if (!SESSION_CAPABILITY_PATTERN.test(token)) {
      return false;
    }
    const observed = Buffer.from(token, "hex");
    return observed.byteLength === capability.byteLength && timingSafeEqual(observed, capability);
  }

  #isSameOriginApiRequest(request: IncomingMessage, requireOrigin: boolean): boolean {
    const origin = request.headers.origin;
    return (
      (requireOrigin ? origin === this.#origin : origin === undefined || origin === this.#origin) &&
      request.headers["sec-fetch-site"] === "same-origin" &&
      request.headers["sec-fetch-mode"] === "cors" &&
      request.headers["sec-fetch-dest"] === "empty"
    );
  }

  #releaseObserver(response: ServerResponse): void {
    if (this.#observer === response) {
      this.#observer = undefined;
    }
  }

  #createTerminalDelivery(): void {
    if (this.#terminalDelivery !== undefined) {
      return;
    }
    this.#terminalDelivery = new Promise<void>((resolve) => {
      this.#resolveTerminalDelivery = resolve;
    });
  }

  #settleTerminalDelivery(): void {
    this.#resolveTerminalDelivery?.();
    this.#resolveTerminalDelivery = undefined;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BROWSER_ACTION_BODY_BYTES) {
      throw new BrowserActionBodyTooLargeError();
    }
    if (bytes.byteLength > 0) {
      chunks.push(bytes);
    }
  }
  return Buffer.concat(chunks, total);
}

function isDeclaredBodyTooLarge(value: string | undefined): boolean {
  return value !== undefined && /^[0-9]+$/.test(value)
    ? BigInt(value) > BigInt(MAX_BROWSER_ACTION_BODY_BYTES)
    : false;
}

function respond(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

async function writeWithDeadline(response: ServerResponse, body: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error("response write timed out"));
    }, RESPONSE_WRITE_TIMEOUT_MS);
    timeout.unref();
    response.write(body, finish);
  });
}

function isTerminal(document: FlowPresentationDocument): boolean {
  return (
    document.run.status === "succeeded" ||
    document.run.status === "failed" ||
    document.run.status === "cancelled" ||
    document.run.status === "resource_exhausted"
  );
}

async function waitForOperationOrTimeout(
  operation: Promise<void>,
  milliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    timeout.unref();
    void operation.then(finish);
  });
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_ADDRESS);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
