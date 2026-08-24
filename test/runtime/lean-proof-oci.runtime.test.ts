import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createLeanProofRequest } from "../../src/domain/proof/lean-proof-verification.js";
import { DockerUnixApiClient } from "../../src/infrastructure/oci/docker-unix-api-client.js";
import {
  leanProofLeaseKey,
  type LeanProofContainerLease,
} from "../../src/infrastructure/oci/local-lean-proof-driver.js";
import { LocalLeanProofLeaseStore } from "../../src/infrastructure/oci/local-lean-proof-lease-store.js";
import { parseLeanProofOciAttestation } from "../../src/infrastructure/oci/local-lean-proof-runtime-admission.js";
import { createProductionLeanProofDriver } from "../../src/infrastructure/runtime/production-node-executor.js";

const repositoryRoot = process.cwd();
const enabled =
  process.platform === "linux" &&
  process.arch === "x64" &&
  process.env.FLOW_PROOF_RUNTIME_TEST === "1";

describe.skipIf(!enabled)("Lean proof OCI runtime", () => {
  it("accepts an exact theorem only after compilation, SafeVerify, Nanoda, and cleanup", async () => {
    const runtime = await preparedRuntime();
    const driver = createProductionLeanProofDriver(repositoryRoot);
    const request = proofRequest(runtime, "by\n  omega\n", "accepted");

    await expect(driver.execute(request, context("accepted"))).resolves.toMatchObject({
      requestDigest: request.requestDigest,
      compiler: { status: "accepted" },
      safeVerify: { status: "accepted" },
      nanoda: { status: "accepted" },
      cleanup: "confirmed",
    });
  }, 300_000);

  it("rejects incomplete source before it can become accepted proof evidence", async () => {
    const runtime = await preparedRuntime();
    const driver = createProductionLeanProofDriver(repositoryRoot);
    const request = proofRequest(runtime, "by\n  sorry\n", "incomplete");

    await expect(driver.execute(request, context("incomplete"))).resolves.toMatchObject({
      compiler: { status: "rejected", reasonCode: "source_policy_rejected" },
      safeVerify: { status: "not_run" },
      nanoda: { status: "not_run" },
      cleanup: "confirmed",
    });
  }, 300_000);

  it("does not accept compiler-backed native_decide authority outside the closed axiom policy", async () => {
    const runtime = await preparedRuntime();
    const driver = createProductionLeanProofDriver(repositoryRoot);
    const request = proofRequest(runtime, "by\n  native_decide\n", "native-decide");
    const evidence = await driver.execute(request, context("native-decide"));

    expect(evidence.compiler.status).toBe("accepted");
    expect(evidence.safeVerify.status).not.toBe("accepted");
    expect(evidence.cleanup).toBe("confirmed");
  }, 300_000);

  it("reconciles durable intent, blocks automatic retry, and cleans up cancellation", async () => {
    const runtime = await preparedRuntime();
    const request = proofRequest(runtime, "by\n  omega\n", "recovery");
    const recoveryContext = context("recovery");
    const leaseKey = leanProofLeaseKey(request, recoveryContext);
    const leaseStore = new LocalLeanProofLeaseStore({
      directory: join(repositoryRoot, ".flow", "proof-runtime", "leases"),
    });
    const intent: LeanProofContainerLease = {
      version: 1,
      state: "intent",
      leaseKey,
      containerName: `flow-proof-${leaseKey.slice(0, 32)}`,
      requestDigest: request.requestDigest,
      imageDigest: request.runtime.imageDigest,
      profileDigest: request.runtime.profileDigest,
      runId: recoveryContext.runId,
      workflowId: recoveryContext.workflowId,
      nodeId: recoveryContext.nodeId,
      attempt: recoveryContext.attempt,
    };
    await leaseStore.write(leaseKey, intent);

    const driver = createProductionLeanProofDriver(repositoryRoot);
    await expect(driver.execute(request, recoveryContext)).rejects.toThrow(
      /reconciled.*automatic retry is blocked/i,
    );
    await expect(leaseStore.read(leaseKey)).resolves.toBeNull();

    const cancellationContext = context("cancelled");
    const cancellationKey = leanProofLeaseKey(request, cancellationContext);
    const cancellation = new AbortController();
    cancellation.abort(new Error("operator cancellation"));
    await expect(
      driver.execute(request, { ...cancellationContext, signal: cancellation.signal }),
    ).rejects.toThrow();
    await expect(leaseStore.read(cancellationKey)).resolves.toBeNull();
    const api = new DockerUnixApiClient({
      socketPath: "/var/run/docker.sock",
      apiVersion: "1.51",
    });
    await expect(
      api.inspectContainer(`flow-proof-${cancellationKey.slice(0, 32)}`),
    ).resolves.toBeNull();
  }, 300_000);
});

async function preparedRuntime() {
  return parseLeanProofOciAttestation(
    JSON.parse(
      await readFile(join(repositoryRoot, ".flow", "proof-runtime", "attestation.json"), "utf8"),
    ),
  ).runtime;
}

function proofRequest(
  runtime: Awaited<ReturnType<typeof preparedRuntime>>,
  proof: string,
  suffix: string,
) {
  const specification = `For every natural number n, n plus zero is n (${suffix}).`;
  const statement = `theorem Flow.Proof.add_zero_${suffix.replaceAll("-", "_")} (n : Nat) : n + 0 = n`;
  const targetDeclaration = `Flow.Proof.add_zero_${suffix.replaceAll("-", "_")}`;
  return createLeanProofRequest({
    specification,
    statement,
    proof,
    targetDeclaration,
    runtime,
    faithfulness: {
      version: 1,
      authority: "human",
      approverIdentityHash: "a".repeat(64),
      approvedAt: "2026-08-24T00:00:00.000Z",
      specificationDigest: sha256(specification),
      statementDigest: sha256(statement),
    },
  });
}

function context(suffix: string) {
  return {
    runId: `runtime-${suffix}`,
    workflowId: "proof-runtime",
    nodeId: "verify-proof",
    attempt: 1,
    cwd: repositoryRoot,
    timeoutMs: 240_000,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
