import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { PolicyBroker } from "../../domain/policy/broker.js";
import type { PolicyAction } from "../../domain/policy/types.js";

export class WorkspacePolicyBroker {
  constructor(
    readonly canonicalRoot: string,
    readonly policy: PolicyBroker,
  ) {}

  async execute<T>(
    action: PolicyAction,
    inputPath: string,
    effect: (canonicalTarget: string) => Promise<T>,
  ): Promise<T> {
    const resolved = await resolveWorkspaceTarget(this.canonicalRoot, inputPath);
    this.policy.authorize({ action, target: resolved.target, boundary: resolved.boundary });
    return await effect(resolved.target);
  }
}

export async function createWorkspacePolicyBroker(
  cwd: string,
  policy: PolicyBroker,
): Promise<WorkspacePolicyBroker> {
  return new WorkspacePolicyBroker(await realpath(cwd), policy);
}

interface ResolvedWorkspaceTarget {
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
    return { target: lexicalTarget, boundary: "outside" };
  }

  try {
    const canonicalTarget = await canonicalizeExistingAncestor(lexicalTarget);
    return {
      target: canonicalTarget,
      boundary: isWithinRoot(root, canonicalTarget) ? "inside" : "outside",
    };
  } catch {
    return { target: lexicalTarget, boundary: "unresolved" };
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

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
