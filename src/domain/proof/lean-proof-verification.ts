import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const LEAN_PROOF_PROFILE = "lean-proof-v1" as const;
export const LEAN_PROOF_ALLOWED_AXIOMS = Object.freeze([
  "propext",
  "Quot.sound",
  "Classical.choice",
] as const);
export const MAX_LEAN_PROOF_SPECIFICATION_BYTES = 65_536;
export const MAX_LEAN_PROOF_STATEMENT_BYTES = 131_072;
export const MAX_LEAN_PROOF_BYTES = 262_144;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const OCI_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXACT_LEAN_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const LEAN_DECLARATION_PATTERN = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/;
const LEAN_STATEMENT_HEADER_PATTERN =
  /^\s*(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)+)[\s\S]*$/;

export type LeanProofContractErrorCode =
  | "invalid_request"
  | "limit_exceeded"
  | "faithfulness_mismatch";

export class LeanProofContractError extends Error {
  override readonly name = "LeanProofContractError";

  constructor(
    readonly code: LeanProofContractErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface LeanProofRuntimeIdentity {
  readonly version: 1;
  readonly platform: "linux";
  readonly architecture: "x64";
  readonly imageDigest: string;
  readonly buildAttestationDigest: string;
  readonly dependencyManifestDigest: string;
  readonly leanVersion: string;
  readonly mathlibRevision: string;
  readonly safeVerifyRevision: string;
  readonly nanodaRevision: string;
  readonly profileDigest: string;
}

export interface LeanStatementFaithfulnessApproval {
  readonly version: 1;
  readonly authority: "human";
  readonly approverIdentityHash: string;
  readonly approvedAt: string;
  readonly specificationDigest: string;
  readonly statementDigest: string;
}

export interface LeanProofModelRoute {
  readonly selectionRule: "exact-model-v1";
  readonly fallback: "deny";
  readonly provider: string;
  readonly model: string;
  readonly thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface LeanProofRequestInput {
  readonly specification: string;
  readonly statement: string;
  readonly proof: string;
  readonly targetDeclaration: string;
  readonly runtime: LeanProofRuntimeIdentity;
  readonly faithfulness: LeanStatementFaithfulnessApproval;
  readonly proofModel?: LeanProofModelRoute;
}

export interface LeanProofRequest extends LeanProofRequestInput {
  readonly version: 1;
  readonly kind: typeof LEAN_PROOF_PROFILE;
  readonly specificationDigest: string;
  readonly statementDigest: string;
  readonly proofDigest: string;
  readonly requestDigest: string;
}

export type LeanProofCompilerEvidence =
  | {
      readonly status: "accepted";
      readonly targetDeclaration: string;
      readonly statementDigest: string;
      readonly environmentDigest: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "rejected";
      readonly reasonCode: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
      readonly durationMs: number;
    };

export type LeanSafeVerifyEvidence =
  | {
      readonly status: "accepted" | "rejected";
      readonly targetDeclaration: string;
      readonly statementDigest: string;
      readonly environmentDigest: string;
      readonly observedAxioms: readonly string[];
      readonly reasonCode: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "not_run";
      readonly reasonCode: string;
      readonly durationMs: number;
    };

export type LeanNanodaEvidence =
  | {
      readonly status: "accepted" | "rejected";
      readonly environmentDigest: string;
      readonly reasonCode: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "not_run";
      readonly reasonCode: string;
      readonly durationMs: number;
    };

export interface LeanProofExecutionEvidence {
  readonly version: 1;
  readonly requestDigest: string;
  readonly runtimeIdentity: LeanProofRuntimeIdentity;
  readonly compiler: LeanProofCompilerEvidence;
  readonly safeVerify: LeanSafeVerifyEvidence;
  readonly nanoda: LeanNanodaEvidence;
  readonly cleanup: "confirmed" | "unconfirmed";
}

export interface LeanProofDecision {
  readonly verdict: "accepted" | "rejected" | "inconclusive";
  readonly reason: string;
  readonly reasonCode:
    | "proof_accepted"
    | "compiler_rejected"
    | "compiler_unavailable"
    | "kernel_replay_rejected"
    | "kernel_replay_unavailable"
    | "independent_checker_unavailable"
    | "checker_disagreement"
    | "evidence_identity_mismatch"
    | "cleanup_unconfirmed";
}

export interface PublicLeanProofRequest {
  readonly version: 1;
  readonly profile: typeof LEAN_PROOF_PROFILE;
  readonly requestDigest: string;
  readonly specification: { readonly digest: string; readonly bytes: number };
  readonly statement: { readonly digest: string; readonly bytes: number };
  readonly proof: { readonly digest: string; readonly bytes: number };
  readonly targetDeclaration: { readonly digest: string; readonly bytes: number };
  readonly runtime: LeanProofRuntimeIdentity;
  readonly faithfulness: {
    readonly authority: "human";
    readonly approverIdentityHash: string;
    readonly approvedAt: string;
    readonly specificationDigest: string;
    readonly statementDigest: string;
  };
  readonly proofModel: LeanProofModelRoute | null;
}

export interface PublicLeanProofEvidence extends PublicLeanProofRequest {
  readonly compiler: PublicLeanProofCompilerEvidence;
  readonly safeVerify: PublicLeanSafeVerifyEvidence;
  readonly nanoda: LeanNanodaEvidence;
  readonly cleanup: "confirmed" | "unconfirmed";
}

export type PublicLeanProofCompilerEvidence =
  | (Omit<
      Extract<LeanProofCompilerEvidence, { readonly status: "accepted" }>,
      "targetDeclaration"
    > & {
      readonly targetDeclaration: { readonly digest: string; readonly bytes: number };
    })
  | Exclude<LeanProofCompilerEvidence, { readonly status: "accepted" }>;

export type PublicLeanSafeVerifyEvidence =
  | (Omit<
      Extract<LeanSafeVerifyEvidence, { readonly status: "accepted" | "rejected" }>,
      "targetDeclaration"
    > & {
      readonly targetDeclaration: { readonly digest: string; readonly bytes: number };
    })
  | Exclude<LeanSafeVerifyEvidence, { readonly status: "accepted" | "rejected" }>;

export interface PublicLeanProofExecutionEvidence {
  readonly version: 1;
  readonly requestDigest: string;
  readonly runtimeIdentity: LeanProofRuntimeIdentity;
  readonly compiler: PublicLeanProofCompilerEvidence;
  readonly safeVerify: PublicLeanSafeVerifyEvidence;
  readonly nanoda: LeanNanodaEvidence;
  readonly cleanup: "confirmed" | "unconfirmed";
}

export function createLeanProofRequest(input: LeanProofRequestInput): LeanProofRequest {
  validateBoundedText("specification", input.specification, MAX_LEAN_PROOF_SPECIFICATION_BYTES);
  validateBoundedText("statement", input.statement, MAX_LEAN_PROOF_STATEMENT_BYTES);
  validateBoundedText("proof", input.proof, MAX_LEAN_PROOF_BYTES);
  validateTargetDeclaration(input.targetDeclaration);
  validateStatementAndProof(input.statement, input.proof, input.targetDeclaration);
  validateRuntimeIdentity(input.runtime);
  validateFaithfulnessApproval(input.faithfulness);
  if (input.proofModel !== undefined) validateProofModel(input.proofModel);

  const specificationDigest = sha256(input.specification);
  const statementDigest = sha256(input.statement);
  const proofDigest = sha256(input.proof);
  if (
    input.faithfulness.specificationDigest !== specificationDigest ||
    input.faithfulness.statementDigest !== statementDigest
  ) {
    throw new LeanProofContractError(
      "faithfulness_mismatch",
      "human faithfulness approval does not bind the exact specification and statement",
    );
  }

  const content = {
    version: 1 as const,
    kind: LEAN_PROOF_PROFILE,
    specification: input.specification,
    statement: input.statement,
    proof: input.proof,
    targetDeclaration: input.targetDeclaration,
    runtime: cloneRuntime(input.runtime),
    faithfulness: { ...input.faithfulness },
    ...(input.proofModel === undefined ? {} : { proofModel: { ...input.proofModel } }),
    specificationDigest,
    statementDigest,
    proofDigest,
  };
  return deepFreeze({ ...content, requestDigest: sha256(JSON.stringify(content)) });
}

export function isLeanProofRequest(value: unknown): value is LeanProofRequest {
  if (!isRecord(value)) return false;
  try {
    const reconstructed = createLeanProofRequest(value as unknown as LeanProofRequestInput);
    return isDeepStrictEqual(reconstructed, value);
  } catch {
    return false;
  }
}

export function isLeanProofExecutionEvidence(value: unknown): value is LeanProofExecutionEvidence {
  if (
    !hasExactKeys(value, [
      "version",
      "requestDigest",
      "runtimeIdentity",
      "compiler",
      "safeVerify",
      "nanoda",
      "cleanup",
    ]) ||
    value.version !== 1 ||
    typeof value.requestDigest !== "string" ||
    !isSha256(value.requestDigest) ||
    !isRuntimeIdentity(value.runtimeIdentity) ||
    (value.cleanup !== "confirmed" && value.cleanup !== "unconfirmed")
  ) {
    return false;
  }
  return (
    isCompilerEvidence(value.compiler) &&
    isSafeVerifyEvidence(value.safeVerify) &&
    isNanodaEvidence(value.nanoda)
  );
}

export function decideLeanProofVerification(
  request: LeanProofRequest,
  evidence: LeanProofExecutionEvidence,
): LeanProofDecision {
  if (
    evidence.version !== 1 ||
    evidence.requestDigest !== request.requestDigest ||
    !isDeepStrictEqual(evidence.runtimeIdentity, request.runtime)
  ) {
    return decision(
      "inconclusive",
      "proof execution evidence does not match the admitted request and runtime",
      "evidence_identity_mismatch",
    );
  }
  if (evidence.compiler.status === "unavailable") {
    return decision("inconclusive", "compiler evidence is unavailable", "compiler_unavailable");
  }
  if (evidence.compiler.status === "rejected") {
    return decision("rejected", "the Lean compiler rejected the submission", "compiler_rejected");
  }
  if (
    evidence.compiler.targetDeclaration !== request.targetDeclaration ||
    evidence.compiler.statementDigest !== request.statementDigest ||
    !isSha256(evidence.compiler.environmentDigest)
  ) {
    return decision(
      "inconclusive",
      "compiler evidence does not match the admitted statement",
      "evidence_identity_mismatch",
    );
  }

  if (evidence.safeVerify.status === "unavailable" || evidence.safeVerify.status === "not_run") {
    return decision(
      "inconclusive",
      "kernel-replay evidence is unavailable",
      "kernel_replay_unavailable",
    );
  }
  if (!sameSafeVerifyIdentity(request, evidence)) {
    return decision(
      "inconclusive",
      "kernel-replay evidence does not match the exact compiled declaration",
      "evidence_identity_mismatch",
    );
  }

  if (evidence.safeVerify.status === "rejected") {
    if (evidence.nanoda.status === "accepted") {
      return checkerDisagreement();
    }
    return decision(
      "rejected",
      "kernel replay rejected the proof under the closed authority policy",
      "kernel_replay_rejected",
    );
  }
  if (!hasOnlyAllowedAxioms(evidence.safeVerify.observedAxioms)) {
    return decision(
      "rejected",
      "kernel replay rejected the proof under the closed authority policy",
      "kernel_replay_rejected",
    );
  }

  if (evidence.nanoda.status === "unavailable" || evidence.nanoda.status === "not_run") {
    return decision(
      "inconclusive",
      "independent proof-checker evidence is unavailable",
      "independent_checker_unavailable",
    );
  }
  if (evidence.nanoda.status === "rejected") return checkerDisagreement();
  if (
    !isSha256(evidence.nanoda.environmentDigest) ||
    evidence.nanoda.environmentDigest !== evidence.compiler.environmentDigest
  ) {
    return decision(
      "inconclusive",
      "independent proof-checker evidence does not match the compiled environment",
      "evidence_identity_mismatch",
    );
  }
  if (evidence.cleanup !== "confirmed") {
    return decision("inconclusive", "proof runtime cleanup is unconfirmed", "cleanup_unconfirmed");
  }
  return decision(
    "accepted",
    "both proof checkers accepted the exact compiled declaration and cleanup is confirmed",
    "proof_accepted",
  );
}

export function projectPublicLeanProofEvidence(
  request: LeanProofRequest,
  evidence: LeanProofExecutionEvidence,
): PublicLeanProofEvidence {
  return deepFreeze({
    ...projectPublicLeanProofRequest(request),
    ...projectPublicLeanProofExecutionEvidence(evidence),
  });
}

export function projectPublicLeanProofExecutionEvidence(
  evidence: LeanProofExecutionEvidence,
): PublicLeanProofExecutionEvidence {
  return deepFreeze({
    version: 1,
    requestDigest: evidence.requestDigest,
    runtimeIdentity: cloneRuntime(evidence.runtimeIdentity),
    compiler: projectCompilerEvidence(evidence.compiler),
    safeVerify: projectSafeVerifyEvidence(evidence.safeVerify),
    nanoda: structuredClone(evidence.nanoda),
    cleanup: evidence.cleanup,
  });
}

export function projectPublicLeanProofRequest(request: LeanProofRequest): PublicLeanProofRequest {
  return deepFreeze({
    version: 1,
    profile: LEAN_PROOF_PROFILE,
    requestDigest: request.requestDigest,
    specification: {
      digest: request.specificationDigest,
      bytes: Buffer.byteLength(request.specification, "utf8"),
    },
    statement: {
      digest: request.statementDigest,
      bytes: Buffer.byteLength(request.statement, "utf8"),
    },
    proof: { digest: request.proofDigest, bytes: Buffer.byteLength(request.proof, "utf8") },
    targetDeclaration: {
      digest: sha256(request.targetDeclaration),
      bytes: Buffer.byteLength(request.targetDeclaration, "utf8"),
    },
    runtime: cloneRuntime(request.runtime),
    faithfulness: { ...request.faithfulness },
    proofModel: request.proofModel === undefined ? null : { ...request.proofModel },
  });
}

function validateBoundedText(name: string, value: string, limit: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new LeanProofContractError("invalid_request", `${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > limit) {
    throw new LeanProofContractError(
      "limit_exceeded",
      `${name} must not exceed ${limit} UTF-8 bytes`,
    );
  }
}

function projectCompilerEvidence(
  evidence: LeanProofCompilerEvidence,
): PublicLeanProofCompilerEvidence {
  if (evidence.status !== "accepted") return structuredClone(evidence);
  return {
    ...evidence,
    targetDeclaration: contentIdentity(evidence.targetDeclaration),
  };
}

function projectSafeVerifyEvidence(evidence: LeanSafeVerifyEvidence): PublicLeanSafeVerifyEvidence {
  if (evidence.status === "unavailable" || evidence.status === "not_run") {
    return {
      status: evidence.status,
      reasonCode: evidence.reasonCode,
      durationMs: evidence.durationMs,
    };
  }
  return {
    ...evidence,
    targetDeclaration: contentIdentity(evidence.targetDeclaration),
  };
}

function contentIdentity(value: string): { readonly digest: string; readonly bytes: number } {
  return { digest: sha256(value), bytes: Buffer.byteLength(value, "utf8") };
}

function validateTargetDeclaration(value: string): void {
  if (!LEAN_DECLARATION_PATTERN.test(value)) {
    throw new LeanProofContractError(
      "invalid_request",
      "target declaration must be an exact namespaced Lean declaration",
    );
  }
}

function validateStatementAndProof(
  statement: string,
  proof: string,
  targetDeclaration: string,
): void {
  const statementMatch = LEAN_STATEMENT_HEADER_PATTERN.exec(statement);
  if (
    statementMatch?.[1] !== targetDeclaration ||
    statement.includes(":=") ||
    statement.includes("\0")
  ) {
    throw new LeanProofContractError(
      "invalid_request",
      "statement must be one exact theorem header for the target declaration without a proof body",
    );
  }
  if (!/^\s*by(?:\s|$)/.test(proof) || proof.includes("\0")) {
    throw new LeanProofContractError("invalid_request", "proof must be a separate Lean by-term");
  }
}

function validateRuntimeIdentity(value: LeanProofRuntimeIdentity): void {
  if (!isRuntimeIdentity(value)) {
    throw new LeanProofContractError(
      "invalid_request",
      "proof runtime identity must be an exact attested Linux x64 identity",
    );
  }
}

function isRuntimeIdentity(value: unknown): value is LeanProofRuntimeIdentity {
  return (
    hasExactKeys(value, [
      "version",
      "platform",
      "architecture",
      "imageDigest",
      "buildAttestationDigest",
      "dependencyManifestDigest",
      "leanVersion",
      "mathlibRevision",
      "safeVerifyRevision",
      "nanodaRevision",
      "profileDigest",
    ]) &&
    value.version === 1 &&
    value.platform === "linux" &&
    value.architecture === "x64" &&
    typeof value.imageDigest === "string" &&
    OCI_DIGEST_PATTERN.test(value.imageDigest) &&
    typeof value.leanVersion === "string" &&
    EXACT_LEAN_VERSION_PATTERN.test(value.leanVersion) &&
    typeof value.buildAttestationDigest === "string" &&
    isSha256(value.buildAttestationDigest) &&
    typeof value.dependencyManifestDigest === "string" &&
    isSha256(value.dependencyManifestDigest) &&
    typeof value.mathlibRevision === "string" &&
    GIT_COMMIT_PATTERN.test(value.mathlibRevision) &&
    typeof value.safeVerifyRevision === "string" &&
    GIT_COMMIT_PATTERN.test(value.safeVerifyRevision) &&
    typeof value.nanodaRevision === "string" &&
    GIT_COMMIT_PATTERN.test(value.nanodaRevision) &&
    typeof value.profileDigest === "string" &&
    isSha256(value.profileDigest)
  );
}

function isCompilerEvidence(value: unknown): value is LeanProofCompilerEvidence {
  if (!isRecord(value) || !validDuration(value.durationMs)) return false;
  if (value.status === "accepted") {
    return (
      hasExactKeys(value, [
        "status",
        "targetDeclaration",
        "statementDigest",
        "environmentDigest",
        "durationMs",
      ]) &&
      typeof value.targetDeclaration === "string" &&
      LEAN_DECLARATION_PATTERN.test(value.targetDeclaration) &&
      typeof value.statementDigest === "string" &&
      isSha256(value.statementDigest) &&
      typeof value.environmentDigest === "string" &&
      isSha256(value.environmentDigest)
    );
  }
  return (
    (value.status === "rejected" || value.status === "unavailable") &&
    hasExactKeys(value, ["status", "reasonCode", "durationMs"]) &&
    validReasonCode(value.reasonCode)
  );
}

function isSafeVerifyEvidence(value: unknown): value is LeanSafeVerifyEvidence {
  if (!isRecord(value) || !validDuration(value.durationMs)) return false;
  if (value.status === "accepted" || value.status === "rejected") {
    return (
      hasExactKeys(value, [
        "status",
        "targetDeclaration",
        "statementDigest",
        "environmentDigest",
        "observedAxioms",
        "reasonCode",
        "durationMs",
      ]) &&
      typeof value.targetDeclaration === "string" &&
      LEAN_DECLARATION_PATTERN.test(value.targetDeclaration) &&
      typeof value.statementDigest === "string" &&
      isSha256(value.statementDigest) &&
      typeof value.environmentDigest === "string" &&
      isSha256(value.environmentDigest) &&
      Array.isArray(value.observedAxioms) &&
      value.observedAxioms.length <= 16 &&
      new Set(value.observedAxioms).size === value.observedAxioms.length &&
      value.observedAxioms.every(
        (axiom) => typeof axiom === "string" && axiom.length > 0 && axiom.length <= 512,
      ) &&
      validReasonCode(value.reasonCode)
    );
  }
  return (
    (value.status === "unavailable" || value.status === "not_run") &&
    hasExactKeys(value, ["status", "reasonCode", "durationMs"]) &&
    validReasonCode(value.reasonCode)
  );
}

function isNanodaEvidence(value: unknown): value is LeanNanodaEvidence {
  if (!isRecord(value) || !validDuration(value.durationMs)) return false;
  if (value.status === "accepted" || value.status === "rejected") {
    return (
      hasExactKeys(value, ["status", "environmentDigest", "reasonCode", "durationMs"]) &&
      typeof value.environmentDigest === "string" &&
      isSha256(value.environmentDigest) &&
      validReasonCode(value.reasonCode)
    );
  }
  return (
    (value.status === "unavailable" || value.status === "not_run") &&
    hasExactKeys(value, ["status", "reasonCode", "durationMs"]) &&
    validReasonCode(value.reasonCode)
  );
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const observed = Object.keys(value);
  return observed.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateFaithfulnessApproval(value: LeanStatementFaithfulnessApproval): void {
  if (
    value.version !== 1 ||
    value.authority !== "human" ||
    !isSha256(value.approverIdentityHash) ||
    !isSha256(value.specificationDigest) ||
    !isSha256(value.statementDigest) ||
    !isCanonicalInstant(value.approvedAt)
  ) {
    throw new LeanProofContractError(
      "invalid_request",
      "statement faithfulness must be exact human approval evidence",
    );
  }
}

function validateProofModel(value: LeanProofModelRoute): void {
  if (
    value.selectionRule !== "exact-model-v1" ||
    value.fallback !== "deny" ||
    value.provider.length === 0 ||
    value.provider.length > 96 ||
    value.provider !== value.provider.trim() ||
    value.model.length === 0 ||
    value.model.length > 256 ||
    value.model !== value.model.trim() ||
    !["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinking)
  ) {
    throw new LeanProofContractError(
      "invalid_request",
      "proof model must be one exact provider and model with deny fallback",
    );
  }
}

function sameSafeVerifyIdentity(
  request: LeanProofRequest,
  evidence: LeanProofExecutionEvidence,
): boolean {
  if (evidence.compiler.status !== "accepted") return false;
  if (evidence.safeVerify.status !== "accepted" && evidence.safeVerify.status !== "rejected") {
    return false;
  }
  return (
    evidence.safeVerify.targetDeclaration === request.targetDeclaration &&
    evidence.safeVerify.statementDigest === request.statementDigest &&
    isSha256(evidence.safeVerify.environmentDigest) &&
    evidence.safeVerify.environmentDigest === evidence.compiler.environmentDigest
  );
}

function hasOnlyAllowedAxioms(observed: readonly string[]): boolean {
  return (
    observed.length <= LEAN_PROOF_ALLOWED_AXIOMS.length &&
    new Set(observed).size === observed.length &&
    observed.every((axiom) => LEAN_PROOF_ALLOWED_AXIOMS.includes(axiom as never))
  );
}

function checkerDisagreement(): LeanProofDecision {
  return decision(
    "inconclusive",
    "the kernel-replay and independent proof checkers disagree",
    "checker_disagreement",
  );
}

function decision(
  verdict: LeanProofDecision["verdict"],
  reason: string,
  reasonCode: LeanProofDecision["reasonCode"],
): LeanProofDecision {
  return Object.freeze({ verdict, reason, reasonCode });
}

function cloneRuntime(value: LeanProofRuntimeIdentity): LeanProofRuntimeIdentity {
  return { ...value };
}

function isCanonicalInstant(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
