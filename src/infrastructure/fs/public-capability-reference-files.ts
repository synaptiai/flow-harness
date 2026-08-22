import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RenderedPublicCapabilityReference } from "../../application/public-capability-reference.js";
import { PUBLIC_CAPABILITY_CATALOG_VERSION } from "../../domain/capability/public-capability-reference.js";

export const PUBLIC_CAPABILITY_REFERENCE_PATHS = Object.freeze({
  json: "docs/specs/flow-public-capability-catalog-v1.json",
  markdown: "docs/reference/tools-and-capabilities.md",
});

export class PublicCapabilityReferenceDriftError extends Error {
  override readonly name = "PublicCapabilityReferenceDriftError";

  constructor(readonly stalePaths: readonly string[]) {
    super(
      `public capability reference is stale: ${stalePaths.join(", ")}; run npm run docs:capabilities:generate`,
    );
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
  const targets = referenceTargets(root);
  const expected = [Buffer.from(rendered.json, "utf8"), Buffer.from(rendered.markdown, "utf8")];
  const actual = await Promise.all([readOptional(targets.json), readOptional(targets.markdown)]);
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
  const targets = referenceTargets(root);
  const originals = {
    json: await readOptional(targets.json),
    markdown: await readOptional(targets.markdown),
  };
  await Promise.all([
    mkdir(dirname(targets.json), { recursive: true }),
    mkdir(dirname(targets.markdown), { recursive: true }),
  ]);

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

function referenceTargets(root: string): { readonly json: string; readonly markdown: string } {
  const resolvedRoot = resolve(root);
  return Object.freeze({
    json: join(resolvedRoot, PUBLIC_CAPABILITY_REFERENCE_PATHS.json),
    markdown: join(resolvedRoot, PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown),
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

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function validateRenderedReference(rendered: RenderedPublicCapabilityReference): void {
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
