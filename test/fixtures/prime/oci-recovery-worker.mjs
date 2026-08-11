import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import { parseEvaluationOciLease } from "../../../dist/domain/evaluation/attempt.js";
import { DockerUnixApiClient } from "../../../dist/infrastructure/oci/docker-unix-api-client.js";
import { PrimeOciContainerLifecycle } from "../../../dist/infrastructure/oci/prime-container-lifecycle.js";

let config;

class RecoveryEngine {
  constructor(apiClient, options) {
    this.api = apiClient;
    this.config = options;
  }

  async create(intent) {
    const containerId = await this.api.createContainer(
      intent.containerName,
      containerConfiguration(intent),
    );
    crashAt("create-response");
    return { containerId, inspectedPolicyDigest: intent.policyDigest };
  }

  async recoverIntent(intent) {
    const inspection = await this.api.inspectContainer(intent.containerName);
    if (inspection === null) {
      return null;
    }
    assertRecoveredInspection(inspection, intent);
    return { containerId: inspection.Id, inspectedPolicyDigest: intent.policyDigest };
  }

  async attach() {
    crashAt("attach-response");
    return {
      output: Readable.from([]),
      write: async () => undefined,
      closeInput: async () => undefined,
      release: async () => undefined,
    };
  }

  async start(containerId) {
    await this.api.startContainer(containerId);
    crashAt("start-response");
  }

  async stop(containerId) {
    await this.api.stopContainer(containerId, 1);
    crashAt("stop-response");
  }

  async remove(containerId) {
    await this.api.removeContainer(containerId);
    crashAt("remove-response");
  }

  async confirmRemoved(containerId) {
    return (await this.api.inspectContainer(containerId)) === null;
  }
}

async function writeLease(lease) {
  const parsed = parseEvaluationOciLease(lease);
  const temporary = `${config.leasePath}.${String(process.pid)}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, config.leasePath);
  const directory = await open(dirname(config.leasePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  crashAt(`update-${parsed.state}`);
}

function crashAt(point) {
  if (config.crashPoint === point) {
    process.kill(process.pid, "SIGKILL");
  }
}

function containerConfiguration(intent) {
  return {
    Image: intent.imageId,
    Entrypoint: ["/usr/local/bin/node"],
    Cmd: ["-e", "setInterval(() => {}, 1000)"],
    Labels: {
      "flow.evaluation-id": intent.labels.evaluationId,
      "flow.trial-id": intent.labels.trialId,
      "flow.owner-nonce": intent.labels.ownerNonce,
      "flow.image-id": intent.labels.imageId,
      "flow.policy-digest": intent.labels.policyDigest,
    },
    OpenStdin: false,
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    Healthcheck: { Test: ["NONE"] },
    HostConfig: {
      NetworkMode: "none",
      IpcMode: "none",
      ReadonlyRootfs: true,
      LogConfig: { Type: "none", Config: {} },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    },
  };
}

function assertRecoveredInspection(inspection, intent) {
  const labels = inspection?.Config?.Labels;
  if (
    typeof inspection.Id !== "string" ||
    !/^[a-f0-9]{64}$/.test(inspection.Id) ||
    inspection.Name !== `/${intent.containerName}` ||
    inspection.Image !== intent.imageId ||
    labels?.["flow.owner-nonce"] !== intent.ownerNonce ||
    labels?.["flow.trial-id"] !== intent.labels.trialId ||
    labels?.["flow.policy-digest"] !== intent.policyDigest
  ) {
    throw new Error("Prime OCI recovery found a foreign container");
  }
}

function parseConfig(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.apiVersion !== "string" ||
    !/^\d+\.\d+$/.test(input.apiVersion) ||
    typeof input.leasePath !== "string" ||
    !input.leasePath.startsWith("/") ||
    typeof input.crashPoint !== "string"
  ) {
    throw new Error("Prime OCI recovery worker config is invalid");
  }
  return Object.freeze({
    apiVersion: input.apiVersion,
    leasePath: input.leasePath,
    crashPoint: input.crashPoint,
    intent: parseEvaluationOciLease(input.intent),
  });
}

const [configPath, action] = process.argv.slice(2);
if (configPath === undefined || (action !== "run" && action !== "recover")) {
  throw new Error("Prime OCI recovery worker arguments are invalid");
}
config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
const api = new DockerUnixApiClient({
  socketPath: "/var/run/docker.sock",
  apiVersion: config.apiVersion,
});
const engine = new RecoveryEngine(api, config);
const lifecycle = new PrimeOciContainerLifecycle(engine);

if (action === "recover") {
  const lease = parseEvaluationOciLease(JSON.parse(await readFile(config.leasePath, "utf8")));
  await lifecycle.recover({ lease, update: writeLease });
  process.exit(0);
}

await lifecycle.run({
  intent: config.intent,
  update: writeLease,
  assertCurrent: async () => undefined,
  operate: async (_containerId, _transport, checkpoint) => {
    await checkpoint("terminal");
    await checkpoint("exported");
  },
});
throw new Error("Prime OCI recovery worker reached the end without its crash checkpoint");
