import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DockerRawStreamDecoder,
  DockerUnixApiClient,
  type DockerUnixApiTransport,
  type DockerUnixAttachTransport,
  NodeDockerUnixApiTransport,
} from "../../../../src/infrastructure/oci/docker-unix-api-client.js";

describe("Docker Unix API client", () => {
  it("bounds a daemon request that accepts the socket and never responds", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-docker-api-"));
    const socketPath = join(root, "docker.sock");
    const server = createServer((socket) => {
      const fallback = setTimeout(() => socket.destroy(), 100);
      fallback.unref();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(
        new NodeDockerUnixApiTransport({ requestTimeoutMs: 20 }).request({
          socketPath,
          method: "GET",
          path: "/version",
          maxResponseBytes: 1_024,
        }),
      ).rejects.toThrow(/Docker API request exceeded 20ms/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a daemon response that resets after a partial body", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-docker-api-"));
    const socketPath = join(root, "docker.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r\nx");
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const request = new NodeDockerUnixApiTransport({ requestTimeoutMs: 100 }).request({
        socketPath,
        method: "GET",
        path: "/version",
        maxResponseBytes: 1_024,
      });
      await expect(
        Promise.race([
          request,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("partial-response test deadline expired")), 250),
          ),
        ]),
      ).rejects.toThrow(/Docker API response.*(?:aborted|closed|error)/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects response overflow after headers arrive", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-docker-api-"));
    const socketPath = join(root, "docker.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n12345678");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(
        new NodeDockerUnixApiTransport({ requestTimeoutMs: 100 }).request({
          socketPath,
          method: "GET",
          path: "/version",
          maxResponseBytes: 4,
        }),
      ).rejects.toThrow(/exceeds 4 bytes/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the local daemon ping endpoint", async () => {
    const transport = {
      request: vi.fn(async () => ({ statusCode: 200, body: "OK" })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.ping()).resolves.toBeUndefined();
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/_ping" }),
    );
  });

  it("reads bounded engine and image state from the local daemon", async () => {
    const imageId = `sha256:${"b".repeat(64)}`;
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async (request) => ({
        statusCode: 200,
        body: JSON.stringify({ path: request.path, Id: imageId }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.readVersion()).resolves.toContain("/v1.51/version");
    await expect(client.readInfo()).resolves.toContain("/v1.51/info");
    await expect(client.inspectImage(imageId)).resolves.toMatchObject({ Id: imageId });
    expect(vi.mocked(transport.request).mock.calls.map(([request]) => request.path)).toEqual([
      "/v1.51/version",
      "/v1.51/info",
      `/v1.51/images/${encodeURIComponent(imageId)}/json`,
    ]);
  });

  it("accepts the one fixed Prime global slot name", async () => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 201,
        body: JSON.stringify({ Id: "a".repeat(64) }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.createContainer("flow-prime-global-v1", {})).resolves.toBe("a".repeat(64));
  });

  it("uses one fixed socket and versioned API paths", async () => {
    const containerName = `flow-prime-${"c".repeat(32)}`;
    const requests: Record<string, unknown>[] = [];
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async (request) => {
        requests.push(request as unknown as Record<string, unknown>);
        if (request.path.includes("/containers/create")) {
          return { statusCode: 201, body: JSON.stringify({ Id: "a".repeat(64) }) };
        }
        if (request.method === "GET") {
          return { statusCode: 200, body: JSON.stringify({ Id: "a".repeat(64) }) };
        }
        return { statusCode: 204, body: "" };
      }),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(
      client.createContainer(containerName, { Image: `sha256:${"b".repeat(64)}` }),
    ).resolves.toBe("a".repeat(64));
    await client.inspectContainer("a".repeat(64));
    await client.startContainer("a".repeat(64));
    await client.stopContainer("a".repeat(64), 5);
    await client.removeContainer("a".repeat(64));

    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: `/v1.51/containers/create?name=${containerName}` },
      { method: "GET", path: `/v1.51/containers/${"a".repeat(64)}/json` },
      { method: "POST", path: `/v1.51/containers/${"a".repeat(64)}/start` },
      { method: "POST", path: `/v1.51/containers/${"a".repeat(64)}/stop?t=5` },
      { method: "DELETE", path: `/v1.51/containers/${"a".repeat(64)}?force=1&v=1` },
    ]);
    expect(requests.every(({ socketPath }) => socketPath === "/var/run/docker.sock")).toBe(true);
  });

  it("returns null only for an absent inspected object", async () => {
    const containerName = `flow-prime-${"c".repeat(32)}`;
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({ statusCode: 404, body: "missing" })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.inspectContainer(containerName)).resolves.toBeNull();
    await expect(client.startContainer(containerName)).rejects.toThrow(/Docker.*start.*404/i);
  });

  it("does not expose Docker response bodies in public errors", async () => {
    const privateMarker = "PRIVATE_DAEMON_PATH_/var/lib/docker/containers/secret";
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({ statusCode: 500, body: privateMarker })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    const error = await client.startContainer("a".repeat(64)).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Docker.*start.*500/i);
    expect((error as Error).message).not.toContain(privateMarker);
  });

  it("rejects malformed identities and oversized responses", async () => {
    const containerName = `flow-prime-${"c".repeat(32)}`;
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({ statusCode: 201, body: JSON.stringify({ Id: "short" }) })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
      maxResponseBytes: 64,
    });

    await expect(client.createContainer(containerName, {})).rejects.toThrow(/container ID/i);

    vi.mocked(transport.request).mockResolvedValueOnce({
      statusCode: 200,
      body: "x".repeat(65),
    });
    await expect(client.inspectContainer(containerName)).rejects.toThrow(/exceeds 64 bytes/i);
  });

  it("does not issue a request after cancellation", async () => {
    const containerName = `flow-prime-${"c".repeat(32)}`;
    const transport: DockerUnixApiTransport = { request: vi.fn() };
    const controller = new AbortController();
    controller.abort(new Error("operator stop"));
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.inspectContainer(containerName, controller.signal)).rejects.toThrow(
      /operator stop/i,
    );
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("attaches one private duplex stream through the versioned Unix API", async () => {
    const attached = {
      output: (async function* () {
        yield Buffer.from("output");
      })(),
      write: vi.fn(async () => undefined),
      closeInput: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const attachTransport: DockerUnixAttachTransport = {
      attach: vi.fn(async () => attached),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport: { request: vi.fn() },
      attachTransport,
    });

    await expect(client.attachContainer("a".repeat(64))).resolves.toBe(attached);
    expect(attachTransport.attach).toHaveBeenCalledWith({
      socketPath: "/var/run/docker.sock",
      path: `/v1.51/containers/${"a".repeat(64)}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0`,
      maxStderrBytes: 65_536,
      maxStdoutFrameBytes: 1_048_581,
    });
  });

  it("decodes fragmented Docker output and bounds standard error", () => {
    const decoder = new DockerRawStreamDecoder({ maxStderrBytes: 4 });
    const stdout = rawStreamFrame(1, Buffer.from("ok"));
    const stderr = rawStreamFrame(2, Buffer.from("warn"));
    const bytes = Buffer.concat([stdout, stderr]);

    expect(decoder.push(bytes.subarray(0, 5))).toEqual([]);
    expect(decoder.push(bytes.subarray(5))).toEqual([
      { stream: "stdout", payload: Buffer.from("ok") },
      { stream: "stderr", payload: Buffer.from("warn") },
    ]);
    expect(() => decoder.finish()).not.toThrow();

    expect(() => new DockerRawStreamDecoder({ maxStderrBytes: 3 }).push(stderr)).toThrow(
      /standard error.*3 bytes/i,
    );
    expect(() => {
      const partial = new DockerRawStreamDecoder({ maxStderrBytes: 4 });
      partial.push(stdout.subarray(0, 9));
      partial.finish();
    }).toThrow(/partial/i);
  });
});

function rawStreamFrame(stream: 1 | 2, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}
