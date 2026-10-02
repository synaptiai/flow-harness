import { z } from "zod";

import { canonicalGitHubRepositoryIdentity, parseGitHubIssueUrl } from "./identity.js";
import { calculateIssueLifecycleDomainDigest } from "./private-manifest.js";

export const MAX_ISSUE_COMMAND_ACTOR_BYTES = 256;
export const MAX_ISSUE_COMMAND_REASON_BYTES = 2_048;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/);
const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a canonical lowercase UUID",
  )
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000", "must not be nil");
const repositoryIdentitySchema = z.string().transform((value, context) => {
  try {
    return canonicalGitHubRepositoryIdentity(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const issueUrlSchema = z.string().transform((value, context) => {
  try {
    return parseGitHubIssueUrl(value).canonicalUrl;
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});
const actorSchema = z
  .string()
  .min(1)
  .max(MAX_ISSUE_COMMAND_ACTOR_BYTES)
  .refine(
    (value) =>
      value === value.trim() &&
      Buffer.byteLength(value, "utf8") <= MAX_ISSUE_COMMAND_ACTOR_BYTES &&
      !/[\p{Cc}\p{Cf}]/u.test(value),
    "actor must be bounded, trimmed, and free of control or format characters",
  );
const reasonSchema = z
  .string()
  .min(1)
  .max(MAX_ISSUE_COMMAND_REASON_BYTES)
  .refine(
    (value) =>
      value === value.trim() &&
      Buffer.byteLength(value, "utf8") <= MAX_ISSUE_COMMAND_REASON_BYTES &&
      !/[\p{Cc}\p{Cf}]/u.test(value),
    "reason must be bounded, trimmed, and free of control or format characters",
  );
const common = { version: z.literal(1), commandId: uuidSchema };
const issueLifecycleCommandSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("run"),
        issueUrl: issueUrlSchema,
        repositoryIdentity: repositoryIdentitySchema,
        planDigest: sha256Schema,
        provider: z
          .string()
          .min(1)
          .max(96)
          .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
        model: z
          .string()
          .min(1)
          .max(256)
          .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value)),
      })
      .strict(),
    z.object({ ...common, kind: z.literal("resume"), runId: runIdSchema }).strict(),
    z
      .object({
        ...common,
        kind: z.literal("cancel"),
        runId: runIdSchema,
        actor: actorSchema,
        reason: reasonSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal("merge"),
        runId: runIdSchema,
        actor: actorSchema,
        expectedPullRequest: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        expectedHead: gitCommitSchema,
        expectedGateDigest: sha256Schema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (command.kind !== "run") return;
    const issue = parseGitHubIssueUrl(command.issueUrl);
    if (issue.repositoryIdentity !== command.repositoryIdentity) {
      context.addIssue({
        code: "custom",
        path: ["repositoryIdentity"],
        message: "run repository identity must match the canonical issue URL",
      });
    }
  });

type ParsedIssueLifecycleCommand = z.infer<typeof issueLifecycleCommandSchema>;
declare const issueLifecycleCommandBrand: unique symbol;

export type IssueLifecycleCommand = DeepReadonly<ParsedIssueLifecycleCommand> & {
  readonly [issueLifecycleCommandBrand]: true;
};

export class IssueLifecycleCommandError extends Error {
  override readonly name = "IssueLifecycleCommandError";

  constructor(message: string, options?: ErrorOptions) {
    super(`invalid_schema: ${message}`, options);
  }
}

export function parseIssueLifecycleCommand(input: unknown): IssueLifecycleCommand {
  const parsed = issueLifecycleCommandSchema.safeParse(input);
  if (!parsed.success) {
    throw new IssueLifecycleCommandError(
      parsed.error.issues
        .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
        .join("; "),
      { cause: parsed.error },
    );
  }
  return deepFreeze(structuredClone(parsed.data)) as IssueLifecycleCommand;
}

export function calculateIssueLifecycleCommandDigest(input: unknown): string {
  const command = parseIssueLifecycleCommand(input);
  return calculateIssueLifecycleDomainDigest(`flow.issue.command.${command.kind}.v1`, command);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

type DeepReadonly<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };
