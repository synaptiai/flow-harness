import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { parseEvaluationOciLease } from "../../src/domain/evaluation/attempt.js";
import { parsePrimeOciImageIdentity } from "../../src/domain/evaluation/external-harness.js";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const workerPath = join(repositoryRoot, "test/fixtures/prime/oci-recovery-worker.mjs");
const linux = process.platform === "linux" && process.arch === "x64";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.skipIf(!linux)("Prime OCI native crash recovery", () => {
  it.each([
    "update-intent",
    "create-response",
    "update-created",
    "attach-response",
    "start-response",
    "update-started",
    "update-terminal",
    "update-exported",
    "stop-response",
    "update-stopped",
    "remove-response",
  ] as const)(
    "recovers an exact lease after %s loss",
    async (crashPoint) => {
      const fixture = await createRecoveryFixture(crashPoint);
      const crashed = await runWorker(fixture.configPath, "run");
      expect(crashed).toEqual({ code: null, signal: "SIGKILL", stderr: "" });

      const recovered = await runWorker(fixture.configPath, "recover");
      expect(recovered).toEqual({ code: 0, signal: null, stderr: "" });
      const finalLease = parseEvaluationOciLease(
        JSON.parse(await readFile(fixture.leasePath, "utf8")),
      );
      expect(finalLease.state).toBe("removed");
      await expectDockerObjectAbsent(fixture.containerName, fixture.environment, fixture.docker);
    },
    120_000,
  );
});

async function createRecoveryFixture(crashPoint: string) {
  const root = await mkdtemp(join(tmpdir(), "flow-prime-container-recovery-"));
  temporaryDirectories.push(root);
  const docker = process.env.FLOW_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const environment = dockerEnvironment(root);
  const apiVersion = await executeFile(docker, ["version", "--format", "{{.Server.APIVersion}}"], {
    encoding: "utf8",
    env: environment,
  }).then((value) => value.stdout.trim());
  const socket = await lstat("/var/run/docker.sock");
  const image = readVerifiedImage();
  const trialId = `trial-${randomBytes(24).toString("hex")}`;
  const ownerNonce = randomBytes(32).toString("hex");
  const containerName = `flow-prime-${randomUUID().replaceAll("-", "")}`;
  const policyDigest = "9".repeat(64);
  const intent = parseEvaluationOciLease({
    version: 1,
    adapter: "prime-agent-native-v1",
    state: "intent",
    ownerNonce,
    containerName,
    labels: {
      evaluationId: "recovery",
      trialId,
      ownerNonce,
      imageId: image.id,
      policyDigest,
    },
    imageId: image.id,
    policyDigest,
    fixtureDigest: "f".repeat(64),
    engineEndpoint: {
      socketPath: "/var/run/docker.sock",
      device: socket.dev,
      inode: socket.ino,
      uid: socket.uid,
      gid: socket.gid,
      mode: socket.mode & 0o777,
    },
  });
  const leasePath = join(root, "lease.json");
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ apiVersion, crashPoint, intent, leasePath })}\n`,
    { mode: 0o600 },
  );
  return { configPath, containerName, docker, environment, leasePath };
}

function readVerifiedImage() {
  const path = process.env.FLOW_PRIME_TEST_IMAGE_RESULT;
  if (path === undefined) {
    throw new Error("Prime recovery gate requires FLOW_PRIME_TEST_IMAGE_RESULT");
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as { readonly image?: unknown };
  if (value.image === undefined) {
    throw new Error("Prime recovery gate received an invalid image result");
  }
  return parsePrimeOciImageIdentity(value.image);
}

function dockerEnvironment(root: string) {
  return {
    HOME: root,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: root,
  };
}

async function runWorker(configPath: string, action: "run" | "recover") {
  return await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }>((resolveRun, rejectRun) => {
    const errors: Buffer[] = [];
    const child = spawn(process.execPath, [workerPath, configPath, action], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      resolveRun({ code, signal, stderr: Buffer.concat(errors).toString("utf8") });
    });
  });
}

async function expectDockerObjectAbsent(
  reference: string,
  environment: NodeJS.ProcessEnv,
  docker: string,
): Promise<void> {
  await expect(
    executeFile(docker, ["inspect", reference], { encoding: "utf8", env: environment }),
  ).rejects.toThrow();
}
