import { describe, expect, it } from "vitest";

import { createLanguageServerSnapshot } from "../../../../src/domain/capability/language-server.js";
import {
  LspMessageDecoder,
  MAX_LSP_MESSAGE_BYTES,
  MAX_LSP_MESSAGES,
  MAX_LSP_SOURCE_BYTES,
  runStrictLspQuery,
  type StrictLspTransport,
} from "../../../../src/infrastructure/lsp/strict-lsp-client.js";

describe("strict LSP client", () => {
  it("decodes fragmented and coalesced strict JSON-RPC frames", () => {
    const decoder = new LspMessageDecoder();
    const first = frame({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    const second = frame({ jsonrpc: "2.0", id: 2, result: null });

    expect(decoder.push(first.subarray(0, 7))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(7), second]))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { capabilities: {} } },
      { jsonrpc: "2.0", id: 2, result: null },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it.each([
    Buffer.from("Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}"),
    Buffer.from("Content-Type: application/json\r\n\r\n{}"),
    Buffer.from("Content-Length: 1\n\n{}"),
  ])("rejects an invalid frame with a fixed private-safe error", (input) => {
    const decoder = new LspMessageDecoder();
    expect(() => decoder.push(input)).toThrowError(
      expect.objectContaining({
        name: "StrictLspClientError",
        code: "semantic_protocol_failed",
        message: "semantic language-service protocol failed",
      }),
    );
  });

  it("accepts the exact response-message bound and rejects message-count plus one", () => {
    const decoder = new LspMessageDecoder();
    const exactPayload = jsonObjectWithBytes(MAX_LSP_MESSAGE_BYTES);

    expect(decoder.push(frameBytes(exactPayload))).toHaveLength(1);
    const messages = new LspMessageDecoder();
    for (let index = 0; index < MAX_LSP_MESSAGES; index += 1) {
      expect(messages.push(frame({ index }))).toHaveLength(1);
    }
    expect(() => messages.push(frame({ plusOne: true }))).toThrowError(
      expect.objectContaining({ code: "semantic_response_limit_exceeded" }),
    );
    expect(() =>
      new LspMessageDecoder().push(
        Buffer.from(`Content-Length: ${MAX_LSP_MESSAGE_BYTES + 1}\r\n\r\n`),
      ),
    ).toThrowError(expect.objectContaining({ code: "semantic_response_limit_exceeded" }));
  });

  it("binds exact strict-JSON depth and node limits", () => {
    const exactDepth = new LspMessageDecoder();
    expect(exactDepth.push(frameBytes(nestedJson(30)))).toHaveLength(1);
    expect(() => new LspMessageDecoder().push(frameBytes(nestedJson(31)))).toThrowError(
      expect.objectContaining({ code: "semantic_response_limit_exceeded" }),
    );

    const exactNodes = Buffer.from(`{"values":[${"0,".repeat(49_997)}0]}`);
    const plusOneNode = Buffer.from(`{"values":[${"0,".repeat(49_998)}0]}`);
    expect(new LspMessageDecoder().push(frameBytes(exactNodes))).toHaveLength(1);
    expect(() => new LspMessageDecoder().push(frameBytes(plusOneNode))).toThrowError(
      expect.objectContaining({ code: "semantic_response_limit_exceeded" }),
    );
  });

  it("accepts an exact-limit source and rejects source bytes plus one before transport", async () => {
    const exactTransport = new ScriptedTransport({
      contents: { kind: "plaintext", value: "bounded" },
    });
    const request = {
      operation: "hover" as const,
      path: "src/example.ts",
      position: { line: 0, character: 0 },
    };

    await expect(
      runStrictLspQuery({
        transport: exactTransport,
        languageServer: languageServer(),
        projectRoot: "/workspace",
        projectPaths: ["src/example.ts"],
        source: { path: "src/example.ts", content: Buffer.alloc(MAX_LSP_SOURCE_BYTES, 0x20) },
        request,
      }),
    ).resolves.toMatchObject({ operation: "hover" });

    const plusOneTransport = new ScriptedTransport(null);
    await expect(
      runStrictLspQuery({
        transport: plusOneTransport,
        languageServer: languageServer(),
        projectRoot: "/workspace",
        projectPaths: ["src/example.ts"],
        source: {
          path: "src/example.ts",
          content: Buffer.alloc(MAX_LSP_SOURCE_BYTES + 1, 0x20),
        },
        request,
      }),
    ).rejects.toMatchObject({ code: "semantic_request_invalid" });
    expect(plusOneTransport.methods).toEqual([]);
  });

  it.each([
    {
      operation: "diagnostics" as const,
      response: {
        kind: "full",
        items: [
          {
            range: lspRange(2, 0, 2, 4),
            severity: 1,
            code: 1001,
            message: "Invalid declaration",
          },
        ],
      },
      expected: {
        operation: "diagnostics",
        diagnostics: [
          {
            path: "src/example.ts",
            range: lspRange(2, 0, 2, 4),
            severity: "error",
            code: "1001",
            message: "Invalid declaration",
          },
        ],
      },
    },
    {
      operation: "definition" as const,
      response: [
        {
          uri: "file:///workspace/src/definition.ts",
          range: lspRange(4, 1, 4, 8),
        },
      ],
      expected: {
        operation: "definition",
        locations: [{ path: "src/definition.ts", range: lspRange(4, 1, 4, 8) }],
      },
    },
    {
      operation: "references" as const,
      response: [{ uri: "file:///workspace/src/example.ts", range: lspRange(8, 0, 8, 5) }],
      expected: {
        operation: "references",
        locations: [{ path: "src/example.ts", range: lspRange(8, 0, 8, 5) }],
      },
    },
    {
      operation: "hover" as const,
      response: {
        contents: { kind: "markdown", value: "`const value: string`" },
        range: lspRange(1, 6, 1, 11),
      },
      expected: {
        operation: "hover",
        hover: {
          path: "src/example.ts",
          range: lspRange(1, 6, 1, 11),
          format: "markdown",
          value: "`const value: string`",
        },
      },
    },
  ])(
    "runs and normalizes one bounded $operation session",
    async ({ operation, response, expected }) => {
      const transport = new ScriptedTransport(response);

      const result = await runStrictLspQuery({
        transport,
        languageServer: languageServer(),
        projectRoot: "/workspace",
        projectPaths: ["src/definition.ts", "src/example.ts"],
        source: {
          path: "src/example.ts",
          content: Buffer.from("export const value = unknownValue;\n"),
        },
        request:
          operation === "diagnostics"
            ? { operation, path: "src/example.ts" }
            : { operation, path: "src/example.ts", position: { line: 1, character: 7 } },
      });

      expect(result).toEqual(expected);
      expect(transport.methods).toEqual([
        "initialize",
        "initialized",
        "textDocument/didOpen",
        operation === "diagnostics"
          ? "textDocument/diagnostic"
          : operation === "definition"
            ? "textDocument/definition"
            : operation === "references"
              ? "textDocument/references"
              : "textDocument/hover",
        "shutdown",
        "exit",
      ]);
    },
  );

  it("rejects a foreign response URI without exposing it", async () => {
    const privateUri = "file:///private/SECRET/definition.ts";
    const transport = new ScriptedTransport([{ uri: privateUri, range: lspRange(0, 0, 0, 1) }]);

    const operation = runStrictLspQuery({
      transport,
      languageServer: languageServer(),
      projectRoot: "/workspace",
      projectPaths: ["src/example.ts"],
      source: { path: "src/example.ts", content: Buffer.from("const value = 1;\n") },
      request: {
        operation: "definition",
        path: "src/example.ts",
        position: { line: 0, character: 6 },
      },
    });

    await expect(operation).rejects.toMatchObject({
      name: "StrictLspClientError",
      code: "semantic_protocol_failed",
      message: "semantic language-service protocol failed",
    });
    await expect(operation).rejects.not.toHaveProperty("cause");
    await expect(operation).rejects.not.toThrow(privateUri);
  });
});

class ScriptedTransport implements StrictLspTransport {
  readonly methods: string[] = [];
  readonly #response: unknown;
  readonly #chunks: Buffer[] = [];

  constructor(response: unknown) {
    this.#response = response;
  }

  async write(bytes: Uint8Array): Promise<void> {
    const message = JSON.parse(body(Buffer.from(bytes)).toString("utf8")) as {
      id?: number;
      method?: string;
    };
    if (message.method !== undefined) {
      this.methods.push(message.method);
    }
    if (message.method === "initialize") {
      this.#queue({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: {
            diagnosticProvider: {},
            definitionProvider: true,
            referencesProvider: true,
            hoverProvider: true,
            textDocumentSync: { openClose: true, change: 0 },
          },
        },
      });
    } else if (message.method?.startsWith("textDocument/") && message.id !== undefined) {
      this.#queue({ jsonrpc: "2.0", id: message.id, result: this.#response });
    } else if (message.method === "shutdown") {
      this.#queue({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  async read(): Promise<Uint8Array | null> {
    return this.#chunks.shift() ?? null;
  }

  #queue(message: unknown): void {
    const encoded = frame(message);
    this.#chunks.push(encoded.subarray(0, 5), encoded.subarray(5));
  }
}

function languageServer() {
  const manifest = Buffer.from(
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "LanguageServer",
      metadata: { name: "typescript" },
      spec: {
        protocol: "lsp-3.18",
        executable: "/opt/flow/bin/typescript-language-server",
        executableSha256: "a".repeat(64),
        args: ["--stdio"],
        languages: [{ id: "typescript", suffixes: [".ts", ".tsx"] }],
        containmentProfile: "default",
        requestTimeoutMs: 5_000,
      },
    }),
  );
  return createLanguageServerSnapshot({
    provenance: ".flow/language-servers/typescript.json",
    manifest,
    executable: {
      path: "/opt/flow/bin/typescript-language-server",
      sha256: "a".repeat(64),
      bytes: 123,
      device: "1",
      inode: "2",
    },
  });
}

function frame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  return frameBytes(payload);
}

function frameBytes(payload: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

function jsonObjectWithBytes(targetBytes: number): Buffer {
  const empty = Buffer.from(JSON.stringify({ value: "" }));
  const payload = Buffer.from(
    JSON.stringify({ value: "x".repeat(targetBytes - empty.byteLength) }),
  );
  if (payload.byteLength !== targetBytes) throw new Error("cannot construct exact JSON boundary");
  return payload;
}

function nestedJson(arrayDepth: number): Buffer {
  return Buffer.from(`{"value":${"[".repeat(arrayDepth)}0${"]".repeat(arrayDepth)}}`);
}

function body(message: Buffer): Buffer {
  const boundary = message.indexOf("\r\n\r\n");
  return message.subarray(boundary + 4);
}

function lspRange(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
