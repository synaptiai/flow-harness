import { describe, expect, it, vi } from "vitest";

import {
  DockerRawStreamDecoder,
  DockerUnixApiClient,
  type DockerUnixApiTransport,
  type DockerUnixAttachTransport,
} from "../../../../src/infrastructure/oci/docker-unix-api-client.js";

describe("Docker Unix API client", () => {
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
    await expect(client.startContainer(containerName)).rejects.toThrow(/Docker.*404.*missing/i);
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
