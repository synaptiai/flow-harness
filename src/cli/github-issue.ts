import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

export interface GitHubIssueCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type GitHubIssueCliRequest =
  | { readonly kind: "validate"; readonly planPath: string }
  | { readonly kind: "doctor"; readonly issueUrl: string; readonly planPath: string }
  | {
      readonly kind: "run";
      readonly issueUrl: string;
      readonly planPath: string;
      readonly provider: string;
      readonly model: string;
      readonly commandId: string;
    }
  | { readonly kind: "inspect"; readonly runId: string }
  | {
      readonly kind: "events";
      readonly runId: string;
      readonly afterSequence: number;
      readonly limit: number;
    }
  | { readonly kind: "resume"; readonly runId: string; readonly commandId: string }
  | {
      readonly kind: "cancel";
      readonly runId: string;
      readonly actor: string;
      readonly reason?: string;
      readonly commandId: string;
    }
  | {
      readonly kind: "merge";
      readonly runId: string;
      readonly actor: string;
      readonly expectedPullRequest: number;
      readonly expectedHead: string;
      readonly expectedGateDigest: string;
      readonly commandId: string;
    };

export interface GitHubIssueCliService {
  execute(request: GitHubIssueCliRequest): Promise<unknown>;
}

export interface GitHubIssueCliOptions {
  readonly randomUuid?: () => string;
}

const HELP = `Usage:
  flow issue validate <plan.yaml>
  flow issue doctor <issue-url> --plan <plan.yaml>
  flow issue run <issue-url> --plan <plan.yaml> --provider <provider> --model <model> [--command-id <uuid>]
  flow issue inspect <run-id>
  flow issue events <run-id> [--after <sequence>] [--limit <count>]
  flow issue resume <run-id> [--command-id <uuid>]
  flow issue cancel <run-id> --actor <label> [--reason <text>] [--command-id <uuid>]
  flow issue merge <run-id> --actor <label> --expected-pr <number> --expected-head <40-lowercase-hex> --expected-gate-digest <sha256> [--command-id <uuid>]`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export async function runGitHubIssueCli(
  args: readonly string[],
  io: GitHubIssueCliIo,
  service: GitHubIssueCliService,
  options: GitHubIssueCliOptions = {},
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    io.stdout(HELP);
    return 0;
  }
  try {
    const request = parseRequest(args, options.randomUuid ?? randomUUID);
    const result = await service.execute(request);
    const output = hasCommandId(request) ? { commandId: request.commandId, state: result } : result;
    io.stdout(JSON.stringify(output, null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof GitHubIssueCliUsageError)) throw error;
    io.stderr(`${error.message}\n\n${HELP}`);
    return 2;
  }
}

function parseRequest(args: readonly string[], randomUuid: () => string): GitHubIssueCliRequest {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "validate": {
      const parsed = parse(rest, {});
      return {
        kind: "validate",
        planPath: onePositional(parsed.positionals, "validate requires <plan.yaml>"),
      };
    }
    case "doctor": {
      const parsed = parse(rest, { plan: { type: "string" } });
      return {
        kind: "doctor",
        issueUrl: onePositional(parsed.positionals, "doctor requires <issue-url>"),
        planPath: requiredString(parsed.values.plan, "doctor requires --plan <plan.yaml>"),
      };
    }
    case "run": {
      const parsed = parse(rest, {
        plan: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "command-id": { type: "string" },
      });
      const provider = requiredString(parsed.values.provider, "run requires --provider <provider>");
      if (provider.length > 96 || !PROVIDER_PATTERN.test(provider)) usage("--provider is invalid");
      const model = requiredString(parsed.values.model, "run requires --model <model>");
      if (model !== model.trim() || model.length > 256 || /[\p{Cc}\p{Cf}]/u.test(model)) {
        usage("--model is invalid");
      }
      return {
        kind: "run",
        issueUrl: onePositional(parsed.positionals, "run requires <issue-url>"),
        planPath: requiredString(parsed.values.plan, "run requires --plan <plan.yaml>"),
        provider,
        model,
        commandId: commandIdentifier(parsed.values["command-id"], randomUuid),
      };
    }
    case "inspect": {
      const parsed = parse(rest, {});
      return {
        kind: "inspect",
        runId: runIdentifier(onePositional(parsed.positionals, "inspect requires <run-id>")),
      };
    }
    case "events": {
      const parsed = parse(rest, {
        after: { type: "string" },
        limit: { type: "string" },
      });
      return {
        kind: "events",
        runId: runIdentifier(onePositional(parsed.positionals, "events requires <run-id>")),
        afterSequence: boundedInteger(
          parsed.values.after,
          "--after",
          0,
          Number.MAX_SAFE_INTEGER,
          0,
        ),
        limit: boundedInteger(parsed.values.limit, "--limit", 1, 100, 100),
      };
    }
    case "resume": {
      const parsed = parse(rest, { "command-id": { type: "string" } });
      return {
        kind: "resume",
        runId: runIdentifier(onePositional(parsed.positionals, "resume requires <run-id>")),
        commandId: commandIdentifier(parsed.values["command-id"], randomUuid),
      };
    }
    case "cancel": {
      const parsed = parse(rest, {
        actor: { type: "string" },
        reason: { type: "string" },
        "command-id": { type: "string" },
      });
      const reason = optionalBoundedString(parsed.values.reason, "--reason", 2_048);
      return {
        kind: "cancel",
        runId: runIdentifier(onePositional(parsed.positionals, "cancel requires <run-id>")),
        actor: boundedString(parsed.values.actor, "cancel requires --actor <label>", 256),
        ...(reason === undefined ? {} : { reason }),
        commandId: commandIdentifier(parsed.values["command-id"], randomUuid),
      };
    }
    case "merge": {
      const parsed = parse(rest, {
        actor: { type: "string" },
        "expected-pr": { type: "string" },
        "expected-head": { type: "string" },
        "expected-gate-digest": { type: "string" },
        "command-id": { type: "string" },
      });
      const expectedHead = requiredString(
        parsed.values["expected-head"],
        "merge requires --expected-head <40-lowercase-hex>",
      );
      if (!/^[a-f0-9]{40}$/.test(expectedHead)) usage("--expected-head is invalid");
      const expectedGateDigest = requiredString(
        parsed.values["expected-gate-digest"],
        "merge requires --expected-gate-digest <sha256>",
      );
      if (!/^[a-f0-9]{64}$/.test(expectedGateDigest)) {
        usage("--expected-gate-digest is invalid");
      }
      return {
        kind: "merge",
        runId: runIdentifier(onePositional(parsed.positionals, "merge requires <run-id>")),
        actor: boundedString(parsed.values.actor, "merge requires --actor <label>", 256),
        expectedPullRequest: boundedInteger(
          parsed.values["expected-pr"],
          "--expected-pr",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        expectedHead,
        expectedGateDigest,
        commandId: commandIdentifier(parsed.values["command-id"], randomUuid),
      };
    }
    default:
      usage(`unknown issue subcommand ${JSON.stringify(subcommand)}`);
  }
}

function parse(
  args: readonly string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>["options"],
): {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: string[];
} {
  try {
    const seen = new Set<string>();
    for (const argument of args) {
      if (argument === "--") break;
      if (!argument.startsWith("--")) continue;
      const name = argument.slice(2).split("=", 1)[0];
      if (name === undefined || name.length === 0) continue;
      if (seen.has(name)) usage(`--${name} may be specified only once`);
      seen.add(name);
    }
    const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (error) {
    if (error instanceof GitHubIssueCliUsageError) throw error;
    usage(error instanceof Error ? error.message : String(error));
  }
}

function onePositional(positionals: readonly string[], message: string): string {
  const positional = positionals[0];
  if (positionals.length !== 1 || positional === undefined || positional.length === 0)
    usage(message);
  return positional;
}

function requiredString(value: string | boolean | undefined, message: string): string {
  if (typeof value !== "string" || value.length === 0) usage(message);
  return value;
}

function boundedString(
  value: string | boolean | undefined,
  message: string,
  maxBytes: number,
): string {
  const text = requiredString(value, message);
  if (
    text !== text.trim() ||
    Buffer.byteLength(text, "utf8") > maxBytes ||
    /[\p{Cc}\p{Cf}]/u.test(text)
  ) {
    usage(message);
  }
  return text;
}

function optionalBoundedString(
  value: string | boolean | undefined,
  label: string,
  maxBytes: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, `${label} is invalid`, maxBytes);
}

function commandIdentifier(value: string | boolean | undefined, randomUuid: () => string): string {
  const commandId =
    value === undefined ? randomUuid() : requiredString(value, "--command-id requires a UUID");
  if (!UUID_PATTERN.test(commandId) || commandId === "00000000-0000-0000-0000-000000000000") {
    usage("--command-id requires a canonical non-nil UUID");
  }
  return commandId;
}

function runIdentifier(value: string): string {
  if (value.length > 128 || !RUN_ID_PATTERN.test(value)) usage("run ID is invalid");
  return value;
}

function boundedInteger(
  value: string | boolean | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const text = requiredString(value, `${label} requires an integer`);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) usage(`${label} requires an integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usage(`${label} is outside its allowed range`);
  }
  return parsed;
}

function hasCommandId(
  request: GitHubIssueCliRequest,
): request is Extract<GitHubIssueCliRequest, { readonly commandId: string }> {
  return "commandId" in request;
}

function usage(message: string): never {
  throw new GitHubIssueCliUsageError(message);
}

class GitHubIssueCliUsageError extends Error {
  override readonly name = "GitHubIssueCliUsageError";
}
