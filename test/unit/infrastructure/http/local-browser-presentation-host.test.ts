import { request } from "node:http";
import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_BROWSER_ACTION_BODY_BYTES,
  MAX_BROWSER_ACTION_REASON_BYTES,
} from "../../../../src/domain/presentation/browser-presentation-protocol.js";
import type { FlowPresentationDocument } from "../../../../src/domain/presentation/flow-presentation.js";
import { FLOW_PRESENTATION_API_VERSION } from "../../../../src/domain/presentation/flow-presentation.js";
import { LocalBrowserPresentationHost } from "../../../../src/infrastructure/http/local-browser-presentation-host.js";

describe("local browser presentation host", () => {
  const hosts: LocalBrowserPresentationHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map(async (host) => await host.close()));
  });

  it.each([
    ["short", () => Buffer.alloc(31, 0x11)],
    ["long", () => Buffer.alloc(33, 0x11)],
    [
      "throwing",
      () => {
        throw new Error("PRIVATE_CAPABILITY_FAILURE");
      },
    ],
  ])("rejects %s capability generation before binding", async (_label, createCapability) => {
    const host = new LocalBrowserPresentationHost({
      actionController: new CaptureActionController(),
      createCapability,
    });
    hosts.push(host);

    const error = await host.start().catch((failure: unknown) => failure);
    expect(error).toEqual(
      new Error("Cannot start Flow browser presentation: create session capability"),
    );
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_CAPABILITY_FAILURE");
    await expect(host.close()).resolves.toBeUndefined();
    await expect(host.start()).rejects.toThrow(
      "Cannot start Flow browser presentation: host is already started",
    );
  });

  it("binds explicit loopback and keeps the capability out of fixed resources and errors", async () => {
    const capability = Buffer.alloc(32, 0x11);
    const controller = new CaptureActionController();
    const host = new LocalBrowserPresentationHost({
      actionController: controller,
      createCapability: () => capability,
    });
    hosts.push(host);

    const session = await host.start();
    const browserUrl = new URL(session.url);
    const expectedOrigin = browserUrl.origin;
    const token = capability.toString("hex");
    expect(browserUrl.hostname).toBe("127.0.0.1");
    expect(browserUrl.port).toMatch(/^[1-9][0-9]*$/);
    expect(browserUrl.pathname).toBe("/");
    expect(browserUrl.hash).toBe(`#${token}`);

    const page = await send(expectedOrigin, "/", { host: browserUrl.host });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.body).toContain("<title>Flow run</title>");
    expect(page.body).toContain('href="/app.css"');
    expect(page.body).toContain('src="/app.js"');
    expect(page.body).not.toContain(token);
    expect(page.body).not.toContain("<style");

    const style = await send(expectedOrigin, "/app.css", { host: browserUrl.host });
    expect(style.status).toBe(200);
    expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(style.body).toContain("--flow-canvas:");
    expect(style.body).toContain("@media (max-width: 640px)");
    expect(style.body).not.toContain(token);

    const script = await send(expectedOrigin, "/app.js", { host: browserUrl.host });
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toContain("textContent");
    expect(script.body).toContain("/api/documents");
    expect(script.body).toContain("/api/actions");
    expect(script.body).not.toMatch(
      /innerHTML|insertAdjacentHTML|eval\(|new Function|EventSource|WebSocket/,
    );
    expect(script.body).not.toMatch(/https?:\/\//);
    expect(script.body).not.toContain(token);

    const wrongHost = await send(expectedOrigin, "/", {
      host: `localhost:${browserUrl.port}`,
    });
    expect(wrongHost).toEqual(expect.objectContaining({ status: 403 }));
    expect(wrongHost.body).toBe("Browser request is not permitted\n");

    const unauthenticated = await send(expectedOrigin, "/api/documents", {
      host: browserUrl.host,
      origin: expectedOrigin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      authorization: "Bearer PRIVATE_WRONG_TOKEN",
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toBe("Browser session is not authorized\n");
    expect(unauthenticated.body).not.toContain("PRIVATE_WRONG_TOKEN");
    expect(unauthenticated.body).not.toContain(token);
    expect(controller.calls).toEqual([]);

    const excessiveHeaders = await send(expectedOrigin, "/", {
      host: browserUrl.host,
      additionalHeaders: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`x-private-${index}`, `PRIVATE_${index}`]),
      ),
    });
    expect(excessiveHeaders).toEqual(expect.objectContaining({ status: 431, body: "" }));
    expect(excessiveHeaders.body).not.toContain("PRIVATE");
  });

  it("admits one exact current action after host, origin, media, and capability checks", async () => {
    const capability = Buffer.alloc(32, 0x22);
    const controller = new CaptureActionController();
    const host = new LocalBrowserPresentationHost({
      actionController: controller,
      createCapability: () => capability,
    });
    hosts.push(host);
    const session = await host.start();
    const browserUrl = new URL(session.url);
    await host.render(documentWithAction());
    const body = Buffer.from(
      JSON.stringify({ documentSequence: 4, actionId: "approve:request-1" }),
      "utf8",
    );
    const baseHeaders = {
      host: browserUrl.host,
      origin: browserUrl.origin,
      authorization: `Bearer ${capability.toString("hex")}`,
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };

    const crossOrigin = await send(browserUrl.origin, "/api/actions", {
      ...baseHeaders,
      origin: "https://PRIVATE.invalid",
      body,
      method: "POST",
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body).not.toContain("PRIVATE");
    expect(controller.calls).toEqual([]);

    const crossSiteContext = await send(browserUrl.origin, "/api/actions", {
      ...baseHeaders,
      "sec-fetch-site": "cross-site",
      body,
      method: "POST",
    });
    expect(crossSiteContext.status).toBe(403);
    expect(controller.calls).toEqual([]);

    const accepted = await send(browserUrl.origin, "/api/actions", {
      ...baseHeaders,
      body,
      method: "POST",
    });
    expect(accepted).toEqual(expect.objectContaining({ status: 204, body: "" }));
    expect(controller.calls).toEqual([
      { documentSequence: 4, actionId: "approve:request-1", reason: undefined },
    ]);

    const replayed = await send(browserUrl.origin, "/api/actions", {
      ...baseHeaders,
      body,
      method: "POST",
    });
    expect(replayed.status).toBe(409);
    expect(replayed.body).toBe("Browser action was rejected\n");
    expect(controller.calls).toHaveLength(1);
  });

  it("streams complete documents to one observer and replays the latest document after reload", async () => {
    const capability = Buffer.alloc(32, 0x33);
    const controller = new CaptureActionController();
    const host = new LocalBrowserPresentationHost({
      actionController: controller,
      createCapability: () => capability,
    });
    hosts.push(host);
    const session = await host.start();
    const browserUrl = new URL(session.url);
    const headers = {
      host: browserUrl.host,
      origin: browserUrl.origin,
      authorization: `Bearer ${capability.toString("hex")}`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };

    const response = await fetch(`${browserUrl.origin}/api/documents`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const document = documentWithAction();
    await host.render(document);
    await expect(readDocument(reader)).resolves.toEqual(document);
    expect(controller.documents).toEqual([document]);

    const competing = await send(browserUrl.origin, "/api/documents", headers);
    expect(competing.status).toBe(409);
    expect(competing.body).toBe("Browser observer is already connected\n");

    await reader?.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    const reloaded = await fetch(`${browserUrl.origin}/api/documents`, { headers });
    const reloadedReader = reloaded.body?.getReader();
    expect(reloaded.status).toBe(200);
    await expect(readDocument(reloadedReader)).resolves.toEqual(document);
    await reloadedReader?.cancel();
  });

  it("keeps an undelivered terminal document available until one authenticated observer receives it", async () => {
    const capability = Buffer.alloc(32, 0x44);
    const host = new LocalBrowserPresentationHost({
      actionController: new CaptureActionController(),
      createCapability: () => capability,
    });
    hosts.push(host);
    const session = await host.start();
    const browserUrl = new URL(session.url);
    const terminalDocument: FlowPresentationDocument = {
      ...documentWithAction(),
      run: { ...documentWithAction().run, status: "cancelled" },
      actions: [],
    };
    await host.render(terminalDocument);

    let closeSettled = false;
    const closing = host.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    const response = await fetch(`${browserUrl.origin}/api/documents`, {
      signal: AbortSignal.timeout(1_000),
      headers: {
        host: browserUrl.host,
        origin: browserUrl.origin,
        authorization: `Bearer ${capability.toString("hex")}`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
    });
    expect(response.status).toBe(200);
    await expect(readDocument(response.body?.getReader())).resolves.toEqual(terminalDocument);
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("bounds terminal delivery when no browser observer connects", async () => {
    const host = new LocalBrowserPresentationHost({
      actionController: new CaptureActionController(),
      createCapability: () => Buffer.alloc(32, 0x55),
      terminalDeliveryTimeoutMs: 10,
    });
    hosts.push(host);
    await host.start();
    await host.render({
      ...documentWithAction(),
      run: { ...documentWithAction().run, status: "cancelled" },
      actions: [],
    });

    await expect(host.close()).resolves.toBeUndefined();
  });

  it("allows a retry after an uncertain action failure but consumes a successful action", async () => {
    const capability = Buffer.alloc(32, 0x56);
    const controller = new CaptureActionController([new Error("PRIVATE_UNCERTAIN")]);
    const host = new LocalBrowserPresentationHost({
      actionController: controller,
      createCapability: () => capability,
    });
    hosts.push(host);
    const session = await host.start();
    const browserUrl = new URL(session.url);
    await host.render(documentWithAction());
    const body = Buffer.from(
      JSON.stringify({ documentSequence: 4, actionId: "approve:request-1" }),
      "utf8",
    );
    const headers = {
      host: browserUrl.host,
      origin: browserUrl.origin,
      authorization: `Bearer ${capability.toString("hex")}`,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
      "content-length": String(body.byteLength),
      body,
      method: "POST" as const,
    };

    const uncertain = await send(browserUrl.origin, "/api/actions", headers);
    expect(uncertain).toEqual(
      expect.objectContaining({ status: 409, body: "Browser action was rejected\n" }),
    );
    expect(uncertain.body).not.toContain("PRIVATE_UNCERTAIN");

    const accepted = await send(browserUrl.origin, "/api/actions", headers);
    expect(accepted.status).toBe(204);
    const consumed = await send(browserUrl.origin, "/api/actions", headers);
    expect(consumed.status).toBe(409);
    expect(controller.calls).toHaveLength(2);
  });

  it("enforces the cumulative action body bound across transport chunks", async () => {
    const capability = Buffer.alloc(32, 0x57);
    const controller = new CaptureActionController();
    const host = new LocalBrowserPresentationHost({
      actionController: controller,
      createCapability: () => capability,
    });
    hosts.push(host);
    const session = await host.start();
    const browserUrl = new URL(session.url);
    await host.render(documentWithAction());
    const reason = "é".repeat(MAX_BROWSER_ACTION_REASON_BYTES / 2);
    const canonical = JSON.stringify({
      documentSequence: 4,
      actionId: "approve:request-1",
      reason,
    });
    const exact = Buffer.from(
      `${canonical}${" ".repeat(MAX_BROWSER_ACTION_BODY_BYTES - Buffer.byteLength(canonical))}`,
      "utf8",
    );
    expect(exact.byteLength).toBe(MAX_BROWSER_ACTION_BODY_BYTES);
    const headers = {
      host: browserUrl.host,
      origin: browserUrl.origin,
      authorization: `Bearer ${capability.toString("hex")}`,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };

    const accepted = await sendChunks(browserUrl.origin, "/api/actions", headers, [
      exact.subarray(0, 4_000),
      exact.subarray(4_000),
    ]);
    expect(accepted.status).toBe(204);
    expect(controller.calls).toHaveLength(1);

    await host.render({
      ...documentWithAction(),
      run: { ...documentWithAction().run, sequence: 5 },
      actions: [
        {
          kind: "approve",
          actionId: "approve:request-1",
          requestId: "request-1",
          label: "Approve request",
        },
      ],
    });
    const oversizedCanonical = canonical.replace('"documentSequence":4', '"documentSequence":5');
    const oversized = Buffer.from(
      `${oversizedCanonical}${" ".repeat(
        MAX_BROWSER_ACTION_BODY_BYTES - Buffer.byteLength(oversizedCanonical) + 1,
      )}`,
      "utf8",
    );
    expect(oversized.byteLength).toBe(MAX_BROWSER_ACTION_BODY_BYTES + 1);
    const rejected = await sendChunks(browserUrl.origin, "/api/actions", headers, [
      oversized.subarray(0, 4_096),
      oversized.subarray(4_096),
    ]);
    expect(rejected).toEqual(
      expect.objectContaining({ status: 413, body: "Browser action request is too large\n" }),
    );
    expect(controller.calls).toHaveLength(1);
  });

  it("rejects restart after session settlement without binding another listener", async () => {
    const host = new LocalBrowserPresentationHost({
      actionController: new CaptureActionController(),
      createCapability: () => Buffer.alloc(32, 0x66),
    });
    hosts.push(host);
    await host.start();
    await host.close();

    await expect(host.start()).rejects.toThrow(
      "Cannot start Flow browser presentation: host is already started",
    );
  });

  it("bounds simultaneous TCP connections", async () => {
    const host = new LocalBrowserPresentationHost({
      actionController: new CaptureActionController(),
      createCapability: () => Buffer.alloc(32, 0x67),
    });
    hosts.push(host);
    const session = await host.start();
    const browserUrl = new URL(session.url);
    const sockets: Socket[] = [];

    try {
      for (let index = 0; index < 16; index += 1) {
        const socket = connect({ host: browserUrl.hostname, port: Number(browserUrl.port) });
        sockets.push(socket);
        await waitForSocketConnect(socket);
      }
      expect(sockets.every((socket) => !socket.destroyed)).toBe(true);

      const overflow = connect({ host: browserUrl.hostname, port: Number(browserUrl.port) });
      sockets.push(overflow);
      await waitForSocketClose(overflow);
      expect(overflow.destroyed).toBe(true);
      expect(sockets.slice(0, 16).every((socket) => !socket.destroyed)).toBe(true);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
    }
  });
});

class CaptureActionController {
  readonly calls: unknown[] = [];
  readonly documents: FlowPresentationDocument[] = [];

  constructor(readonly failures: Error[] = []) {}

  update(document: FlowPresentationDocument): void {
    this.documents.push(document);
  }

  async executeCurrent(
    documentSequence: number,
    actionId: string,
    options: { readonly reason?: string } = {},
  ): Promise<void> {
    this.calls.push({ documentSequence, actionId, reason: options.reason });
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
  }
}

function documentWithAction(): FlowPresentationDocument {
  return {
    apiVersion: FLOW_PRESENTATION_API_VERSION,
    run: { runId: "run-1", workflowId: "workflow-1", status: "running", sequence: 4 },
    sections: [{ id: "overview", components: [{ kind: "divider" }] }],
    actions: [
      {
        kind: "approve",
        actionId: "approve:request-1",
        requestId: "request-1",
        label: "Approve request",
      },
    ],
    truncated: false,
  };
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly host: string;
  readonly origin?: string;
  readonly authorization?: string;
  readonly "content-type"?: string;
  readonly "content-length"?: string;
  readonly "sec-fetch-site"?: string;
  readonly "sec-fetch-mode"?: string;
  readonly "sec-fetch-dest"?: string;
  readonly body?: Buffer;
  readonly additionalHeaders?: Readonly<Record<string, string>>;
}

async function send(
  origin: string,
  path: string,
  options: RequestOptions,
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}> {
  return await new Promise((resolve, reject) => {
    const client = request(
      `${origin}${path}`,
      {
        method: options.method ?? "GET",
        headers: {
          host: options.host,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
          ...(options["content-type"] === undefined
            ? {}
            : { "content-type": options["content-type"] }),
          ...(options["content-length"] === undefined
            ? {}
            : { "content-length": options["content-length"] }),
          ...(options["sec-fetch-site"] === undefined
            ? {}
            : { "sec-fetch-site": options["sec-fetch-site"] }),
          ...(options["sec-fetch-mode"] === undefined
            ? {}
            : { "sec-fetch-mode": options["sec-fetch-mode"] }),
          ...(options["sec-fetch-dest"] === undefined
            ? {}
            : { "sec-fetch-dest": options["sec-fetch-dest"] }),
          ...options.additionalHeaders,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.once("error", reject);
    if (options.body !== undefined) {
      client.write(options.body);
    }
    client.end();
  });
}

async function sendChunks(
  origin: string,
  path: string,
  headers: Omit<RequestOptions, "additionalHeaders" | "body" | "content-length" | "method">,
  chunks: readonly Buffer[],
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}> {
  const bodyLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  return await new Promise((resolve, reject) => {
    const client = request(
      `${origin}${path}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(bodyLength),
        },
      },
      (response) => {
        const responseChunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(responseChunks).toString("utf8"),
          }),
        );
      },
    );
    client.once("error", reject);
    for (const chunk of chunks) {
      client.write(chunk);
    }
    client.end();
  });
}

async function readDocument(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<unknown> {
  if (reader === undefined) {
    throw new Error("document stream is unavailable");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      throw new Error("document stream ended before a document");
    }
    chunks.push(result.value);
    total += result.value.byteLength;
    const joined = Buffer.concat(chunks, total);
    const newline = joined.indexOf(0x0a);
    if (newline !== -1) {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(joined.subarray(0, newline)),
      );
    }
  }
}

async function waitForSocketConnect(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("overflow socket remained open"));
    }, 250);
    timeout.unref();
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", () => undefined);
  });
}
