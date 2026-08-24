import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PREPARATION_OUTPUT_BYTES = 65_536;
const MAX_PREPARATION_DIAGNOSTIC_BYTES = 65_536;

export interface LeanProofOciPreparationResult {
  readonly descriptorPath: string;
  readonly imageDigest: string;
  readonly buildAttestationDigest: string;
  readonly dependencyManifestDigest: string;
  readonly profileDigest: string;
  readonly canonicalTag: string;
}

export async function prepareProductionLeanProofOciRuntime(input: {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
}): Promise<LeanProofOciPreparationResult> {
  input.signal?.throwIfAborted();
  const scriptPath = fileURLToPath(
    new URL("../../../scripts/prepare-proof-runtime.mjs", import.meta.url),
  );
  const output = await runPreparation(scriptPath, input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error("Lean proof preparation returned malformed JSON", { cause: error });
  }
  if (!isPreparationResult(parsed, input.cwd)) {
    throw new Error("Lean proof preparation returned an invalid runtime identity");
  }
  return Object.freeze(structuredClone(parsed));
}

function runPreparation(
  scriptPath: string,
  input: { readonly cwd: string; readonly signal: AbortSignal | undefined },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--project-root", input.cwd], {
      cwd: input.cwd,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const output: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      operation();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= MAX_PREPARATION_OUTPUT_BYTES) output.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes <= MAX_PREPARATION_DIAGNOSTIC_BYTES) diagnostics.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, signal) =>
      settle(() => {
        if (
          code === 0 &&
          outputBytes <= MAX_PREPARATION_OUTPUT_BYTES &&
          diagnosticBytes <= MAX_PREPARATION_DIAGNOSTIC_BYTES
        ) {
          resolve(Buffer.concat(output).toString("utf8").trim());
          return;
        }
        reject(
          new Error(
            `Lean proof preparation failed (${code ?? signal ?? "unknown"}): ${Buffer.concat(
              diagnostics,
            )
              .toString("utf8")
              .slice(-8_192)}`,
          ),
        );
      }),
    );
  });
}

function isPreparationResult(value: unknown, cwd: string): value is LeanProofOciPreparationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const keys = [
    "descriptorPath",
    "imageDigest",
    "buildAttestationDigest",
    "dependencyManifestDigest",
    "profileDigest",
    "canonicalTag",
  ];
  const expectedDescriptorPath = join(resolve(cwd), ".flow", "proof-runtime", "attestation.json");
  return (
    Object.keys(result).length === keys.length &&
    keys.every((key) => Object.hasOwn(result, key)) &&
    result.descriptorPath === expectedDescriptorPath &&
    typeof result.imageDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(result.imageDigest) &&
    typeof result.buildAttestationDigest === "string" &&
    /^[a-f0-9]{64}$/.test(result.buildAttestationDigest) &&
    typeof result.dependencyManifestDigest === "string" &&
    /^[a-f0-9]{64}$/.test(result.dependencyManifestDigest) &&
    typeof result.profileDigest === "string" &&
    /^[a-f0-9]{64}$/.test(result.profileDigest) &&
    result.canonicalTag === `flow-lean-proof:sha256-${result.imageDigest.slice("sha256:".length)}`
  );
}
