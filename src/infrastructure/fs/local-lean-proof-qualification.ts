import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  type LeanProofQualificationInput,
  LeanProofQualificationError,
  MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES,
  parseLeanProofQualificationInput,
} from "../../domain/evaluation/lean-proof-qualification.js";

export async function loadLocalLeanProofQualificationInput(
  path: string,
  signal?: AbortSignal,
): Promise<LeanProofQualificationInput> {
  signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new LeanProofQualificationError(
        "Lean proof qualification input must be a regular file",
      );
    }
    if (before.size > BigInt(MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES)) {
      throw inputLimitError();
    }
    const bytes = await readBounded(handle, signal);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new LeanProofQualificationError("Lean proof qualification input changed while reading");
    }

    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new LeanProofQualificationError(
        "Lean proof qualification input must contain valid UTF-8",
        { cause: error },
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch (error) {
      throw new LeanProofQualificationError(
        "Lean proof qualification input must contain valid JSON",
        { cause: error },
      );
    }
    return parseLeanProofQualificationInput(input);
  } finally {
    await handle.close();
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES) {
    signal?.throwIfAborted();
    const remaining = MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES) throw inputLimitError();
  return Buffer.concat(chunks, total);
}

function inputLimitError(): LeanProofQualificationError {
  return new LeanProofQualificationError(
    `Lean proof qualification input must not exceed ${MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES} UTF-8 bytes`,
  );
}
