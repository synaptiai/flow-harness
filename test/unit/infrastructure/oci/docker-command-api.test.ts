import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DockerUnixApiClient,
  type DockerUnixApiRequest,
  type DockerUnixApiTransport,
  NodeDockerUnixApiTransport,
  NodeDockerUnixCommandAttachTransport,
} from "../../../../src/infrastructure/oci/docker-unix-api-client.js";

describe("Docker command execution API", () => {
  it("attaches only to command output through the pinned multiplexed stream", async () => {
    const output = (async function* () {})();
    const release = vi.fn(async () => undefined);
    const attach = vi.fn(async () => ({ output, release }));
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      commandAttachTransport: { attach },
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(client.attachCommandContainer("a".repeat(64), signal)).resolves.toEqual({
      output,
      release,
    });

    expect(attach).toHaveBeenCalledWith({
      socketPath: "/var/run/docker.sock",
      path: `/v1.51/containers/${"a".repeat(64)}/attach?stream=1&stdin=0&stdout=1&stderr=1&logs=0`,
      maxFrameBytes: 1_048_581,
      signal,
    });
  });

  it("lets the bounded command signal own the long-poll wait deadline", async () => {
    let observed: DockerUnixApiRequest | undefined;
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async (request) => {
        observed = request;
        return {
          statusCode: 200,
          body: JSON.stringify({ StatusCode: 0, Error: null }),
        };
      }),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(client.waitContainer("a".repeat(64), signal)).resolves.toBe(0);

    expect(observed).toMatchObject({
      method: "POST",
      path: `/v1.51/containers/${"a".repeat(64)}/wait?condition=not-running`,
      requestTimeoutMs: null,
      signal,
    });
  });

  it("returns only a validated task exit status from Docker wait", async () => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 200,
        body: JSON.stringify({ StatusCode: 125, Error: null }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.waitContainer("a".repeat(64), AbortSignal.timeout(1_000))).resolves.toBe(
      125,
    );
  });

  it.each([
    [500, '{"message":"PRIVATE_WAIT_STATUS"}', "Docker wait returned status 500"],
    [200, "PRIVATE_INVALID_JSON", "Docker wait response is invalid"],
    [
      200,
      JSON.stringify({ StatusCode: 256, Error: null }),
      "Docker wait response has an invalid status code",
    ],
    [
      200,
      JSON.stringify({ StatusCode: 1, Error: { Message: "PRIVATE_WAIT_ERROR" } }),
      "Docker wait reported a container error",
    ],
    [
      200,
      JSON.stringify({ StatusCode: 1, Error: { Message: 7 } }),
      "Docker wait response has an invalid error",
    ],
  ] as const)(
    "closes a rejected Docker wait response with status %i",
    async (statusCode, body, publicMessage) => {
      const transport: DockerUnixApiTransport = {
        request: vi.fn(async () => ({ statusCode, body })),
      };
      const client = new DockerUnixApiClient({
        socketPath: "/var/run/docker.sock",
        apiVersion: "1.51",
        transport,
      });

      const error = await client
        .waitContainer("a".repeat(64), AbortSignal.timeout(1_000))
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(publicMessage);
      expect((error as Error).message).not.toContain("PRIVATE_");
    },
  );

  it("keeps a signal-owned wait alive beyond the short Docker query timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-wait-"));
    const socketPath = join(root, "docker.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        setTimeout(() => {
          const body = JSON.stringify({ StatusCode: 0, Error: null });
          socket.end(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
        }, 30);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(
        new NodeDockerUnixApiTransport({ requestTimeoutMs: 5 }).request({
          socketPath,
          method: "POST",
          path: "/v1.51/containers/test/wait?condition=not-running",
          maxResponseBytes: 1_024,
          requestTimeoutMs: null,
          signal: AbortSignal.timeout(250),
        }),
      ).resolves.toMatchObject({ statusCode: 200 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unbounded Docker request without a cancellation signal", () => {
    const transport = new NodeDockerUnixApiTransport({ requestTimeoutMs: 5 });

    expect(() =>
      transport.request({
        socketPath: "/var/run/docker.sock",
        method: "POST",
        path: "/v1.51/containers/test/wait?condition=not-running",
        maxResponseBytes: 1_024,
        requestTimeoutMs: null,
      }),
    ).toThrow("Docker API signal-owned request requires a cancellation signal");
  });

  it("decodes fragmented task stdout and stderr from the upgraded command attachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-command-attach-"));
    const socketPath = join(root, "docker.sock");
    const stdout = rawFrame(1, Buffer.from("TASK_STDOUT"));
    const stderr = rawFrame(2, Buffer.from("TASK_STDERR"));
    const stream = Buffer.concat([stdout, stderr]);
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
        );
        socket.write(stream.subarray(0, 11));
        socket.end(stream.subarray(11));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const attached = await new NodeDockerUnixCommandAttachTransport({
        requestTimeoutMs: 100,
      }).attach({
        socketPath,
        path: "/v1.51/containers/test/attach",
        maxFrameBytes: 1_024,
      });
      const chunks = [];
      for await (const chunk of attached.output) {
        chunks.push({ stream: chunk.stream, payload: chunk.payload.toString("utf8") });
      }

      expect(chunks).toEqual([
        { stream: "stdout", payload: "TASK_STDOUT" },
        { stream: "stderr", payload: "TASK_STDERR" },
      ]);
      await attached.release();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [invalidHeader(), 1_024, "Docker command output has an invalid multiplex header"],
    [frameHeader(1, 5), 4, "Docker command output frame exceeds 4 bytes"],
    [Buffer.from([1, 0, 0]), 1_024, "Docker command output ends with a partial multiplex frame"],
  ] as const)(
    "rejects malformed upgraded command output with %s",
    async (stream, maxFrameBytes, publicMessage) => {
      const error = await readRejectedCommandOutput(stream, maxFrameBytes);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(publicMessage);
    },
  );
});

function rawFrame(stream: 1 | 2, payload: Buffer): Buffer {
  return Buffer.concat([frameHeader(stream, payload.byteLength), payload]);
}

function frameHeader(stream: number, payloadLength: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payloadLength, 4);
  return header;
}

function invalidHeader(): Buffer {
  return frameHeader(3, 0);
}

async function readRejectedCommandOutput(stream: Buffer, maxFrameBytes: number): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "flow-command-invalid-attach-"));
  const socketPath = join(root, "docker.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      socket.end(stream);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const attached = await new NodeDockerUnixCommandAttachTransport({
      requestTimeoutMs: 100,
    }).attach({
      socketPath,
      path: "/v1.51/containers/test/attach",
      maxFrameBytes,
    });
    try {
      for await (const _chunk of attached.output) {
        // The malformed cases must not yield task output.
      }
      return undefined;
    } catch (error) {
      return error;
    } finally {
      await attached.release();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
