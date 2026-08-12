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

  it.each([
    { body: "PRIVATE_INVALID_JSON", privateMarker: "PRIVATE_INVALID_JSON" },
    { body: JSON.stringify({}), privateMarker: "PRIVATE_EMPTY_OBJECT" },
    {
      body: JSON.stringify({ message: { value: "PRIVATE_NON_STRING" } }),
      privateMarker: "PRIVATE_NON_STRING",
    },
    {
      body: JSON.stringify({
        message: "PRIVATE_DEEP seccomp filter failed",
        nested: { too: { deeply: { private: "PRIVATE_DEEP" } } },
      }),
      privateMarker: "PRIVATE_DEEP",
    },
    {
      body: JSON.stringify({
        message: "PRIVATE_NODES seccomp filter failed",
        values: Array.from({ length: 32 }, (_, index) => index),
      }),
      privateMarker: "PRIVATE_NODES",
    },
    {
      body: JSON.stringify({ message: "PRIVATE_STRUCTURED_UNKNOWN" }),
      privateMarker: "PRIVATE_STRUCTURED_UNKNOWN",
      statusCode: 503,
    },
  ])("does not expose an unclassified Docker response body", async (testCase) => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: testCase.statusCode ?? 500,
        body: testCase.body,
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    const error = await client.startContainer("a".repeat(64)).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Docker start returned status ${testCase.statusCode ?? 500}`,
    );
    expect((error as Error).message).not.toContain(testCase.privateMarker);
  });

  it.each([204, 304])("accepts Docker start status %i", async (statusCode) => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({ statusCode, body: "" })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.startContainer("a".repeat(64))).resolves.toBeUndefined();
  });

  it.each([
    {
      privateMessage:
        "failed to create task: unable to apply cgroup configuration: failed to write PRIVATE_DEVICE to io.max",
      publicMessage: "Docker start failed while applying container block I/O controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_BLKIO blkio throttle failed",
      publicMessage: "Docker start failed while applying container block I/O controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_BLOCK_IO block io throttle failed",
      publicMessage: "Docker start failed while applying container block I/O controls",
    },
    {
      privateMessage: "failed to create task: failed to write PRIVATE_MEMORY to memory.swap.max",
      publicMessage: "Docker start failed while applying container memory controls",
    },
    {
      privateMessage: "failed to create task: failed to write PRIVATE_MEMORY to memory.max",
      publicMessage: "Docker start failed while applying container memory controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_MEMORY memory limit could not be applied",
      publicMessage: "Docker start failed while applying container memory controls",
    },
    {
      privateMessage: "failed to create task: failed to write PRIVATE_CPU to cpu.max",
      publicMessage: "Docker start failed while applying container CPU controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_CPU cpu quota could not be applied",
      publicMessage: "Docker start failed while applying container CPU controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_CPU cpu period could not be applied",
      publicMessage: "Docker start failed while applying container CPU controls",
    },
    {
      privateMessage: "failed to create task: failed to write PRIVATE_PIDS to pids.max",
      publicMessage: "Docker start failed while applying container PID controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_PIDS pids limit could not be applied",
      publicMessage: "Docker start failed while applying container PID controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_PIDS pid limit could not be applied",
      publicMessage: "Docker start failed while applying container PID controls",
    },
    {
      privateMessage: "failed to create task: failed to apply PRIVATE_RLIMIT rlimit",
      publicMessage: "Docker start failed while applying container process limits",
    },
    {
      privateMessage: "failed to create task: PRIVATE_RLIMIT resource limit could not be applied",
      publicMessage: "Docker start failed while applying container process limits",
    },
    {
      privateMessage: "failed to create task: PRIVATE_RLIMIT setrlimit failed",
      publicMessage: "Docker start failed while applying container process limits",
    },
    {
      privateMessage: "failed to create task: unable to apply PRIVATE_CGROUP cgroup configuration",
      publicMessage: "Docker start failed while applying container cgroup controls",
    },
    {
      privateMessage: "failed to create task: PRIVATE_SECCOMP seccomp filter could not be loaded",
      publicMessage: "Docker start failed while applying the container seccomp policy",
    },
    {
      privateMessage: "failed to create task: mount PRIVATE_TMPFS at /workspace failed",
      publicMessage: "Docker start failed while applying container filesystem isolation",
    },
    {
      privateMessage: 'failed to create task: exec: "PRIVATE_ENTRYPOINT": permission denied',
      publicMessage: "Docker start failed while executing the container entrypoint",
    },
    {
      privateMessage: "failed to create task: chdir to cwd (PRIVATE_CWD) failed",
      publicMessage: "Docker start failed while entering the container working directory",
    },
    {
      privateMessage: "failed to create task: unable to setup user: setgroups PRIVATE_GROUP failed",
      publicMessage: "Docker start failed while applying the container user identity",
    },
    {
      privateMessage: "failed to create task: unable to apply caps: PRIVATE_CAPABILITY failed",
      publicMessage: "Docker start failed while applying container capabilities",
    },
    {
      privateMessage: "failed to create task: prctl(SET_NO_NEW_PRIVS) PRIVATE_POLICY failed",
      publicMessage: "Docker start failed while applying no-new-privileges",
    },
    {
      privateMessage: "failed to create task: unable to apply apparmor profile PRIVATE_PROFILE",
      publicMessage: "Docker start failed while applying the container AppArmor policy",
    },
    {
      privateMessage: "failed to create task for container: PRIVATE_RUNTIME runc create failed",
      publicMessage: "Docker start failed while creating the container runtime task",
    },
  ])("classifies one private Docker start failure without disclosing it", async (testCase) => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 500,
        body: JSON.stringify({ message: testCase.privateMessage }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    const error = await client.startContainer("a".repeat(64)).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(testCase.publicMessage);
    expect((error as Error).message).not.toContain(testCase.privateMessage);
  });

  it.each([
    {
      privateMessage: "runc create failed: exec: PRIVATE_EXEC_COLON",
      privateMarker: "PRIVATE_EXEC_COLON",
      publicMessage: "Docker start failed while executing the container entrypoint",
    },
    {
      privateMessage:
        "runc create failed: exec /opt/flow/bin/flow-prime-supervisor: PRIVATE_EXEC_PERMISSION",
      privateMarker: "PRIVATE_EXEC_PERMISSION",
      publicMessage: "Docker start failed while executing the container entrypoint",
    },
    {
      privateMessage:
        "runc create failed: exec /opt/flow/bin/flow-prime-supervisor: PRIVATE_EXEC_ABSENT no such file or directory",
      privateMarker: "PRIVATE_EXEC_ABSENT",
      publicMessage: "Docker start failed while executing the container entrypoint",
    },
    {
      privateMessage: "PRIVATE_EXECUTABLE executable file not found",
      privateMarker: "PRIVATE_EXECUTABLE",
      publicMessage: "Docker start failed while executing the container entrypoint",
    },
    {
      privateMessage: "chdir to cwd (PRIVATE_CWD) failed: no such file or directory",
      privateMarker: "PRIVATE_CWD",
      publicMessage: "Docker start failed while entering the container working directory",
    },
    {
      privateMessage: "PRIVATE_CWD current working directory is invalid",
      privateMarker: "PRIVATE_CWD",
      publicMessage: "Docker start failed while entering the container working directory",
    },
    {
      privateMessage: "unable to setup user PRIVATE_USER",
      privateMarker: "PRIVATE_USER",
      publicMessage: "Docker start failed while applying the container user identity",
    },
    {
      privateMessage: "setuid PRIVATE_UID failed",
      privateMarker: "PRIVATE_UID",
      publicMessage: "Docker start failed while applying the container user identity",
    },
    {
      privateMessage: "setgid PRIVATE_GID failed",
      privateMarker: "PRIVATE_GID",
      publicMessage: "Docker start failed while applying the container user identity",
    },
    {
      privateMessage: "setgroups PRIVATE_GROUP failed",
      privateMarker: "PRIVATE_GROUP",
      publicMessage: "Docker start failed while applying the container user identity",
    },
    {
      privateMessage: "PRIVATE_CAPABILITY capability setup failed",
      privateMarker: "PRIVATE_CAPABILITY",
      publicMessage: "Docker start failed while applying container capabilities",
    },
    {
      privateMessage: "unable to apply caps PRIVATE_CAPS",
      privateMarker: "PRIVATE_CAPS",
      publicMessage: "Docker start failed while applying container capabilities",
    },
    {
      privateMessage: "unable to apply bounding set PRIVATE_BOUNDING",
      privateMarker: "PRIVATE_BOUNDING",
      publicMessage: "Docker start failed while applying container capabilities",
    },
    {
      privateMessage: "unable to set keep caps PRIVATE_KEEP",
      privateMarker: "PRIVATE_KEEP",
      publicMessage: "Docker start failed while applying container capabilities",
    },
    {
      privateMessage: "prctl(set_no_new_privs) PRIVATE_NNP",
      privateMarker: "PRIVATE_NNP",
      publicMessage: "Docker start failed while applying no-new-privileges",
    },
    {
      privateMessage: "apply no-new-privileges PRIVATE_NNP_HYPHEN",
      privateMarker: "PRIVATE_NNP_HYPHEN",
      publicMessage: "Docker start failed while applying no-new-privileges",
    },
    {
      privateMessage: "PRIVATE_PROCESS permission denied",
      privateMarker: "PRIVATE_PROCESS",
      publicMessage: "Docker start failed while applying the container process policy",
    },
  ])("binds one closed category to each process signal", async (testCase) => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 500,
        body: JSON.stringify({ message: testCase.privateMessage }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    const error = await client.startContainer("a".repeat(64)).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(testCase.publicMessage);
    expect((error as Error).message).not.toContain(testCase.privateMarker);
  });

  it("does not treat runc exec-fd setup as entrypoint execution", async () => {
    const privateMarker = "PRIVATE_EXEC_FD";
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 500,
        body: JSON.stringify({ message: `error closing exec fds: ${privateMarker}` }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    const error = await client.startContainer("a".repeat(64)).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Docker start returned status 500");
    expect((error as Error).message).not.toContain(privateMarker);
  });

  it.each([
    {
      privateMessage:
        "failed to create task: unable to write io.max cgroup configuration: permission denied",
      publicMessage: "Docker start failed while applying container block I/O controls",
    },
    {
      privateMessage:
        "failed to create task: unable to write memory.max cgroup configuration: permission denied",
      publicMessage: "Docker start failed while applying container memory controls",
    },
    {
      privateMessage:
        "failed to create task: unable to write cpu.max cgroup configuration: permission denied",
      publicMessage: "Docker start failed while applying container CPU controls",
    },
    {
      privateMessage:
        "failed to create task: unable to write pids.max cgroup configuration: permission denied",
      publicMessage: "Docker start failed while applying container PID controls",
    },
    {
      privateMessage:
        "failed to create task: unable to apply rlimit cgroup configuration: permission denied",
      publicMessage: "Docker start failed while applying container process limits",
    },
    {
      privateMessage: "failed to create task: cgroup configuration failed: permission denied",
      publicMessage: "Docker start failed while applying container cgroup controls",
    },
    {
      privateMessage:
        "failed to create task: seccomp filter could not be loaded: permission denied",
      publicMessage: "Docker start failed while applying the container seccomp policy",
    },
    {
      privateMessage: "failed to create task: mount tmpfs failed: permission denied",
      publicMessage: "Docker start failed while applying container filesystem isolation",
    },
    {
      privateMessage: 'failed to create task: exec: "PRIVATE_ENTRYPOINT": permission denied',
      publicMessage: "Docker start failed while executing the container entrypoint",
    },
    {
      privateMessage: "failed to create task: chdir to cwd (PRIVATE_CWD): permission denied",
      publicMessage: "Docker start failed while entering the container working directory",
    },
    {
      privateMessage: "failed to create task: unable to setup user: setgroups: permission denied",
      publicMessage: "Docker start failed while applying the container user identity",
    },
    {
      privateMessage: "failed to create task: unable to apply caps: permission denied",
      publicMessage: "Docker start failed while applying container capabilities",
    },
    {
      privateMessage: "failed to create task: prctl(SET_NO_NEW_PRIVS): permission denied",
      publicMessage: "Docker start failed while applying no-new-privileges",
    },
    {
      privateMessage: "failed to create task: unable to apply apparmor profile: permission denied",
      publicMessage: "Docker start failed while applying the container AppArmor policy",
    },
    {
      privateMessage: "failed to create task: PRIVATE_PROCESS permission denied",
      publicMessage: "Docker start failed while applying the container process policy",
    },
  ])("uses the most specific Docker start failure category", async (testCase) => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 500,
        body: JSON.stringify({ message: testCase.privateMessage }),
      })),
    };
    const client = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
      transport,
    });

    await expect(client.startContainer("a".repeat(64))).rejects.toThrow(testCase.publicMessage);
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
