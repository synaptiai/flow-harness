#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const mode = process.argv[2] ?? "default";
let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) break;
    const match = /^Content-Length: ([0-9]+)$/.exec(buffer.subarray(0, boundary).toString("ascii"));
    if (match === null) process.exit(70);
    const length = Number(match[1]);
    if (buffer.length < boundary + 4 + length) break;
    const body = buffer.subarray(boundary + 4, boundary + 4 + length);
    buffer = buffer.subarray(boundary + 4 + length);
    const message = JSON.parse(body.toString("utf8"));
    void handle(message);
  }
});

async function handle(message) {
  if (message.method === "initialize") {
    if (mode === "stderr-overflow") {
      process.stderr.write(Buffer.alloc(65_537, 0x78));
    }
    respond(message.id, {
      capabilities: {
        diagnosticProvider: {},
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
        textDocumentSync: { openClose: true, change: 0 },
      },
    });
  } else if (message.method === "textDocument/hover") {
    if (mode === "hang-hover" || mode === "stderr-overflow") return;
    if (mode === "verify-boundary") {
      const readable = readFileSync("example.ts", "utf8") === "const value = 1;\n";
      let writable = false;
      try {
        writeFileSync("example.ts", "const value = 2;\n");
        writable = true;
      } catch {}
      const network = await canConnect(Number(process.argv[3]));
      if (!readable || writable || network) process.exit(71);
    }
    respond(message.id, {
      contents: { kind: "markdown", value: "`const value: number`" },
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 },
      },
    });
  } else if (message.method === "shutdown") {
    respond(message.id, null);
  } else if (message.method === "exit") {
    process.exit(0);
  }
}

async function canConnect(port) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      resolve(connected);
    };
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      finish(true);
      socket.destroy();
    });
    socket.once("error", () => finish(false));
    socket.once("timeout", () => {
      finish(false);
      socket.destroy();
    });
    socket.once("close", () => finish(false));
  });
}

function respond(id, result) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }));
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}
