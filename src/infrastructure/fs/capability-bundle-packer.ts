import { randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";
import {
  type AgentSkillManifest,
  parseAgentSkillManifest,
} from "../../domain/capability/agent-skill-manifest.js";
import {
  MAX_AGENT_SKILL_FILE_BYTES,
  MAX_AGENT_SKILL_FILES,
  MAX_AGENT_SKILL_PACKAGE_BYTES,
} from "../../domain/capability/agent-skills.js";
import {
  type CapabilityBundleSourcePackage,
  type CreatedCapabilityBundleSource,
  createCapabilityBundleSource,
  MAX_CAPABILITY_BUNDLE_PACKAGES,
} from "../../domain/capability/capability-bundles.js";
import { MAX_POLICY_PACKAGE_MANIFEST_BYTES } from "../../domain/capability/policy-packages.js";
import { MAX_TOOL_PACKAGE_MANIFEST_BYTES } from "../../domain/capability/tool-packages.js";
import {
  MAX_VERIFIER_PACKAGE_MANIFEST_BYTES,
  verifierPackageNameSchema,
  verifierPackageVersionSchema,
} from "../../domain/capability/verifier-packages.js";
import { MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES } from "../../domain/capability/workflow-packages.js";
import { parseStrictJson } from "../../domain/strict-json.js";

const SOURCE_MANIFEST_NAME = "BUNDLE.json";
const MAX_SOURCE_MANIFEST_BYTES = 64 * 1024;
const MAX_SKILL_DEPTH = 6;
const MAX_SOURCE_TREE_ENTRIES = 4_096;
const MAX_PACKER_ERROR_BYTES = 16_384;

const sourceManifestSchema = z
  .object({
    apiVersion: z.literal("flow.synapti.ai/v1alpha1"),
    kind: z.literal("CapabilityBundleSource"),
    metadata: z
      .object({
        name: verifierPackageNameSchema,
        version: verifierPackageVersionSchema,
        description: canonicalText(1024),
        license: canonicalText(1024).optional(),
        compatibility: canonicalText(500).optional(),
      })
      .strict(),
  })
  .strict();

export type CapabilityBundlePackErrorCode =
  | "invalid_source"
  | "unsafe_source"
  | "limit_exceeded"
  | "output_exists"
  | "commit_uncertain"
  | "io";

export class CapabilityBundlePackError extends Error {
  override readonly name = "CapabilityBundlePackError";

  constructor(
    readonly code: CapabilityBundlePackErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(boundedMessage(message), options);
  }
}

export interface CapabilityBundlePackerHooks {
  readonly afterSourceFileOpened?: (path: string) => Promise<void>;
  readonly afterSourceFileCaptured?: (path: string, content: Buffer) => Promise<void>;
  readonly beforeOutputTemporaryUnlink?: () => Promise<void>;
  readonly beforeOutputDirectorySync?: () => Promise<void>;
}

interface SourceTraversalBudget {
  entriesRemaining: number;
  packagesRemaining: number;
}

export async function packCapabilityBundleDirectory(
  sourceDirectory: string,
  outputPath: string,
  hooks: CapabilityBundlePackerHooks = {},
): Promise<CreatedCapabilityBundleSource> {
  const sourceRoot = await canonicalDirectory(sourceDirectory, "capability bundle source");
  const budget: SourceTraversalBudget = {
    entriesRemaining: MAX_SOURCE_TREE_ENTRIES,
    packagesRemaining: MAX_CAPABILITY_BUNDLE_PACKAGES,
  };
  const entries = await readDirectory(sourceRoot, budget);
  for (const entry of entries) {
    if (
      ![SOURCE_MANIFEST_NAME, "skills", "verifiers", "tools", "workflows", "policies"].includes(
        entry.name,
      )
    ) {
      throw unsafeError(`unsupported capability bundle source entry "${entry.name}"`);
    }
    if (entry.isSymbolicLink()) {
      throw unsafeError(`capability bundle source refuses symbolic link "${entry.name}"`);
    }
  }
  const sourceManifestEntry = entries.find((entry) => entry.name === SOURCE_MANIFEST_NAME);
  if (sourceManifestEntry === undefined || !sourceManifestEntry.isFile()) {
    throw invalidSource(`capability bundle source requires regular ${SOURCE_MANIFEST_NAME}`);
  }
  const manifest = await readSourceManifest(
    join(sourceRoot, SOURCE_MANIFEST_NAME),
    sourceRoot,
    hooks,
  );
  const packages: CapabilityBundleSourcePackage[] = [];
  await collectAgentSkills(sourceRoot, entries, packages, budget, hooks);
  await collectManifestPackages(
    sourceRoot,
    entries,
    "verifiers",
    "VERIFIER.yaml",
    "verifier-package",
    MAX_VERIFIER_PACKAGE_MANIFEST_BYTES,
    packages,
    budget,
    hooks,
  );
  await collectManifestPackages(
    sourceRoot,
    entries,
    "workflows",
    "WORKFLOW.yaml",
    "workflow-package",
    MAX_WORKFLOW_PACKAGE_MANIFEST_BYTES,
    packages,
    budget,
    hooks,
  );
  await collectManifestPackages(
    sourceRoot,
    entries,
    "tools",
    "TOOL.yaml",
    "tool-package",
    MAX_TOOL_PACKAGE_MANIFEST_BYTES,
    packages,
    budget,
    hooks,
  );
  await collectManifestPackages(
    sourceRoot,
    entries,
    "policies",
    "POLICY.yaml",
    "policy-package",
    MAX_POLICY_PACKAGE_MANIFEST_BYTES,
    packages,
    budget,
    hooks,
  );
  if (packages.length === 0) {
    throw invalidSource("capability bundle source must contain at least one package");
  }
  let created: CreatedCapabilityBundleSource;
  try {
    created = createCapabilityBundleSource({
      name: manifest.metadata.name,
      version: manifest.metadata.version,
      description: manifest.metadata.description,
      ...(manifest.metadata.license === undefined ? {} : { license: manifest.metadata.license }),
      ...(manifest.metadata.compatibility === undefined
        ? {}
        : { compatibility: manifest.metadata.compatibility }),
      packages,
    });
  } catch (error) {
    throw invalidSource(
      `capability bundle source packages are invalid: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  await publishOutput(sourceRoot, outputPath, created.content, hooks);
  return created;
}

async function readSourceManifest(path: string, root: string, hooks: CapabilityBundlePackerHooks) {
  const content = await readRegularFile(path, root, MAX_SOURCE_MANIFEST_BYTES, false, hooks);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw invalidSource(`${SOURCE_MANIFEST_NAME} must be valid UTF-8`, error);
  }
  try {
    return sourceManifestSchema.parse(
      parseStrictJson(text, {
        maxDepth: 8,
        maxNodes: 128,
        valueLabel: "capability bundle source manifest",
      }),
    );
  } catch (error) {
    throw invalidSource(
      `${SOURCE_MANIFEST_NAME} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

async function collectAgentSkills(
  sourceRoot: string,
  rootEntries: readonly Dirent[],
  packages: CapabilityBundleSourcePackage[],
  budget: SourceTraversalBudget,
  hooks: CapabilityBundlePackerHooks,
): Promise<void> {
  const skillsEntry = rootEntries.find((entry) => entry.name === "skills");
  if (skillsEntry === undefined) {
    return;
  }
  if (!skillsEntry.isDirectory()) {
    throw unsafeError('capability bundle source "skills" must be a real directory');
  }
  const skillsRoot = join(sourceRoot, "skills");
  for (const entry of await readDirectory(skillsRoot, budget)) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw unsafeError(`Agent Skill source "${entry.name}" must be a real directory`);
    }
    reservePackage(budget);
    const packageRoot = join(skillsRoot, entry.name);
    const files: Array<{ readonly path: string; readonly content: Uint8Array }> = [];
    await collectSkillFiles(skillsRoot, packageRoot, packageRoot, 0, files, budget, hooks);
    files.sort((left, right) => compareStrings(left.path, right.path));
    const manifest = files.find((file) => file.path === "SKILL.md");
    if (manifest === undefined) {
      throw invalidSource(`Agent Skill source "${entry.name}" is missing SKILL.md`);
    }
    let parsed: AgentSkillManifest;
    try {
      parsed = parseAgentSkillManifest(manifest.content, `Agent Skill source "${entry.name}"`);
    } catch (error) {
      throw invalidSource(
        `Agent Skill source "${entry.name}" is invalid: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    if (parsed.name !== entry.name) {
      throw invalidSource(
        `Agent Skill source directory "${entry.name}" does not match manifest name "${parsed.name}"`,
      );
    }
    packages.push({ kind: "agent-skill", files });
  }
}

async function collectSkillFiles(
  skillsRoot: string,
  packageRoot: string,
  directory: string,
  depth: number,
  files: Array<{ readonly path: string; readonly content: Uint8Array }>,
  budget: SourceTraversalBudget,
  hooks: CapabilityBundlePackerHooks,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) {
    throw new CapabilityBundlePackError(
      "limit_exceeded",
      `Agent Skill source exceeds depth ${MAX_SKILL_DEPTH}`,
    );
  }
  for (const entry of await readDirectory(directory, budget)) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw unsafeError(`Agent Skill source refuses symbolic link "${path}"`);
    }
    if (entry.isDirectory()) {
      await collectSkillFiles(skillsRoot, packageRoot, path, depth + 1, files, budget, hooks);
      continue;
    }
    if (!entry.isFile()) {
      throw unsafeError(`Agent Skill source entry "${path}" must be a regular file or directory`);
    }
    if (files.length >= MAX_AGENT_SKILL_FILES) {
      throw new CapabilityBundlePackError(
        "limit_exceeded",
        `Agent Skill source exceeds ${MAX_AGENT_SKILL_FILES} files`,
      );
    }
    const content = await readRegularFile(
      path,
      skillsRoot,
      MAX_AGENT_SKILL_FILE_BYTES,
      true,
      hooks,
    );
    files.push({ path: portableRelative(packageRoot, path), content });
    const total = files.reduce((bytes, file) => bytes + file.content.byteLength, 0);
    if (total > MAX_AGENT_SKILL_PACKAGE_BYTES) {
      throw new CapabilityBundlePackError(
        "limit_exceeded",
        `Agent Skill source exceeds ${MAX_AGENT_SKILL_PACKAGE_BYTES} bytes`,
      );
    }
  }
}

async function collectManifestPackages(
  sourceRoot: string,
  rootEntries: readonly Dirent[],
  rootName: "verifiers" | "tools" | "workflows" | "policies",
  manifestName: "VERIFIER.yaml" | "TOOL.yaml" | "WORKFLOW.yaml" | "POLICY.yaml",
  kind: "verifier-package" | "tool-package" | "workflow-package" | "policy-package",
  maximumBytes: number,
  packages: CapabilityBundleSourcePackage[],
  budget: SourceTraversalBudget,
  hooks: CapabilityBundlePackerHooks,
): Promise<void> {
  const rootEntry = rootEntries.find((entry) => entry.name === rootName);
  if (rootEntry === undefined) {
    return;
  }
  if (!rootEntry.isDirectory()) {
    throw unsafeError(`capability bundle source "${rootName}" must be a real directory`);
  }
  const catalogRoot = join(sourceRoot, rootName);
  for (const entry of await readDirectory(catalogRoot, budget)) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw unsafeError(`${kind} source "${entry.name}" must be a real directory`);
    }
    reservePackage(budget);
    const packageRoot = join(catalogRoot, entry.name);
    const packageEntries = await readDirectory(packageRoot, budget);
    if (
      packageEntries.length !== 1 ||
      packageEntries[0]?.name !== manifestName ||
      packageEntries[0].isSymbolicLink() ||
      !packageEntries[0].isFile()
    ) {
      throw unsafeError(`${kind} source "${entry.name}" must contain only ${manifestName}`);
    }
    packages.push({
      kind,
      manifest: await readRegularFile(
        join(packageRoot, manifestName),
        catalogRoot,
        maximumBytes,
        false,
        hooks,
      ),
    });
  }
}

async function publishOutput(
  sourceRoot: string,
  outputPath: string,
  content: Buffer,
  hooks: CapabilityBundlePackerHooks,
): Promise<void> {
  const requestedOutput = resolve(outputPath);
  const outputDirectory = await canonicalDirectory(
    dirname(requestedOutput),
    "bundle output directory",
  );
  const target = join(outputDirectory, basename(requestedOutput));
  if (isWithin(target, sourceRoot)) {
    throw unsafeError("capability bundle output must be outside its source directory");
  }
  const temporary = join(outputDirectory, `.flowpkg.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let linked = false;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new CapabilityBundlePackError(
          "output_exists",
          `capability bundle output already exists at ${JSON.stringify(target)}`,
          { cause: error },
        );
      }
      throw error;
    }
    linked = true;
    await hooks.beforeOutputTemporaryUnlink?.();
    await unlink(temporary);
    await hooks.beforeOutputDirectorySync?.();
    await syncDirectory(outputDirectory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (linked) {
      throw new CapabilityBundlePackError(
        "commit_uncertain",
        `capability bundle output is visible at ${JSON.stringify(target)} but publication durability could not be confirmed`,
        { cause: error },
      );
    }
    if (error instanceof CapabilityBundlePackError) {
      throw error;
    }
    throw new CapabilityBundlePackError("io", "could not publish capability bundle output", {
      cause: error,
    });
  }
}

async function readRegularFile(
  path: string,
  root: string,
  maximumBytes: number,
  allowEmpty: boolean,
  hooks: CapabilityBundlePackerHooks,
): Promise<Buffer> {
  const before = await safeLstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw unsafeError(`capability bundle source file "${path}" must be a regular file`);
  }
  if ((!allowEmpty && before.size === 0n) || before.size > BigInt(maximumBytes)) {
    throw new CapabilityBundlePackError(
      "limit_exceeded",
      `capability bundle source file "${path}" must contain ${allowEmpty ? "0" : "1"}-${maximumBytes} bytes`,
    );
  }
  const canonical = await realpath(path).catch((error: unknown) => {
    throw new CapabilityBundlePackError("io", `could not resolve source file "${path}"`, {
      cause: error,
    });
  });
  assertWithin(canonical, root);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw unsafeError(`capability bundle source file "${path}" changed before capture`);
    }
    await hooks.afterSourceFileOpened?.(path);
    const content = await readBoundedHandle(handle, maximumBytes);
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, after) || BigInt(content.byteLength) !== after.size) {
      throw unsafeError(`capability bundle source file "${path}" changed during capture`);
    }
    const retained = exactBuffer(content);
    await hooks.afterSourceFileCaptured?.(path, retained);
    return retained;
  } catch (error) {
    if (error instanceof CapabilityBundlePackError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ELOOP") {
      throw unsafeError(`capability bundle source file "${path}" must not be a symbolic link`);
    }
    throw new CapabilityBundlePackError("io", `could not read source file "${path}"`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    const metadata = await lstat(canonical);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw unsafeError(`${label} must be a real directory`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof CapabilityBundlePackError) {
      throw error;
    }
    throw new CapabilityBundlePackError("io", `${label} is unavailable`, { cause: error });
  }
}

async function readDirectory(path: string, budget: SourceTraversalBudget): Promise<Dirent[]> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  let primaryFailure = false;
  try {
    directory = await opendir(path);
    const entries: Dirent[] = [];
    while (true) {
      const entry = await directory.read();
      if (entry === null) {
        break;
      }
      if (budget.entriesRemaining < 1) {
        throw new CapabilityBundlePackError(
          "limit_exceeded",
          `capability bundle source exceeds ${MAX_SOURCE_TREE_ENTRIES} directory entries`,
        );
      }
      budget.entriesRemaining -= 1;
      entries.push(entry);
    }
    return entries.sort((left, right) => compareStrings(left.name, right.name));
  } catch (error) {
    primaryFailure = true;
    if (error instanceof CapabilityBundlePackError) {
      throw error;
    }
    throw new CapabilityBundlePackError("io", `could not read source directory "${path}"`, {
      cause: error,
    });
  } finally {
    await directory?.close().catch((error: unknown) => {
      if (
        !primaryFailure &&
        !(isNodeError(error) && (error.code === "ERR_DIR_CLOSED" || error.code === "EBADF"))
      ) {
        throw new CapabilityBundlePackError("io", `could not close source directory "${path}"`, {
          cause: error,
        });
      }
    });
  }
}

async function safeLstat(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new CapabilityBundlePackError("io", `could not inspect source path "${path}"`, {
      cause: error,
    });
  }
}

function assertWithin(path: string, root: string): void {
  if (!isWithin(path, root)) {
    throw unsafeError(`capability bundle source path "${path}" escapes "${root}"`);
  }
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (value.length === 0 || !isWithin(path, root)) {
    throw unsafeError(`capability bundle source path "${path}" is outside "${root}"`);
  }
  return value.split(sep).join("/");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function canonicalText(maximumLength: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value === value.trim(), "must not have surrounding whitespace");
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readBoundedHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  if (offset > maximumBytes) {
    throw new CapabilityBundlePackError(
      "limit_exceeded",
      `capability bundle source file exceeded ${maximumBytes} bytes during capture`,
    );
  }
  return buffer.subarray(0, offset);
}

function reservePackage(budget: SourceTraversalBudget): void {
  if (budget.packagesRemaining < 1) {
    throw new CapabilityBundlePackError(
      "limit_exceeded",
      `capability bundle source exceeds ${MAX_CAPABILITY_BUNDLE_PACKAGES} packages`,
    );
  }
  budget.packagesRemaining -= 1;
}

function exactBuffer(content: Buffer): Buffer {
  if (content.byteLength === 0) {
    return Buffer.alloc(0);
  }
  const exact = Buffer.allocUnsafeSlow(content.byteLength);
  content.copy(exact);
  return exact;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidSource(message: string, cause?: unknown): CapabilityBundlePackError {
  return new CapabilityBundlePackError(
    "invalid_source",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function unsafeError(message: string): CapabilityBundlePackError {
  return new CapabilityBundlePackError("unsafe_source", message);
}

function boundedMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  return bytes.byteLength <= MAX_PACKER_ERROR_BYTES
    ? message
    : `${bytes.subarray(0, MAX_PACKER_ERROR_BYTES - 24).toString("utf8")}… [truncated]`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
