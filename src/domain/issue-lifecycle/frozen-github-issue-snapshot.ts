import { z } from "zod";

import { canonicalGitHubRepositoryIdentity } from "./identity.js";
import { calculateIssueLifecycleDomainDigest } from "./private-manifest.js";

export const FROZEN_GITHUB_ISSUE_SNAPSHOT_MEDIA_TYPE =
  "application/vnd.synapti.flow.github-issue-snapshot.v1+json";

const nodeIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim());
const timestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => new Date(value).toISOString() === value);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const repositorySchema = z
  .object({ identity: z.string().min(3).max(201), nodeId: nodeIdSchema })
  .strict();
const issueContentSchema = z
  .object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nodeId: nodeIdSchema,
    updatedAt: timestampSchema,
    title: z.string().max(65_536),
    body: z.string().max(1_048_576),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    repository: repositorySchema,
    issue: issueContentSchema.extend({ contentDigest: sha256Schema }).strict(),
  })
  .strict();

export interface FrozenGitHubIssueSnapshotContent {
  readonly version: 1;
  readonly repository: { readonly identity: string; readonly nodeId: string };
  readonly issue: {
    readonly number: number;
    readonly nodeId: string;
    readonly updatedAt: string;
    readonly title: string;
    readonly body: string;
  };
}

export interface FrozenGitHubIssueSnapshot extends FrozenGitHubIssueSnapshotContent {
  readonly issue: FrozenGitHubIssueSnapshotContent["issue"] & {
    readonly contentDigest: string;
  };
}

export class FrozenGitHubIssueSnapshotError extends Error {
  override readonly name = "FrozenGitHubIssueSnapshotError";
}

/**
 * Digests the canonical logical issue snapshot. The digest field itself is
 * deliberately excluded, so the encoded snapshot has no circular identity.
 */
export function calculateFrozenGitHubIssueContentDigest(
  input: FrozenGitHubIssueSnapshotContent,
): string {
  const content = parseContent(input);
  return calculateIssueLifecycleDomainDigest("flow.github.issue-content.v1", content);
}

export function encodeFrozenGitHubIssueSnapshot(
  input: FrozenGitHubIssueSnapshotContent,
): Uint8Array {
  const content = parseContent(input);
  const snapshot: FrozenGitHubIssueSnapshot = {
    ...content,
    issue: {
      ...content.issue,
      contentDigest: calculateFrozenGitHubIssueContentDigest(content),
    },
  };
  return Buffer.from(JSON.stringify(snapshot), "utf8");
}

export function decodeFrozenGitHubIssueSnapshot(bytes: Uint8Array): FrozenGitHubIssueSnapshot {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new FrozenGitHubIssueSnapshotError("frozen GitHub issue snapshot is not valid JSON", {
      cause: error,
    });
  }
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new FrozenGitHubIssueSnapshotError("frozen GitHub issue snapshot has an invalid shape", {
      cause: parsed.error,
    });
  }
  const snapshot = parsed.data;
  const content = projectContent(snapshot);
  assertCanonicalRepositoryIdentity(content.repository.identity);
  if (snapshot.issue.contentDigest !== calculateFrozenGitHubIssueContentDigest(content)) {
    throw new FrozenGitHubIssueSnapshotError(
      "frozen GitHub issue snapshot content digest does not match its logical content",
    );
  }
  return deepFreeze(structuredClone(snapshot));
}

function parseContent(input: FrozenGitHubIssueSnapshotContent): FrozenGitHubIssueSnapshotContent {
  const projected = projectContent(input);
  const parsed = z
    .object({ version: z.literal(1), repository: repositorySchema, issue: issueContentSchema })
    .strict()
    .safeParse(projected);
  if (!parsed.success) {
    throw new FrozenGitHubIssueSnapshotError("frozen GitHub issue content has an invalid shape", {
      cause: parsed.error,
    });
  }
  assertCanonicalRepositoryIdentity(parsed.data.repository.identity);
  return deepFreeze(structuredClone(parsed.data));
}

function projectContent(input: FrozenGitHubIssueSnapshotContent): FrozenGitHubIssueSnapshotContent {
  return {
    version: input.version,
    repository: {
      identity: input.repository.identity,
      nodeId: input.repository.nodeId,
    },
    issue: {
      number: input.issue.number,
      nodeId: input.issue.nodeId,
      updatedAt: input.issue.updatedAt,
      title: input.issue.title,
      body: input.issue.body,
    },
  };
}

function assertCanonicalRepositoryIdentity(identity: string): void {
  let canonical: string;
  try {
    canonical = canonicalGitHubRepositoryIdentity(identity);
  } catch (error) {
    throw new FrozenGitHubIssueSnapshotError("snapshot repository identity is invalid", {
      cause: error,
    });
  }
  if (canonical !== identity) {
    throw new FrozenGitHubIssueSnapshotError("snapshot repository identity is not canonical");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
