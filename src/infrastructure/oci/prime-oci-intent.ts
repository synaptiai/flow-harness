import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { ExternalHarnessRuntimeRequest } from "../../application/external-harness-adapter.js";
import {
  type EvaluationOciLease,
  parseEvaluationOciLease,
} from "../../domain/evaluation/attempt.js";
import type { PrimeOciIntentLease } from "./prime-container-lifecycle.js";

type EngineEndpoint = EvaluationOciLease["engineEndpoint"];

export function createPrimeOciIntent(
  request: ExternalHarnessRuntimeRequest,
  engineEndpoint: EngineEndpoint,
  randomBytes: (bytes: number) => Buffer = nodeRandomBytes,
): PrimeOciIntentLease {
  if (request.identity.adapter !== "prime-agent-native-v1") {
    throw new Error("Prime OCI intent requires a Prime identity");
  }
  const ownerNonce = exactRandomHex(randomBytes, 32, "owner nonce");
  const nameNonce = exactRandomHex(randomBytes, 16, "container name");
  const lease = parseEvaluationOciLease({
    version: 1,
    adapter: "prime-agent-native-v1",
    state: "intent",
    ownerNonce,
    containerName: `flow-prime-${nameNonce}`,
    labels: {
      evaluationId: `evaluation-${request.evaluation.planDigest.slice(0, 48)}`,
      trialId: request.evaluation.trial.trialId,
      ownerNonce,
      imageId: request.identity.image.id,
      policyDigest: request.identity.runtime.policy.digest,
    },
    imageId: request.identity.image.id,
    policyDigest: request.identity.runtime.policy.digest,
    fixtureDigest: request.evaluation.workspace.snapshotDigest,
    engineEndpoint,
  });
  if (lease.state !== "intent") {
    throw new Error("Prime OCI intent parser returned a different lease state");
  }
  return lease as PrimeOciIntentLease;
}

function exactRandomHex(
  randomBytes: (bytes: number) => Buffer,
  byteCount: number,
  label: string,
): string {
  const value = randomBytes(byteCount);
  if (!Buffer.isBuffer(value) || value.byteLength !== byteCount) {
    throw new Error(`Prime OCI random ${label} has an invalid byte count`);
  }
  return value.toString("hex");
}
