import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { calculateEvaluationVerifierDigest, type EvaluationFilesystemAssertion } from "./plan.js";
import type { EvaluationVerificationOutcome } from "./records.js";

export const MAX_EVALUATION_ASSERTED_FILE_BYTES = 256 * 1024 * 1024;

export interface EvaluationWorkspaceIdentity {
  readonly workspaceId: string;
  readonly backend: "reflink-copy-v1";
  readonly snapshotDigest: string;
}

export interface EvaluationVerifierWorkspace extends EvaluationWorkspaceIdentity {
  readonly cwd: string;
}

export interface VerifyEvaluationWorkspaceRequest {
  readonly workspace: EvaluationVerifierWorkspace;
  readonly expectedIdentity: EvaluationWorkspaceIdentity;
  readonly verifier: {
    readonly kind: "filesystem-v1";
    readonly digest: string;
    readonly assertions: readonly EvaluationFilesystemAssertion[];
  };
}

type SafePathObservation =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly stats: Stats; readonly path: string }
  | { readonly kind: "directory" };

class UnsafeVerificationPathError extends Error {
  override readonly name = "UnsafeVerificationPathError";
}

export async function verifyEvaluationWorkspace(
  request: VerifyEvaluationWorkspaceRequest,
): Promise<EvaluationVerificationOutcome> {
  if (
    calculateEvaluationVerifierDigest(request.verifier.kind, request.verifier.assertions) !==
    request.verifier.digest
  ) {
    return verificationError(
      request.verifier.digest,
      [],
      "verifier digest does not match its admitted assertions",
    );
  }
  if (!sameWorkspaceIdentity(request.workspace, request.expectedIdentity)) {
    return verificationError(request.verifier.digest, [], "workspace identity does not match");
  }

  let root: string;
  try {
    const requestedRoot = resolve(request.workspace.cwd);
    if (!(await lstat(requestedRoot)).isDirectory()) {
      return verificationError(request.verifier.digest, [], "workspace root is not a directory");
    }
    root = await realpath(requestedRoot);
    if (!(await lstat(root)).isDirectory()) {
      return verificationError(
        request.verifier.digest,
        [],
        "canonical workspace root is not a directory",
      );
    }
  } catch (error) {
    return verificationError(
      request.verifier.digest,
      [],
      `workspace root cannot be verified: ${boundedReason(error)}`,
    );
  }

  const evidence: EvaluationVerificationOutcome["assertions"][number][] = [];
  for (const assertion of request.verifier.assertions) {
    try {
      const observation = await observeSafePath(root, assertion.path);
      if (assertion.kind === "exists") {
        evidence.push(
          Object.freeze({
            kind: assertion.kind,
            path: assertion.path,
            outcome: observation.kind !== "missing",
          }),
        );
        continue;
      }
      if (assertion.kind === "absent") {
        evidence.push(
          Object.freeze({
            kind: assertion.kind,
            path: assertion.path,
            outcome: observation.kind === "missing",
          }),
        );
        continue;
      }
      if (observation.kind === "missing") {
        evidence.push(
          Object.freeze({
            kind: assertion.kind,
            path: assertion.path,
            outcome: false,
            reason: "asserted file is missing",
          }),
        );
        continue;
      }
      if (observation.kind === "directory") {
        evidence.push(
          Object.freeze({
            kind: assertion.kind,
            path: assertion.path,
            outcome: false,
            reason: "asserted path is not a regular file",
          }),
        );
        continue;
      }
      const observedSha256 = await hashStableFile(observation.path, observation.stats);
      evidence.push(
        Object.freeze({
          kind: assertion.kind,
          path: assertion.path,
          outcome: observedSha256 === assertion.value,
          observedSha256,
        }),
      );
    } catch (error) {
      evidence.push(
        Object.freeze({
          kind: assertion.kind,
          path: assertion.path,
          outcome: false,
          reason: boundedReason(error),
        }),
      );
      return verificationError(request.verifier.digest, evidence, boundedReason(error));
    }
  }

  return Object.freeze({
    outcome: evidence.every((item) => item.outcome) ? "accepted" : "rejected",
    verifierDigest: request.verifier.digest,
    assertions: evidence,
  });
}

async function observeSafePath(root: string, portablePath: string): Promise<SafePathObservation> {
  assertCanonicalRelativePath(portablePath);
  const candidate = resolve(root, portablePath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new UnsafeVerificationPathError(`assertion path "${portablePath}" escapes the workspace`);
  }

  let current = root;
  for (const [index, segment] of portablePath.split("/").entries()) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return Object.freeze({ kind: "missing" });
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new UnsafeVerificationPathError(
        `assertion path "${portablePath}" contains a symbolic link`,
      );
    }
    const final = index === portablePath.split("/").length - 1;
    if (!final && !stats.isDirectory()) {
      return Object.freeze({ kind: "missing" });
    }
    if (final) {
      if (stats.isFile()) {
        return Object.freeze({ kind: "file", stats, path: current });
      }
      if (stats.isDirectory()) {
        return Object.freeze({ kind: "directory" });
      }
      throw new UnsafeVerificationPathError(
        `assertion path "${portablePath}" is not a regular file or directory`,
      );
    }
  }
  throw new UnsafeVerificationPathError(`assertion path "${portablePath}" is invalid`);
}

async function hashStableFile(path: string, observed: Stats): Promise<string> {
  if (observed.size > MAX_EVALUATION_ASSERTED_FILE_BYTES) {
    throw new UnsafeVerificationPathError(
      `asserted file exceeds ${MAX_EVALUATION_ASSERTED_FILE_BYTES} bytes`,
    );
  }
  const parentBefore = await lstat(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileIdentity(observed, before)) {
      throw new UnsafeVerificationPathError("asserted file changed before verification");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) {
        throw new UnsafeVerificationPathError("asserted file ended during verification");
      }
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [after, pathAfter, parentAfter] = await Promise.all([
      handle.stat(),
      lstat(path),
      lstat(dirname(path)),
    ]);
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(before, pathAfter) ||
      !sameFileIdentity(parentBefore, parentAfter)
    ) {
      throw new UnsafeVerificationPathError("asserted file changed during verification");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

function verificationError(
  verifierDigest: string,
  assertions: EvaluationVerificationOutcome["assertions"],
  reason: string,
): EvaluationVerificationOutcome {
  return Object.freeze({
    outcome: "error",
    verifierDigest,
    assertions: [...assertions],
    reason: reason.slice(0, 4_096),
  });
}

function sameWorkspaceIdentity(
  actual: EvaluationWorkspaceIdentity,
  expected: EvaluationWorkspaceIdentity,
): boolean {
  return (
    actual.workspaceId === expected.workspaceId &&
    actual.backend === expected.backend &&
    actual.snapshotDigest === expected.snapshotDigest &&
    /^[a-f0-9]{64}$/.test(actual.snapshotDigest)
  );
}

function assertCanonicalRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new UnsafeVerificationPathError(
      `assertion path "${path.slice(0, 128)}" is not canonical`,
    );
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 4_096);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
