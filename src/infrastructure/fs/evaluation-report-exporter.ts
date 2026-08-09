import { randomUUID } from "node:crypto";
import { link, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type EvaluationExportErrorCode = "exists" | "invalid_value" | "io";

export class EvaluationExportError extends Error {
  override readonly name = "EvaluationExportError";

  constructor(
    readonly code: EvaluationExportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
  }
}

export async function writeCanonicalEvaluationExport(path: string, value: unknown): Promise<void> {
  const requested = resolve(path);
  let parent: string;
  try {
    parent = await realpath(dirname(requested));
  } catch (error) {
    throw new EvaluationExportError("io", `export parent for "${path}" is unavailable`, {
      cause: error,
    });
  }
  const target = join(parent, basename(requested));
  const staging = join(parent, `.${basename(requested)}-${randomUUID()}.pending`);
  let contents: string;
  try {
    contents = `${canonicalJson(value)}\n`;
  } catch (error) {
    throw new EvaluationExportError("invalid_value", "evaluation export is not canonical JSON", {
      cause: error,
    });
  }

  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staging, target);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new EvaluationExportError(
          "exists",
          `refusing to overwrite existing export "${target}"`,
          { cause: error },
        );
      }
      throw error;
    }
    await syncDirectory(parent);
  } catch (error) {
    if (error instanceof EvaluationExportError) {
      throw error;
    }
    throw new EvaluationExportError("io", `failed to publish evaluation export "${target}"`, {
      cause: error,
    });
  } finally {
    await unlink(staging).catch((error: unknown) => {
      if (!(isNodeError(error) && error.code === "ENOENT")) {
        throw error;
      }
    });
  }
  await syncDirectory(parent);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("value is outside canonical JSON");
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
