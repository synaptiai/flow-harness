import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RenderedPublicCapabilityReference } from "../../application/public-capability-reference.js";
import { PUBLIC_CAPABILITY_CATALOG_VERSION } from "../../domain/capability/public-capability-reference.js";

export const PUBLIC_CAPABILITY_REFERENCE_PATHS = Object.freeze({
  json: "docs/specs/flow-public-capability-catalog-v1.json",
  markdown: "docs/reference/tools-and-capabilities.md",
});
export const MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES = 4 * 1024 * 1024;

const SAFE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export class PublicCapabilityReferenceDriftError extends Error {
  override readonly name = "PublicCapabilityReferenceDriftError";

  constructor(readonly stalePaths: readonly string[]) {
    super(
      `public capability reference is stale: ${stalePaths.join(", ")}; run npm run docs:capabilities:generate`,
    );
  }
}

export class PublicCapabilityReferenceFileSafetyError extends Error {
  override readonly name = "PublicCapabilityReferenceFileSafetyError";

  constructor(
    readonly relativePath: string,
    reason: string,
  ) {
    super(`unsafe public capability reference path "${relativePath}": ${reason}`);
  }
}

export interface PublicCapabilityReferenceFileHooks {
  readonly rename?: (source: string, destination: string) => Promise<void>;
}

export async function verifyPublicCapabilityReferenceFiles(
  root: string,
  rendered: RenderedPublicCapabilityReference,
): Promise<void> {
  validateRenderedReference(rendered);
  const targets = await referenceTargets(root, false);
  const expected = [Buffer.from(rendered.json, "utf8"), Buffer.from(rendered.markdown, "utf8")];
  const actual = await Promise.all([
    targets.jsonParentReady
      ? readOptional(
          targets.json,
          PUBLIC_CAPABILITY_REFERENCE_PATHS.json,
          MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES,
          true,
        )
      : undefined,
    targets.markdownParentReady
      ? readOptional(
          targets.markdown,
          PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown,
          MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES,
          true,
        )
      : undefined,
  ]);
  const stalePaths = [
    PUBLIC_CAPABILITY_REFERENCE_PATHS.json,
    PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown,
  ].filter((_path, index) => actual[index]?.equals(expected[index] as Buffer) !== true);
  if (stalePaths.length > 0) {
    throw new PublicCapabilityReferenceDriftError(Object.freeze(stalePaths));
  }
}

export async function writePublicCapabilityReferenceFiles(
  root: string,
  rendered: RenderedPublicCapabilityReference,
  hooks: PublicCapabilityReferenceFileHooks = {},
): Promise<void> {
  validateRenderedReference(rendered);
  const targets = await referenceTargets(root, true);
  const originals = {
    json: await readOptional(
      targets.json,
      PUBLIC_CAPABILITY_REFERENCE_PATHS.json,
      MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES,
    ),
    markdown: await readOptional(
      targets.markdown,
      PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown,
      MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES,
    ),
  };

  const nonce = `${process.pid}-${randomUUID()}`;
  const temporary = {
    json: join(dirname(targets.json), `.flow-public-capabilities-${nonce}.json.tmp`),
    markdown: join(dirname(targets.markdown), `.flow-public-capabilities-${nonce}.md.tmp`),
  };
  const renameFile = hooks.rename ?? rename;
  let jsonCommitted = false;
  try {
    await Promise.all([
      writeFile(temporary.json, rendered.json, { encoding: "utf8", flag: "wx", mode: 0o644 }),
      writeFile(temporary.markdown, rendered.markdown, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      }),
    ]);
    await renameFile(temporary.json, targets.json);
    jsonCommitted = true;
    await renameFile(temporary.markdown, targets.markdown);
  } catch (error) {
    if (jsonCommitted) {
      try {
        await restoreOriginal(targets.json, originals.json, renameFile, nonce);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "public capability reference publication failed and JSON rollback was unsuccessful",
        );
      }
    }
    throw error;
  } finally {
    await Promise.all([
      rm(temporary.json, { force: true }),
      rm(temporary.markdown, { force: true }),
    ]);
  }
}

async function referenceTargets(
  root: string,
  createParents: boolean,
): Promise<{
  readonly json: string;
  readonly markdown: string;
  readonly jsonParentReady: boolean;
  readonly markdownParentReady: boolean;
}> {
  const resolvedRoot = await realpath(resolve(root));
  const jsonParentReady = await ensureSafeDirectoryChain(
    resolvedRoot,
    dirname(PUBLIC_CAPABILITY_REFERENCE_PATHS.json),
    createParents,
  );
  const markdownParentReady = await ensureSafeDirectoryChain(
    resolvedRoot,
    dirname(PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown),
    createParents,
  );
  return Object.freeze({
    json: join(resolvedRoot, PUBLIC_CAPABILITY_REFERENCE_PATHS.json),
    markdown: join(resolvedRoot, PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown),
    jsonParentReady,
    markdownParentReady,
  });
}

async function restoreOriginal(
  target: string,
  original: Buffer | undefined,
  renameFile: (source: string, destination: string) => Promise<void>,
  nonce: string,
): Promise<void> {
  if (original === undefined) {
    await rm(target, { force: true });
    return;
  }
  const rollback = join(dirname(target), `.flow-public-capabilities-${nonce}.rollback.tmp`);
  try {
    await writeFile(rollback, original, { flag: "wx", mode: 0o644 });
    await renameFile(rollback, target);
  } finally {
    await rm(rollback, { force: true });
  }
}

async function ensureSafeDirectoryChain(
  root: string,
  relativeDirectory: string,
  create: boolean,
): Promise<boolean> {
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    current = join(current, segment);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      if (!create) {
        return false;
      }
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) {
      throw new PublicCapabilityReferenceFileSafetyError(
        relativeDirectory,
        "ancestor is a symbolic link",
      );
    }
    if (!metadata.isDirectory()) {
      throw new PublicCapabilityReferenceFileSafetyError(
        relativeDirectory,
        "ancestor is not a directory",
      );
    }
    if ((await realpath(current)) !== current) {
      throw new PublicCapabilityReferenceFileSafetyError(
        relativeDirectory,
        "ancestor resolves outside its canonical path",
      );
    }
  }
  return true;
}

async function readOptional(
  path: string,
  relativePath: string,
  maximumBytes: number,
  oversizedAsMissing = false,
): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, SAFE_READ_FLAGS);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new PublicCapabilityReferenceFileSafetyError(relativePath, "target is a symbolic link");
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new PublicCapabilityReferenceFileSafetyError(
        relativePath,
        "target is not a regular file",
      );
    }
    if (metadata.size > maximumBytes) {
      if (oversizedAsMissing) {
        return undefined;
      }
      throw new PublicCapabilityReferenceFileSafetyError(
        relativePath,
        `target exceeds the ${maximumBytes}-byte safe size limit`,
      );
    }
    return await readBounded(handle, relativePath, maximumBytes, oversizedAsMissing);
  } finally {
    await handle.close();
  }
}

async function readBounded(
  handle: FileHandle,
  relativePath: string,
  maximumBytes: number,
  oversizedAsMissing: boolean,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const remaining = maximumBytes + 1 - total;
    if (remaining <= 0) {
      if (oversizedAsMissing) {
        return undefined;
      }
      throw new PublicCapabilityReferenceFileSafetyError(
        relativePath,
        `target exceeds the ${maximumBytes}-byte safe size limit`,
      );
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
}

function validateRenderedReference(rendered: RenderedPublicCapabilityReference): void {
  if (
    Buffer.byteLength(rendered.json, "utf8") > MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES ||
    Buffer.byteLength(rendered.markdown, "utf8") > MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES
  ) {
    throw new TypeError(
      `public capability reference exceeds the ${MAX_PUBLIC_CAPABILITY_REFERENCE_ARTIFACT_BYTES}-byte artifact byte limit`,
    );
  }
  if (!rendered.json.endsWith("\n") || !rendered.markdown.endsWith("\n")) {
    throw new TypeError("public capability reference artifacts must end with one newline");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered.json);
  } catch (error) {
    throw new TypeError("public capability reference JSON must be valid", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== PUBLIC_CAPABILITY_CATALOG_VERSION
  ) {
    throw new TypeError(
      `public capability reference JSON must use version "${PUBLIC_CAPABILITY_CATALOG_VERSION}"`,
    );
  }
  if (rendered.json !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new TypeError("public capability reference JSON must use canonical pretty formatting");
  }
  if (!rendered.markdown.startsWith("<!-- Generated file. Do not edit directly. -->\n")) {
    throw new TypeError("public capability Markdown must contain the generated-file notice");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
