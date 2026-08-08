import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import {
  createReadToolDefinition,
  defineTool,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  calculateAgentCommandDigest,
  MAX_AGENT_COMMAND_ARG_BYTES,
  MAX_AGENT_COMMAND_ARGS,
  MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
  MAX_AGENT_COMMAND_TIMEOUT_MS,
  normalizeAgentCommandRequest,
} from "../../domain/agent-command.js";
import type { AgentSkillSession } from "../../domain/capability/agent-skill-session.js";
import { renderToolPackageCommand } from "../../domain/capability/tool-package-renderer.js";
import {
  type ToolPackageSnapshot,
  validateToolPackageSnapshot,
} from "../../domain/capability/tool-packages.js";
import type { PolicyBroker } from "../../domain/policy/broker.js";
import type { AgentToolName } from "../../domain/workflow/types.js";
import {
  editHashAnchoredTextFile,
  type HashAnchoredEditRequest,
  type HashAnchoredEditResult,
  MAX_EDIT_INPUT_BYTES,
  MAX_EDIT_REPLACEMENTS,
} from "../fs/hash-anchored-edit.js";
import { createWorkspacePolicyBroker } from "../policy/workspace-policy-broker.js";
import type { AgentCommandRecorder } from "./agent-command-recorder.js";
import type { AgentEffectRecorder } from "./agent-effect-recorder.js";

const MAX_TOOL_PATH_BYTES = 1024;
const DEFAULT_LS_LIMIT = 500;
const MAX_LS_LIMIT = 5_000;
const MAX_LS_OUTPUT_BYTES = 50 * 1024;

const lsSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_TOOL_PATH_BYTES,
        description: "Directory to list (default: current workspace directory).",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_LS_LIMIT,
        description: `Maximum entries to return (default: ${DEFAULT_LS_LIMIT}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

const exactReplacementSchema = Type.Object(
  {
    oldText: Type.String({
      maxLength: MAX_EDIT_INPUT_BYTES,
      description: "Exact, non-empty text that occurs once in the current file.",
    }),
    newText: Type.String({
      maxLength: MAX_EDIT_INPUT_BYTES,
      description: "Replacement text.",
    }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: MAX_TOOL_PATH_BYTES,
      description: "Path to one existing UTF-8 file inside the Flow workspace.",
    }),
    expectedSha256: Type.String({
      pattern: "^[a-f0-9]{64}$",
      description: "Full SHA-256 version returned by flow_read for this file.",
    }),
    edits: Type.Array(exactReplacementSchema, {
      minItems: 1,
      maxItems: MAX_EDIT_REPLACEMENTS,
      description:
        "Exact, unique, non-overlapping replacements matched against the same original content.",
    }),
  },
  { additionalProperties: false },
);

const execSchema = Type.Object(
  {
    executable: Type.String({
      minLength: 1,
      maxLength: MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
      description: "Executable name or path. Shell syntax is not supported.",
    }),
    args: Type.Optional(
      Type.Array(Type.String({ maxLength: MAX_AGENT_COMMAND_ARG_BYTES }), {
        maxItems: MAX_AGENT_COMMAND_ARGS,
        description: "Literal argument vector passed without shell expansion.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_AGENT_COMMAND_TIMEOUT_MS,
        description: "Command deadline in milliseconds (default: 120000).",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface FlowAgentTools {
  readonly names: readonly string[];
  readonly definitions: readonly ToolDefinition[];
}

export interface FlowAgentToolOptions {
  readonly protectedPaths?: readonly string[];
  readonly effectRecorder?: AgentEffectRecorder;
  readonly commandRecorder?: AgentCommandRecorder;
  readonly editFile?: typeof editHashAnchoredTextFile;
  readonly capabilitySession?: AgentSkillSession;
  readonly toolPackages?: readonly ToolPackageSnapshot[];
}

interface ReadVersionContext {
  sha256?: string;
}

/** Build Flow-owned Pi tools whose filesystem view and effects remain Flow-authorized. */
export async function createWorkspaceAgentTools(
  cwd: string,
  tools: readonly AgentToolName[],
  policy: PolicyBroker,
  options: FlowAgentToolOptions = {},
): Promise<FlowAgentTools> {
  const root = await realpath(cwd);
  const broker = await createWorkspacePolicyBroker(root, policy, options.protectedPaths ?? []);
  const readVersions = new AsyncLocalStorage<ReadVersionContext>();
  const readOperations: ReadOperations = {
    access: async (path) => broker.execute("filesystem.read", path, access),
    readFile: async (path) =>
      broker.execute("filesystem.read", path, async (target) => {
        const content = await readFile(target);
        const context = readVersions.getStore();
        if (context !== undefined) {
          context.sha256 = sha256(content);
        }
        return content;
      }),
  };
  const definitions: ToolDefinition[] = [];
  const names: string[] = [];
  for (const tool of tools) {
    let definition: ToolDefinition;
    switch (tool) {
      case "read":
        definition = createVersionedReadDefinition(
          root,
          readOperations,
          readVersions,
          options.capabilitySession,
        );
        break;
      case "ls":
        definition = createLsDefinition(broker);
        break;
      case "edit":
        definition = createEditDefinition(broker, options);
        break;
      case "exec":
        definition = createExecDefinition(policy, options);
        break;
    }
    definitions.push(definition as ToolDefinition);
    names.push(definition.name);
  }
  for (const input of options.toolPackages ?? []) {
    const snapshot = validateToolPackageSnapshot(input);
    const definition = createToolPackageDefinition(snapshot, policy, options);
    if (names.includes(definition.name)) {
      throw new Error(`agent tool name "${definition.name}" is selected more than once`);
    }
    definitions.push(definition);
    names.push(definition.name);
  }

  return {
    names: Object.freeze(names),
    definitions: Object.freeze(definitions),
  };
}

function createToolPackageDefinition(
  snapshot: ToolPackageSnapshot,
  policy: PolicyBroker,
  options: FlowAgentToolOptions,
): ToolDefinition {
  const commandRecorder = options.commandRecorder;
  if (commandRecorder === undefined) {
    throw new Error("Flow command tool packages require an attempt-scoped command recorder");
  }
  const properties: Record<string, TSchema> = {};
  for (const input of snapshot.definition.tool.inputs) {
    switch (input.type) {
      case "string":
        properties[input.name] = Type.String({
          maxLength: 4_096,
          description: input.description,
        });
        break;
      case "integer":
        properties[input.name] = Type.Integer({
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
          description: input.description,
        });
        break;
      case "boolean":
        properties[input.name] = Type.Boolean({ description: input.description });
        break;
      case "enum":
        properties[input.name] = Type.Union(
          input.values.map((value) => Type.Literal(value)),
          { description: input.description },
        );
        break;
    }
  }
  return defineTool({
    name: snapshot.definition.tool.name,
    label: snapshot.name,
    description: snapshot.definition.tool.description,
    promptSnippet: snapshot.definition.tool.description,
    promptGuidelines: [
      "Inputs become literal argv values; shell syntax and expansion are not supported.",
      "Inspect the returned exit code, signal, timeout, stdout, and stderr before continuing.",
      "A failed command is evidence and must not be reported as successful completion.",
    ],
    parameters: Type.Object(properties, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      const rendered = renderToolPackageCommand(snapshot, input);
      const request = normalizeAgentCommandRequest({
        ...rendered.request,
        source: {
          kind: "tool-package",
          name: snapshot.name,
          version: snapshot.version,
          digest: snapshot.digest,
          toolName: snapshot.definition.tool.name,
          input: rendered.input,
          inputDigest: rendered.inputDigest,
        },
      });
      const operationDigest = calculateAgentCommandDigest(request);
      const decision = policy.authorize({
        action: "process.execute",
        target: request.executable,
        boundary: "inside",
        operationDigest,
      });
      const outcome = await commandRecorder.execute(request, decision, signal);
      return {
        content: [{ type: "text" as const, text: formatCommandOutcome(outcome) }],
        details: outcome,
      };
    },
  }) as ToolDefinition;
}

function createExecDefinition(policy: PolicyBroker, options: FlowAgentToolOptions): ToolDefinition {
  const commandRecorder = options.commandRecorder;
  if (commandRecorder === undefined) {
    throw new Error("Flow exec requires an attempt-scoped command recorder");
  }
  return defineTool({
    name: "flow_exec",
    label: "exec",
    description:
      "Execute one bounded executable and literal argument vector in Flow's production sandbox. No shell, environment overrides, cwd overrides, stdin, PTY, background mode, or network access are available.",
    promptSnippet: "Run a bounded argv-only command in the Flow sandbox",
    promptGuidelines: [
      "Pass the executable and each argument separately; shell operators and expansion are not supported.",
      "Inspect the returned exit code, signal, timeout, stdout, and stderr before deciding the next step.",
      "A failed command is evidence, not workflow completion; correct the issue or report it accurately.",
    ],
    parameters: execSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      const request = normalizeAgentCommandRequest(input);
      const operationDigest = calculateAgentCommandDigest(request);
      const decision = policy.authorize({
        action: "process.execute",
        target: request.executable,
        boundary: "inside",
        operationDigest,
      });
      const outcome = await commandRecorder.execute(request, decision, signal);
      return {
        content: [{ type: "text" as const, text: formatCommandOutcome(outcome) }],
        details: outcome,
      };
    },
  }) as ToolDefinition;
}

function formatCommandOutcome(
  outcome: Awaited<ReturnType<AgentCommandRecorder["execute"]>>,
): string {
  const evidence = outcome.evidence;
  const lines = [
    `status: ${outcome.status}`,
    ...(outcome.status === "failed"
      ? [`error: ${outcome.error.code}: ${outcome.error.message}`]
      : []),
  ];
  if (evidence === null) {
    return lines.join("\n");
  }
  lines.push(
    `exit code: ${evidence.exitCode === null ? "null" : evidence.exitCode}`,
    `signal: ${evidence.signal ?? "none"}`,
    `timed out: ${evidence.timedOut}`,
    `aborted: ${evidence.aborted}`,
    `duration ms: ${evidence.durationMs}`,
    `process containment: ${evidence.processContainment}`,
    `termination status: ${evidence.terminationStatus}`,
    `sandbox backend: ${evidence.sandbox.backend}`,
    `sandbox backend version: ${evidence.sandbox.backendVersion}`,
    `sandbox profile: ${evidence.sandbox.profile}`,
    `sandbox policy sha256: ${evidence.sandbox.policyDigest}`,
    `stdout sha256: ${evidence.stdoutHash}${evidence.stdoutTruncated ? " (truncated)" : ""}`,
    `stderr sha256: ${evidence.stderrHash}${evidence.stderrTruncated ? " (truncated)" : ""}`,
    "stdout:",
    evidence.stdout,
    "stderr:",
    evidence.stderr,
  );
  return lines.join("\n");
}

function createVersionedReadDefinition(
  root: string,
  operations: ReadOperations,
  versions: AsyncLocalStorage<ReadVersionContext>,
  capabilitySession?: AgentSkillSession,
): ToolDefinition {
  const base = createReadToolDefinition(root, { autoResizeImages: false, operations });
  const baseExecute = base.execute.bind(base);
  const definition = {
    ...base,
    name: "flow_read",
    label: "read",
    description:
      "Read a UTF-8 text file inside the Flow execution workspace or an explicitly selected immutable skill:// resource. Workspace results include a full-file SHA-256 version for flow_edit. Binary and image decoding is not supported.",
    promptSnippet:
      "Read workspace text files with Flow SHA-256 versions and selected skill:// resources",
    promptGuidelines: [
      "Use flow_read only for paths inside the Flow execution workspace.",
      "Use listed skill:// URIs only for Agent Skills selected on this node.",
      "Pass the returned full-file SHA-256 version to flow_edit; re-read after a stale-version error.",
    ],
    execute: async (...args: Parameters<typeof baseExecute>) => {
      const input = args[1];
      const signal = args[2];
      if (input.path.startsWith("skill://")) {
        throwIfToolAborted(signal);
        if (capabilitySession === undefined) {
          throw new Error("Agent Skill resources are unavailable for this node");
        }
        const resource = capabilitySession.readText(input.path);
        return {
          content: [{ type: "text" as const, text: resource.text }],
          details: {
            flowCapabilityUri: resource.receipt.uri,
            packageDigest: resource.receipt.packageDigest,
            fileDigest: resource.receipt.fileDigest,
            bytes: resource.receipt.bytes,
          },
        };
      }
      return await versions.run({}, async () => {
        const result = await baseExecute(...args);
        const version = versions.getStore()?.sha256;
        if (version === undefined) {
          throw new Error("Flow read completed without an exact-byte file version");
        }
        return {
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: `[Flow file version: sha256:${version}]` },
          ],
          details: { ...result.details, flowFileSha256: version },
        };
      });
    },
  };
  return definition as ToolDefinition;
}

function createLsDefinition(
  broker: Awaited<ReturnType<typeof createWorkspacePolicyBroker>>,
): ToolDefinition {
  return defineTool({
    name: "flow_ls",
    label: "ls",
    description: `List workspace directory contents alphabetically, including dotfiles and '/' suffixes for directories. Output is bounded to ${DEFAULT_LS_LIMIT} entries by default and ${MAX_LS_OUTPUT_BYTES / 1024} KiB.`,
    promptSnippet: "List workspace directories",
    promptGuidelines: ["Use flow_ls only for paths inside the Flow execution workspace."],
    parameters: lsSchema,
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      return await broker.execute("filesystem.list", input.path ?? ".", async (target) => {
        throwIfToolAborted(signal);
        const entries = await readdir(target, { withFileTypes: true });
        throwIfToolAborted(signal);
        entries.sort((left, right) =>
          left.name.toLowerCase().localeCompare(right.name.toLowerCase()),
        );

        const effectiveLimit = input.limit ?? DEFAULT_LS_LIMIT;
        const entryLimitReached = entries.length > effectiveLimit;
        const selected = entries.slice(0, effectiveLimit);
        const lines: string[] = [];
        let outputBytes = 0;
        let outputLimitReached = false;
        for (const entry of selected) {
          const line = `${entry.name}${entry.isDirectory() ? "/" : ""}`;
          const lineBytes = Buffer.byteLength(line, "utf8") + (lines.length === 0 ? 0 : 1);
          if (outputBytes + lineBytes > MAX_LS_OUTPUT_BYTES) {
            outputLimitReached = true;
            break;
          }
          lines.push(line);
          outputBytes += lineBytes;
        }

        if (lines.length === 0 && entries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "(empty directory)" }],
            details: { entryLimitReached: false, outputLimitReached: false },
          };
        }
        let text = lines.join("\n");
        const notices: string[] = [];
        if (entryLimitReached) {
          notices.push(`${effectiveLimit} entries limit reached`);
        }
        if (outputLimitReached) {
          notices.push(`${MAX_LS_OUTPUT_BYTES / 1024} KiB output limit reached`);
        }
        if (notices.length > 0) {
          text += `\n\n[Truncated: ${notices.join(", ")}]`;
        }
        return {
          content: [{ type: "text" as const, text }],
          details: { entryLimitReached, outputLimitReached },
        };
      });
    },
  }) as ToolDefinition;
}

function createEditDefinition(
  broker: Awaited<ReturnType<typeof createWorkspacePolicyBroker>>,
  options: FlowAgentToolOptions,
): ToolDefinition {
  const effectRecorder = options.effectRecorder;
  if (effectRecorder === undefined) {
    throw new Error("Flow edit requires an attempt-scoped effect recorder");
  }
  const editFile = options.editFile ?? editHashAnchoredTextFile;
  return defineTool({
    name: "flow_edit",
    label: "edit",
    description:
      "Atomically edit one existing UTF-8 workspace file using its flow_read SHA-256 version and exact, unique, non-overlapping replacements. Stale versions fail without automatic merging.",
    promptSnippet: "Edit an existing workspace file with exact hash-anchored replacements",
    promptGuidelines: [
      "Call flow_read first and pass its full-file SHA-256 version as expectedSha256.",
      "Keep every oldText exact and unique; all replacements are matched against the same original file.",
      "On stale_version, re-read and reconsider the change instead of retrying the old request.",
    ],
    parameters: editSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      validateToolPath(input.path);
      const request: HashAnchoredEditRequest = {
        expectedSha256: input.expectedSha256,
        edits: input.edits,
      };
      const operationDigest = calculateEditOperationDigest(input);
      const result = await broker.execute(
        "filesystem.write",
        input.path,
        async (target) => {
          const reservation = effectRecorder.reserve({
            kind: "filesystem.edit",
            target,
            operationDigest,
          });
          let prepared = false;
          try {
            const editResult = await editFile(target, request, {
              ...(signal === undefined ? {} : { signal }),
              effectLifecycle: {
                prepare: async (boundary) => {
                  await reservation.prepare(boundary);
                  prepared = true;
                },
                settle: async (settlement) => {
                  await reservation.settle(settlement);
                },
              },
            });
            return editResult;
          } catch (error) {
            if (!prepared) {
              reservation.cancel();
            }
            throw error;
          }
        },
        { operationDigest },
      );
      return editResult(result, input.path);
    },
  }) as ToolDefinition;
}

function editResult(result: HashAnchoredEditResult, path: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Edit committed for ${path}; new version sha256:${result.afterSha256}`,
      },
    ],
    details: result,
  };
}

function calculateEditOperationDigest(input: {
  readonly path: string;
  readonly expectedSha256: string;
  readonly edits: readonly { readonly oldText: string; readonly newText: string }[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        path: input.path,
        expectedSha256: input.expectedSha256,
        edits: input.edits,
      }),
    )
    .digest("hex");
}

function validateToolPath(path: string): void {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes === 0 || bytes > MAX_TOOL_PATH_BYTES || path.includes("\0")) {
    throw new RangeError(
      `edit path must contain between 1 and ${MAX_TOOL_PATH_BYTES} UTF-8 bytes and no NUL`,
    );
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function throwIfToolAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted", { cause: signal.reason });
  }
}
