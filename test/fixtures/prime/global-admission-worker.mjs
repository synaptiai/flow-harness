import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { parseExternalHarnessIdentity } from "../../../dist/domain/evaluation/external-harness.js";
import { DockerUnixApiClient } from "../../../dist/infrastructure/oci/docker-unix-api-client.js";
import { LocalDockerPrimeGlobalSlotEngine } from "../../../dist/infrastructure/oci/local-docker-prime-global-slot.js";
import { LocalPrimeGlobalSlotStore } from "../../../dist/infrastructure/oci/local-prime-global-slot-store.js";
import {
  PrimeGlobalAdmissionController,
  parsePrimeGlobalSlotLease,
} from "../../../dist/infrastructure/oci/prime-global-admission.js";

const [configPath, mode, readyPath, releasePath] = process.argv.slice(2);
const modes = new Set([
  "attempt",
  "crash-create",
  "crash-intent",
  "crash-owned",
  "hold",
  "recover",
]);
if (configPath === undefined || mode === undefined || !modes.has(mode)) {
  throw new Error("Prime admission worker arguments are invalid");
}

const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
const store = new LocalPrimeGlobalSlotStore({ leasePath: config.leasePath });
const engine = new LocalDockerPrimeGlobalSlotEngine({
  api: new DockerUnixApiClient({
    socketPath: "/var/run/docker.sock",
    apiVersion: config.apiVersion,
  }),
  identity: config.identity,
  daemonId: config.daemonId,
});
const controller = new PrimeGlobalAdmissionController({
  store,
  engine,
  daemonId: config.daemonId,
  policyDigest: config.identity.runtime.policy.digest,
  ownerNonce: () => randomBytes(32).toString("hex"),
});

if (mode === "recover") {
  await controller.recover();
  process.exit(0);
}

if (mode === "crash-intent" || mode === "crash-create") {
  const intent = parsePrimeGlobalSlotLease({
    version: 1,
    state: "intent",
    lockName: "flow-prime-global-v1",
    ownerNonce: randomBytes(32).toString("hex"),
    policyDigest: config.identity.runtime.policy.digest,
    daemonId: config.daemonId,
  });
  await store.writeIntent(intent);
  if (mode === "crash-create") {
    await engine.create(intent);
  }
  process.kill(process.pid, "SIGKILL");
}

if (mode === "crash-owned") {
  await controller.acquire();
  process.kill(process.pid, "SIGKILL");
}

if (mode === "attempt") {
  const lease = await controller.acquire();
  await controller.release(lease);
  throw new Error("Prime admission worker acquired an occupied global slot");
}

if (readyPath === undefined || releasePath === undefined) {
  throw new Error("Prime admission holder paths are invalid");
}
const lease = await controller.acquire();
await writeFile(readyPath, "ready\n", { flag: "wx", mode: 0o660 });
await waitForRelease(releasePath);
await controller.release(lease);

function parseConfig(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Prime admission worker config is invalid");
  }
  const identity = parseExternalHarnessIdentity(input.identity);
  if (identity.adapter !== "prime-agent-native-v1") {
    throw new Error("Prime admission worker requires a Prime identity");
  }
  if (
    typeof input.daemonId !== "string" ||
    input.daemonId.length < 1 ||
    input.daemonId.length > 256 ||
    typeof input.apiVersion !== "string" ||
    !/^\d+\.\d+$/.test(input.apiVersion) ||
    typeof input.leasePath !== "string" ||
    !input.leasePath.startsWith("/")
  ) {
    throw new Error("Prime admission worker config fields are invalid");
  }
  return Object.freeze({
    identity,
    daemonId: input.daemonId,
    apiVersion: input.apiVersion,
    leasePath: input.leasePath,
  });
}

async function waitForRelease(path) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("Prime admission holder did not receive release");
}
