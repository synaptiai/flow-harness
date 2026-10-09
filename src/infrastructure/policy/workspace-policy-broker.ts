import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { PolicyBroker } from "../../domain/policy/broker.js";
import type { PolicyAction } from "../../domain/policy/types.js";

const PRIVATE_KEY_FILE_NAMES = new Set(["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"]);
type WorkspacePolicyAction = Extract<PolicyAction, `filesystem.${string}`>;

export class WorkspacePolicyBroker {
  constructor(
    readonly canonicalRoot: string,
    readonly policy: PolicyBroker,
    readonly protectedWritePaths: readonly string[] = [],
    readonly allowedLexicalWritePrefixes?: readonly string[],
    readonly allowedCanonicalWritePrefixes?: readonly string[],
  ) {}

  async execute<T>(
    action: WorkspacePolicyAction,
    inputPath: string,
    effect: (canonicalTarget: string) => Promise<T>,
    options: { readonly operationDigest?: string } = {},
  ): Promise<T> {
    const resolved = await resolveWorkspaceTarget(this.canonicalRoot, inputPath);
    const outsideWriteAllowlist =
      isWriteAction(action) &&
      this.allowedLexicalWritePrefixes !== undefined &&
      this.allowedCanonicalWritePrefixes !== undefined &&
      (!this.allowedLexicalWritePrefixes.some((prefix) =>
        isAtOrWithin(resolved.lexicalTarget, prefix),
      ) ||
        !this.allowedCanonicalWritePrefixes.some((prefix) =>
          isAtOrWithin(resolved.target, prefix),
        ));
    const boundary =
      resolved.boundary === "inside" &&
      (outsideWriteAllowlist ||
        isProtectedTarget(
          this.canonicalRoot,
          resolved.lexicalTarget,
          this.protectedWritePaths,
          action,
        ) ||
        isProtectedTarget(this.canonicalRoot, resolved.target, this.protectedWritePaths, action))
        ? "protected"
        : resolved.boundary;
    if (action === "filesystem.write") {
      this.policy.authorize({
        action,
        target: resolved.target,
        boundary,
        operationDigest: options.operationDigest ?? "",
      });
    } else {
      this.policy.authorize({
        action,
        target: resolved.target,
        boundary,
        ...(options.operationDigest === undefined
          ? {}
          : { operationDigest: options.operationDigest }),
      });
    }
    return await effect(resolved.target);
  }
}

export async function createWorkspacePolicyBroker(
  cwd: string,
  policy: PolicyBroker,
  protectedWritePaths: readonly string[] = [],
  allowedWritePrefixes?: readonly string[],
): Promise<WorkspacePolicyBroker> {
  const canonicalRoot = await realpath(cwd);
  const canonicalProtectedPaths = await Promise.all(
    protectedWritePaths.map((path) => canonicalizeExistingAncestor(resolve(canonicalRoot, path))),
  );
  const lexicalWritePrefixes = allowedWritePrefixes?.map((prefix) => {
    const segments = validateCanonicalWritePrefix(prefix);
    const target = resolve(canonicalRoot, prefix);
    if (!isWithinRoot(canonicalRoot, target)) {
      throw new TypeError(`workspace write prefix "${prefix}" escapes the workspace`);
    }
    return { prefix, segments, target };
  });
  if (lexicalWritePrefixes !== undefined) {
    for (const { prefix, segments } of lexicalWritePrefixes) {
      await assertNoSymlinkPrefixComponent(canonicalRoot, prefix, segments);
    }
  }
  const lexicalWritePrefixTargets = lexicalWritePrefixes?.map(({ target }) => target);
  const canonicalWritePrefixes =
    lexicalWritePrefixTargets === undefined
      ? undefined
      : await Promise.all(lexicalWritePrefixTargets.map(canonicalizeExistingAncestor));
  return new WorkspacePolicyBroker(
    canonicalRoot,
    policy,
    Object.freeze(canonicalProtectedPaths),
    lexicalWritePrefixTargets === undefined ? undefined : Object.freeze(lexicalWritePrefixTargets),
    canonicalWritePrefixes === undefined ? undefined : Object.freeze(canonicalWritePrefixes),
  );
}

function validateCanonicalWritePrefix(prefix: string): readonly string[] {
  const segments = prefix.split("/");
  if (
    prefix.length === 0 ||
    isAbsolute(prefix) ||
    prefix.includes("\\") ||
    prefix.includes("\0") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError(`workspace write prefix "${prefix}" must be a canonical relative path`);
  }
  return segments;
}

async function assertNoSymlinkPrefixComponent(
  canonicalRoot: string,
  prefix: string,
  segments: readonly string[],
): Promise<void> {
  let candidate = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    candidate = resolve(candidate, segment);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new TypeError(`workspace write prefix "${prefix}" contains a symlink component`);
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw new TypeError(
          `workspace write prefix "${prefix}" contains a non-directory component`,
        );
      }
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

interface ResolvedWorkspaceTarget {
  readonly lexicalTarget: string;
  readonly target: string;
  readonly boundary: "inside" | "outside" | "unresolved";
}

async function resolveWorkspaceTarget(
  canonicalRoot: string,
  inputPath: string,
): Promise<ResolvedWorkspaceTarget> {
  const root = resolve(canonicalRoot);
  const lexicalTarget = resolve(root, inputPath);
  if (!isAbsolute(inputPath) && !isWithinRoot(root, lexicalTarget)) {
    return { lexicalTarget, target: lexicalTarget, boundary: "outside" };
  }

  try {
    const canonicalTarget = await canonicalizeExistingAncestor(lexicalTarget);
    return {
      lexicalTarget,
      target: canonicalTarget,
      boundary: isWithinRoot(root, canonicalTarget) ? "inside" : "outside",
    };
  } catch {
    return { lexicalTarget, target: lexicalTarget, boundary: "unresolved" };
  }
}

async function canonicalizeExistingAncestor(target: string): Promise<string> {
  let candidate = target;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalAncestor = await realpath(candidate);
      return resolve(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function isWriteAction(action: PolicyAction): boolean {
  return action === "filesystem.write" || action === "filesystem.delete";
}

function isProtectedTarget(
  root: string,
  target: string,
  protectedWritePaths: readonly string[],
  action: WorkspacePolicyAction,
): boolean {
  if (protectedWritePaths.some((protectedPath) => isAtOrWithin(target, protectedPath))) {
    return true;
  }
  const fromRoot = relative(root, target);
  const segments = fromRoot.split(sep);
  if (
    segments.includes(".flow") ||
    segments.some(isFlowWorkspaceCollectionName) ||
    (segments.includes(".git") && isWriteAction(action))
  ) {
    return true;
  }
  return isSensitiveWorkspacePath(target);
}

export function isSensitiveWorkspacePath(target: string): boolean {
  const targetName = basename(target).toLowerCase();
  return (
    targetName === ".env" ||
    targetName.startsWith(".env.") ||
    targetName === ".envrc" ||
    targetName.startsWith(".envrc.") ||
    PRIVATE_KEY_FILE_NAMES.has(targetName) ||
    targetName.endsWith(".pem") ||
    targetName.endsWith(".key") ||
    targetName.endsWith(".p12") ||
    targetName.endsWith(".pfx")
  );
}

export function isFlowWorkspaceCollectionName(name: string): boolean {
  return (
    name === ".flow-workspaces" ||
    (name.startsWith(".") && name.endsWith(".flow-workspaces") && name.length > 17)
  );
}

function isAtOrWithin(path: string, directory: string): boolean {
  const fromDirectory = relative(directory, path);
  return (
    fromDirectory === "" ||
    (fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`) && !isAbsolute(fromDirectory))
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
