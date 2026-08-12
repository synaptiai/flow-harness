import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duplex, PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  DockerRawStreamDecoder,
  DockerUnixApiClient,
  type DockerUnixApiTransport,
  type DockerUnixAttachTransport,
  NodeDockerAttachedTransport,
  NodeDockerUnixApiTransport,
  NodeDockerUnixAttachTransport,
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
      privateMessage:
        "failed to create task: OCI runtime create failed: can't mask path /PRIVATE_MASK: operation not permitted",
      privateMarker: "PRIVATE_MASK",
      publicMessage: "Docker start failed while applying container filesystem isolation",
    },
    {
      privateMessage:
        'failed to create task: OCI runtime create failed: can\'t make "/PRIVATE_READONLY" read-only: operation not permitted',
      privateMarker: "PRIVATE_READONLY",
      publicMessage: "Docker start failed while applying container filesystem isolation",
    },
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
    {
      privateMessage:
        "OCI runtime create failed: error during container init: error closing exec fds: PRIVATE_EXEC_FDS",
      privateMarker: "PRIVATE_EXEC_FDS",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
    },
    {
      privateMessage: "OCI runtime create failed: unable to setup exec fifo: PRIVATE_EXEC_FIFO",
      privateMarker: "PRIVATE_EXEC_FIFO",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
    },
    {
      privateMessage: "OCI runtime create failed: close log pipe: PRIVATE_LOG_PIPE",
      privateMarker: "PRIVATE_LOG_PIPE",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
    },
    {
      privateMessage: "OCI runtime create failed: error getting pipe fds: PRIVATE_PIPE_FDS",
      privateMarker: "PRIVATE_PIPE_FDS",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
    },
    {
      privateMessage:
        "failed to create shim task: failed to create init process I/O: PRIVATE_INIT_IO",
      privateMarker: "PRIVATE_INIT_IO",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
    },
    {
      privateMessage: "OCI runtime create failed: unable to create init pipe: PRIVATE_INIT_PIPE",
      privateMarker: "PRIVATE_INIT_PIPE",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage: "OCI runtime create failed: unable to create sync pipe: PRIVATE_SYNC_PIPE",
      privateMarker: "PRIVATE_SYNC_PIPE",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage:
        "OCI runtime create failed: can't copy bootstrap data to pipe: PRIVATE_BOOTSTRAP_PIPE",
      privateMarker: "PRIVATE_BOOTSTRAP_PIPE",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage: "OCI runtime create failed: sync ready: PRIVATE_SYNC_READY",
      privateMarker: "PRIVATE_SYNC_READY",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage:
        "OCI runtime create failed: can't get final child's PID from pipe: PRIVATE_CHILD_PID",
      privateMarker: "PRIVATE_CHILD_PID",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage:
        "OCI runtime create failed: error reading pid from init pipe: PRIVATE_PID_PIPE",
      privateMarker: "PRIVATE_PID_PIPE",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage: "OCI runtime create failed: container process is already dead PRIVATE_DEAD",
      privateMarker: "PRIVATE_DEAD",
      publicMessage: "Docker start failed because the container runtime process ended early",
    },
    {
      privateMessage: "OCI runtime create failed: unable to store init state: PRIVATE_STATE",
      privateMarker: "PRIVATE_STATE",
      publicMessage: "Docker start failed while recording container runtime state",
    },
    {
      privateMessage:
        "OCI runtime create failed: unable to retrieve OCI runtime error: PRIVATE_DIAGNOSTIC",
      privateMarker: "PRIVATE_DIAGNOSTIC",
      publicMessage: "Docker start failed before the container runtime returned a diagnostic",
    },
    {
      privateMessage: "OCI runtime create failed: exit status PRIVATE_EXIT",
      privateMarker: "PRIVATE_EXIT",
      publicMessage: "Docker start failed before the container runtime returned a diagnostic",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: fork/exec /PRIVATE_RUNC: no such file or directory",
      privateMarker: "PRIVATE_RUNC",
      publicMessage: "Docker start failed while launching the selected container runtime",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: fork/exec /PRIVATE_RUNC: permission denied",
      privateMarker: "PRIVATE_RUNC",
      publicMessage: "Docker start failed while launching the selected container runtime",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: fork/exec /PRIVATE_RUNC: exec format error",
      privateMarker: "PRIVATE_RUNC",
      publicMessage: "Docker start failed while launching the selected container runtime",
    },
    {
      privateMessage:
        "failed to create task: exec failed for PRIVATE_RUN because no such file or directory exists",
      privateMarker: "PRIVATE_RUN",
      publicMessage: "Docker start failed while resolving a runtime execution object",
    },
    {
      privateMessage: "failed to create task: exec failed for PRIVATE_RUN",
      privateMarker: "PRIVATE_RUN",
      publicMessage: "Docker start failed during runtime execution setup",
    },
    {
      privateMessage: "failed to create task: PRIVATE_OBJECT no such file or directory",
      privateMarker: "PRIVATE_OBJECT",
      publicMessage: "Docker start failed because a runtime object was missing",
    },
    {
      privateMessage: "failed to create task: failed to open stdin fifo PRIVATE_STDIN",
      privateMarker: "PRIVATE_STDIN",
      publicMessage: "Docker start failed while opening container runtime streams",
    },
    {
      privateMessage: "failed to create task: failed to open stdout fifo PRIVATE_STDOUT",
      privateMarker: "PRIVATE_STDOUT",
      publicMessage: "Docker start failed while opening container runtime streams",
    },
    {
      privateMessage: "failed to create task: failed to open stderr fifo PRIVATE_STDERR",
      privateMarker: "PRIVATE_STDERR",
      publicMessage: "Docker start failed while opening container runtime streams",
    },
    {
      privateMessage: "failed to create task: failed to start io pipe copy PRIVATE_COPY",
      privateMarker: "PRIVATE_COPY",
      publicMessage: "Docker start failed while copying container runtime streams",
    },
    {
      privateMessage: "failed to create task: unable to copy pipes PRIVATE_PIPES",
      privateMarker: "PRIVATE_PIPES",
      publicMessage: "Docker start failed while copying container runtime streams",
    },
    {
      privateMessage:
        "failed to create task: failed to retrieve OCI runtime container pid PRIVATE_PID",
      privateMarker: "PRIVATE_PID",
      publicMessage: "Docker start failed while reading the container runtime process identity",
    },
    {
      privateMessage:
        'failed to create task: runtime "io.containerd.runc.v2" binary not installed "PRIVATE_SHIM"',
      privateMarker: "PRIVATE_SHIM",
      publicMessage: "Docker start failed while launching the container runtime shim",
    },
    {
      privateMessage:
        "OCI runtime create failed: unable to mark non-stdio fds as cloexec: PRIVATE_DESCRIPTOR_CANARY",
      privateMarker: "PRIVATE_DESCRIPTOR_CANARY",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
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
    expect((error as Error).message).toBe(
      "Docker start failed while setting up container runtime file descriptors",
    );
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
      privateMessage:
        "failed to create task: OCI runtime create failed: can't mask path /PRIVATE_MASK: permission denied",
      publicMessage: "Docker start failed while applying container filesystem isolation",
    },
    {
      privateMessage:
        'failed to create task: OCI runtime create failed: can\'t make "/PRIVATE_READONLY" read-only: permission denied',
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
    {
      privateMessage:
        "OCI runtime create failed: error closing exec fds: PRIVATE_DESCRIPTOR permission denied",
      publicMessage: "Docker start failed while setting up container runtime file descriptors",
    },
    {
      privateMessage:
        "OCI runtime create failed: unable to create init pipe: PRIVATE_SYNC permission denied",
      publicMessage: "Docker start failed while synchronizing the container runtime process",
    },
    {
      privateMessage:
        "OCI runtime create failed: container process is already dead PRIVATE_DEAD permission denied",
      publicMessage: "Docker start failed because the container runtime process ended early",
    },
    {
      privateMessage:
        "OCI runtime create failed: unable to store init state: PRIVATE_STATE permission denied",
      publicMessage: "Docker start failed while recording container runtime state",
    },
    {
      privateMessage:
        "OCI runtime create failed: unable to retrieve OCI runtime error: PRIVATE_DIAGNOSTIC permission denied",
      publicMessage: "Docker start failed before the container runtime returned a diagnostic",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: fork/exec /PRIVATE_RUNC: permission denied",
      publicMessage: "Docker start failed while launching the selected container runtime",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: fork/exec /opt/seccomp/runc: permission denied",
      publicMessage: "Docker start failed while launching the selected container runtime",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: fork/exec /opt/mount/runc: no such file or directory",
      publicMessage: "Docker start failed while launching the selected container runtime",
    },
    {
      privateMessage:
        "failed to create task: failed to open stdin fifo /PRIVATE_STDIN: no such file or directory",
      publicMessage: "Docker start failed while opening container runtime streams",
    },
    {
      privateMessage:
        "failed to create task: failed to open stdout fifo /PRIVATE_STDOUT: permission denied",
      publicMessage: "Docker start failed while opening container runtime streams",
    },
    {
      privateMessage:
        "failed to create task: failed to start io pipe copy: unable to copy pipes: PRIVATE_COPY: permission denied",
      publicMessage: "Docker start failed while copying container runtime streams",
    },
    {
      privateMessage:
        "failed to create task: failed to start io pipe copy: unable to copy pipes: PRIVATE_COPY: no such file or directory",
      publicMessage: "Docker start failed while copying container runtime streams",
    },
    {
      privateMessage:
        "failed to create task: failed to retrieve OCI runtime container pid /PRIVATE_PID: no such file or directory",
      publicMessage: "Docker start failed while reading the container runtime process identity",
    },
    {
      privateMessage:
        "failed to create task: failed to retrieve OCI runtime container pid /PRIVATE_PID: permission denied",
      publicMessage: "Docker start failed while reading the container runtime process identity",
    },
    {
      privateMessage:
        "failed to create task: OCI runtime create failed: exec /opt/flow/bin/flow-prime-supervisor: permission denied",
      publicMessage: "Docker start failed while executing the container entrypoint",
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

  it.each([
    { privateMessage: "PRIVATE_CREATE_TASK create task" },
    { privateMessage: "PRIVATE_SHIM_TASK create shim task" },
    { privateMessage: "PRIVATE_OCI_CREATE OCI runtime create" },
    { privateMessage: "PRIVATE_RUNC_CREATE runc create" },
  ])("binds each residual runtime-task signal", async ({ privateMessage }) => {
    const transport: DockerUnixApiTransport = {
      request: vi.fn(async () => ({
        statusCode: 503,
        body: JSON.stringify({ message: privateMessage }),
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
      "Docker start failed while creating the container runtime task",
    );
    expect((error as Error).message).not.toContain(privateMessage);
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

  it("writes through the upgraded Docker socket and rejects only a real write error", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-prime-docker-attach-"));
    const socketPath = join(root, "docker.sock");
    let serverSocket: Socket | undefined;
    let resolvePayload: ((value: Buffer) => void) | undefined;
    const payload = new Promise<Buffer>((resolve) => {
      resolvePayload = resolve;
    });
    const server = createServer((socket) => {
      serverSocket = socket;
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
        );
        socket.once("data", (bytes) => resolvePayload?.(Buffer.from(bytes)));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const attached = await new NodeDockerUnixAttachTransport({
        requestTimeoutMs: 100,
      }).attach({
        socketPath,
        path: "/v1.51/containers/test/attach",
        maxStderrBytes: 1_024,
        maxStdoutFrameBytes: 1_024,
      });

      await expect(attached.write(Buffer.from("challenge"))).resolves.toBeUndefined();
      await expect(
        Promise.race([
          payload,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("attached-write test deadline expired")), 250),
          ),
        ]),
      ).resolves.toEqual(Buffer.from("challenge"));

      serverSocket?.destroy();
      await expect(attached.output[Symbol.asyncIterator]().next()).rejects.toThrow(
        "Prime container ended before readiness",
      );
      await expect(attached.write(Buffer.from("late"))).rejects.toBeInstanceOf(Error);
      await attached.release();
    } finally {
      serverSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { callbackValue: null, expected: "resolve" },
    { callbackValue: undefined, expected: "resolve" },
    { callbackValue: new Error("fixed write failure"), expected: "reject" },
  ] as const)(
    "treats an attached-write callback value as $expected",
    async ({ callbackValue, expected }) => {
      const socket = {
        write: vi.fn(
          (_bytes: Buffer, callback: (error: Error | null | undefined) => void): boolean => {
            callback(callbackValue);
            return true;
          },
        ),
      } as unknown as Duplex;
      const attached = new NodeDockerAttachedTransport(socket, Buffer.alloc(0), {
        maxStderrBytes: 1_024,
        maxStdoutFrameBytes: 1_024,
      });
      const write = attached.write(Buffer.from("challenge"));

      if (expected === "reject") {
        await expect(write).rejects.toBe(callbackValue);
      } else {
        await expect(write).resolves.toBeUndefined();
      }
    },
  );

  it.each([
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective process controls contradict the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating process controls",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective resource limits contradict the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating resource limits",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective filesystem controls contradict the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating filesystem controls",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective network controls contradict the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating network controls",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective system files contradict the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: read Docker system file mount information: PRIVATE_MOUNT\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: parse Docker system file mount information: PRIVATE_MOUNT\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Docker system files are not three read-only mounts\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: open Docker system file /PRIVATE_FILE: failure\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: inspect Docker system file /PRIVATE_FILE: failure\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: read Docker system file /PRIVATE_FILE: failure\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Docker hostname contradicts the admitted content\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Docker hosts file contradicts the admitted content\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Docker resolver file contradicts the admitted content\n",
      publicMessage: "Prime container readiness failed while validating system files",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective stream controls contradict the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating attached streams",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective log policy contradicts the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating the log policy",
    },
    {
      privateDiagnostic:
        "measure Prime container readiness: Prime effective health policy contradicts the fixed runtime policy\n",
      publicMessage: "Prime container readiness failed while validating the health policy",
    },
    {
      privateDiagnostic: "set Prime supervisor core limit: PRIVATE_HARDENING\n",
      publicMessage: "Prime container failed while applying supervisor hardening",
    },
    {
      privateDiagnostic: "create Prime private path /PRIVATE_RUNTIME: permission denied\n",
      publicMessage: "Prime container failed while preparing its private runtime",
    },
    {
      privateDiagnostic: "read Prime container frame header: PRIVATE_INPUT\n",
      publicMessage: "Prime container failed while reading attached protocol input",
    },
  ])(
    "maps private attached stderr to $publicMessage",
    async ({ privateDiagnostic, publicMessage }) => {
      const socket = new PassThrough();
      socket.end();
      const attached = new NodeDockerAttachedTransport(
        socket,
        rawStreamFrame(2, Buffer.from(privateDiagnostic)),
        { maxStderrBytes: 1_024, maxStdoutFrameBytes: 1_024 },
      );

      const error = await attached.output[Symbol.asyncIterator]()
        .next()
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(publicMessage);
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).not.toContain("PRIVATE");
    },
  );

  it.each([
    [
      "Prime supervisor must start as the fixed container supervisor user",
      "Prime container failed while applying supervisor hardening",
    ],
    [
      "set Prime supervisor core limit: PRIVATE_SIGNAL",
      "Prime container failed while applying supervisor hardening",
    ],
    [
      "disable Prime supervisor dumpable state: PRIVATE_SIGNAL",
      "Prime container failed while applying supervisor hardening",
    ],
    [
      "measure Prime container readiness: read Docker system file mount information: PRIVATE_SIGNAL",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: parse Docker system file mount information: PRIVATE_SIGNAL",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: Docker system files are not three read-only mounts",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: open Docker system file /PRIVATE_FILE: failure",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: inspect Docker system file /PRIVATE_FILE: failure",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: read Docker system file /PRIVATE_FILE: failure",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: Docker hostname contradicts the admitted content",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: Docker hosts file contradicts the admitted content",
      "Prime container readiness failed while validating system files",
    ],
    [
      "measure Prime container readiness: Docker resolver file contradicts the admitted content",
      "Prime container readiness failed while validating system files",
    ],
    [
      "create Prime private path /PRIVATE_PATH: failure",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "set Prime private path owner /PRIVATE_PATH: failure",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "set Prime private path mode /PRIVATE_PATH: failure",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "create kernel supervisor directory: PRIVATE_SIGNAL",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "remove stale kernel supervisor socket: PRIVATE_SIGNAL",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "listen on kernel supervisor socket: PRIVATE_SIGNAL",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "set kernel supervisor socket owner: PRIVATE_SIGNAL",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "set kernel supervisor socket mode: PRIVATE_SIGNAL",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "close kernel supervisor listener: PRIVATE_SIGNAL",
      "Prime container failed while preparing its private runtime",
    ],
    [
      "read Prime container frame header: PRIVATE_SIGNAL",
      "Prime container failed while reading attached protocol input",
    ],
    [
      "unknown Prime container frame type: PRIVATE_SIGNAL",
      "Prime container failed while reading attached protocol input",
    ],
    [
      "parse Prime readiness challenge: PRIVATE_SIGNAL",
      "Prime container failed while reading attached protocol input",
    ],
    [
      "Prime readiness challenge violates the closed schema",
      "Prime container failed while reading attached protocol input",
    ],
    [
      "Prime preparation input is incomplete",
      "Prime container failed while reading attached protocol input",
    ],
  ])(
    "admits only an anchored supervisor diagnostic: %s",
    async (privateDiagnostic, publicMessage) => {
      const classify = async (diagnostic: string): Promise<Error> => {
        const socket = new PassThrough();
        socket.end();
        const attached = new NodeDockerAttachedTransport(
          socket,
          rawStreamFrame(2, Buffer.from(`${diagnostic}\n`)),
          { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
        );
        return (await attached.output[Symbol.asyncIterator]()
          .next()
          .catch((caught) => caught)) as Error;
      };

      const admitted = await classify(privateDiagnostic);
      expect(admitted.message).toBe(publicMessage);
      expect(admitted.cause).toBeUndefined();
      expect(admitted.message).not.toContain("PRIVATE");

      const planted = await classify(`PRIVATE_PLANTED ${privateDiagnostic}`);
      expect(planted.message).toBe("Prime container ended before readiness");
      expect(planted.cause).toBeUndefined();
      expect(planted.message).not.toContain("PRIVATE");
    },
  );

  it("classifies fragmented private stderr without retaining its suffix", async () => {
    const socket = new PassThrough();
    const encoded = rawStreamFrame(
      2,
      Buffer.from("create Prime private path /PRIVATE_FRAGMENT: permission denied\n"),
    );
    const attached = new NodeDockerAttachedTransport(socket, encoded.subarray(0, 7), {
      maxStderrBytes: 65_536,
      maxStdoutFrameBytes: 1_024,
    });
    socket.end(encoded.subarray(7));

    const error = await attached.output[Symbol.asyncIterator]()
      .next()
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Prime container failed while preparing its private runtime",
    );
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE_FRAGMENT");
  });

  it("joins one diagnostic split across complete stderr frames", async () => {
    const socket = new PassThrough();
    socket.end();
    const attached = new NodeDockerAttachedTransport(
      socket,
      Buffer.concat([
        rawStreamFrame(2, Buffer.from("create Prime priv")),
        rawStreamFrame(2, Buffer.from("ate path /PRIVATE_MULTI_FRAME\n")),
      ]),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );

    const error = await attached.output[Symbol.asyncIterator]()
      .next()
      .catch((caught) => caught);

    expect((error as Error).message).toBe(
      "Prime container failed while preparing its private runtime",
    );
    expect((error as Error).message).not.toContain("PRIVATE_MULTI_FRAME");
  });

  it.each([
    "PRIVATE_PREFIX measure Prime container readiness: Prime effective process controls contradict the fixed runtime policy\n",
    "measure Prime container readiness: Prime effective process controls contradict the fixed runtime policy PRIVATE_SUFFIX\n",
  ])("does not classify an embedded readiness phrase", async (privateDiagnostic) => {
    const socket = new PassThrough();
    socket.end();
    const attached = new NodeDockerAttachedTransport(
      socket,
      rawStreamFrame(2, Buffer.from(privateDiagnostic)),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );

    const error = await attached.output[Symbol.asyncIterator]()
      .next()
      .catch((caught) => caught);

    expect((error as Error).message).toBe("Prime container ended before readiness");
    expect((error as Error).message).not.toContain("PRIVATE");
  });

  it.each([
    { stderr: Buffer.alloc(0), label: "empty" },
    { stderr: Buffer.from("PRIVATE_UNKNOWN\n"), label: "unknown" },
    { stderr: Buffer.from([0xff]), label: "invalid UTF-8" },
  ])("uses one fixed fallback for $label stderr", async ({ stderr }) => {
    const socket = new PassThrough();
    socket.end();
    const head = stderr.byteLength === 0 ? Buffer.alloc(0) : rawStreamFrame(2, stderr);
    const attached = new NodeDockerAttachedTransport(socket, head, {
      maxStderrBytes: 65_536,
      maxStdoutFrameBytes: 1_024,
    });

    const error = await attached.output[Symbol.asyncIterator]()
      .next()
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Prime container ended before readiness");
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE_UNKNOWN");
  });

  it("keeps the stderr byte boundary exact before classification", async () => {
    const prefix = Buffer.from("create Prime private path ");
    const exactDiagnostic = Buffer.concat([prefix, Buffer.alloc(65_536 - prefix.byteLength, 0x78)]);
    const exactSocket = new PassThrough();
    exactSocket.end();
    const exact = new NodeDockerAttachedTransport(exactSocket, rawStreamFrame(2, exactDiagnostic), {
      maxStderrBytes: 65_536,
      maxStdoutFrameBytes: 1_024,
    });
    const exactError = await exact.output[Symbol.asyncIterator]()
      .next()
      .catch((caught) => caught);
    expect((exactError as Error).message).toBe(
      "Prime container failed while preparing its private runtime",
    );

    const overflowSocket = new PassThrough();
    overflowSocket.end();
    const overflow = new NodeDockerAttachedTransport(
      overflowSocket,
      rawStreamFrame(2, Buffer.concat([exactDiagnostic, Buffer.from("x")])),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );
    await expect(overflow.output[Symbol.asyncIterator]().next()).rejects.toThrow(
      "Docker standard error exceeds 65536 bytes",
    );

    const exactAcrossFramesSocket = new PassThrough();
    exactAcrossFramesSocket.end();
    const exactAcrossFrames = new NodeDockerAttachedTransport(
      exactAcrossFramesSocket,
      Buffer.concat([
        rawStreamFrame(2, exactDiagnostic.subarray(0, 32_768)),
        rawStreamFrame(2, exactDiagnostic.subarray(32_768)),
      ]),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );
    const exactAcrossFramesError = await exactAcrossFrames.output[Symbol.asyncIterator]()
      .next()
      .catch((caught) => caught);
    expect((exactAcrossFramesError as Error).message).toBe(
      "Prime container failed while preparing its private runtime",
    );

    const overflowAcrossFramesSocket = new PassThrough();
    overflowAcrossFramesSocket.end();
    const overflowAcrossFrames = new NodeDockerAttachedTransport(
      overflowAcrossFramesSocket,
      Buffer.concat([
        rawStreamFrame(2, exactDiagnostic.subarray(0, 32_768)),
        rawStreamFrame(2, Buffer.concat([exactDiagnostic.subarray(32_768), Buffer.from("x")])),
      ]),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );
    await expect(overflowAcrossFrames.output[Symbol.asyncIterator]().next()).rejects.toThrow(
      "Docker standard error exceeds 65536 bytes",
    );
  });

  it("keeps a fatal supervisor diagnostic after partial standard output", async () => {
    const socket = new PassThrough();
    socket.end();
    const attached = new NodeDockerAttachedTransport(
      socket,
      Buffer.concat([
        rawStreamFrame(1, Buffer.from("partial")),
        rawStreamFrame(2, Buffer.from("create Prime private path /PRIVATE_PARTIAL\n")),
      ]),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );
    const output = attached.output[Symbol.asyncIterator]();

    await expect(output.next()).resolves.toEqual({ done: false, value: Buffer.from("partial") });
    const error = await output.next().catch((caught) => caught);
    expect((error as Error).message).toBe(
      "Prime container failed while preparing its private runtime",
    );
    expect((error as Error).message).not.toContain("PRIVATE_PARTIAL");
  });

  it("uses one fixed runtime fallback for unknown stderr after standard output", async () => {
    const socket = new PassThrough();
    socket.end();
    const attached = new NodeDockerAttachedTransport(
      socket,
      Buffer.concat([
        rawStreamFrame(1, Buffer.from("partial")),
        rawStreamFrame(2, Buffer.from("PRIVATE_DRIVER_FAILURE")),
      ]),
      { maxStderrBytes: 65_536, maxStdoutFrameBytes: 1_024 },
    );
    const output = attached.output[Symbol.asyncIterator]();

    await output.next();
    const error = await output.next().catch((caught) => caught);
    expect((error as Error).message).toBe("Prime container reported a runtime failure");
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("PRIVATE_DRIVER_FAILURE");
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
    expect(
      new DockerRawStreamDecoder({ maxStderrBytes: 4 }).push(
        Buffer.concat(Array.from({ length: 1_000 }, () => rawStreamFrame(2, Buffer.alloc(0)))),
      ),
    ).toEqual([]);
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
