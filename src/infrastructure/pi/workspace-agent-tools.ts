import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { access, readdir, readFile, realpath } from "node:fs/promises";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { ArtifactStore } from "../../application/artifact-store.js";
import type { NodeDelegationSession } from "../../application/ports.js";
import {
  calculateAgentCommandDigest,
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  MAX_AGENT_COMMAND_ARG_BYTES,
  MAX_AGENT_COMMAND_ARGS,
  MAX_AGENT_COMMAND_ARGS_BYTES,
  MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
  MAX_AGENT_COMMAND_OUTPUT_BYTES,
  MAX_AGENT_COMMAND_TIMEOUT_MS,
  normalizeAgentCommandRequest,
} from "../../domain/agent-command.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_READ_BYTES,
  MAX_COMMAND_ARTIFACT_BYTES,
} from "../../domain/artifact/reference.js";
import {
  MAX_AGENT_SKILL_FILE_BYTES,
  MAX_CAPABILITY_READ_RECEIPTS,
} from "../../domain/capability/agent-skills.js";
import type { AgentSkillSession } from "../../domain/capability/agent-skill-session.js";
import { builtInAgentToolPolicyAction } from "../../domain/capability/agent-tool-policy.js";
import type {
  PublicAvailabilityRequirement,
  PublicCapabilityLimitInput,
  PublicCapabilityToolInput,
} from "../../domain/capability/public-capability-reference.js";
import { renderToolPackageCommand } from "../../domain/capability/tool-package-renderer.js";
import {
  type ToolPackageSnapshot,
  validateToolPackageSnapshot,
} from "../../domain/capability/tool-packages.js";
import {
  MAX_POLICY_DECISIONS,
  MAX_POLICY_TARGET_BYTES,
  type PolicyBroker,
} from "../../domain/policy/broker.js";
import {
  MAX_SEMANTIC_PATH_BYTES,
  MAX_SEMANTIC_POSITION,
  MAX_SEMANTIC_CODE_BYTES,
  MAX_SEMANTIC_HOVER_BYTES,
  MAX_SEMANTIC_MESSAGE_BYTES,
  MAX_SEMANTIC_QUERY_RECEIPTS,
  MAX_SEMANTIC_RECEIPT_RESULT_BYTES,
  MAX_SEMANTIC_RESULT_ITEMS,
  normalizeSemanticRequest,
  type SemanticQueryReceipt,
  type SemanticRequest,
  type SemanticResult,
} from "../../domain/semantic/semantic-code.js";
import type { AgentToolName } from "../../domain/workflow/types.js";
import {
  MAX_AGENT_COMMANDS_PER_ATTEMPT,
  MAX_AGENT_EFFECT_RECEIPTS,
} from "../../domain/run/events.js";
import {
  createExclusiveDirectory,
  type ExclusiveDirectoryCreateResult,
} from "../fs/exclusive-directory-create.js";
import {
  createHashAnchoredTextFile,
  editHashAnchoredTextFile,
  type HashAnchoredCreateRequest,
  type HashAnchoredCreateResult,
  type HashAnchoredEditRequest,
  type HashAnchoredEditResult,
  MAX_CREATE_INPUT_BYTES,
  MAX_EDIT_FILE_BYTES,
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

const readSchema = createReadToolDefinition(".", { autoResizeImages: false }).parameters;

const artifactSchema = Type.Object(
  {
    reference: Type.String({
      pattern: "^artifact:[a-f0-9]{64}$",
      description: "Opaque artifact reference returned by Flow command evidence.",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_ARTIFACT_BYTES,
        description: "Zero-based byte offset (default: 0).",
      }),
    ),
    maxBytes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_ARTIFACT_READ_BYTES,
        description: `Maximum bytes to return (default: ${MAX_ARTIFACT_READ_BYTES}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

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

const createSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: MAX_TOOL_PATH_BYTES,
      description: "Path for one new UTF-8 file inside the Flow workspace.",
    }),
    content: Type.String({
      maxLength: MAX_CREATE_INPUT_BYTES,
      description: "Complete UTF-8 content for the new file.",
    }),
  },
  { additionalProperties: false },
);

const mkdirSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: MAX_TOOL_PATH_BYTES,
      description: "Path for one new directory inside the Flow workspace.",
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
        default: [],
        description: "Literal argument vector passed without shell expansion (default: empty).",
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

const semanticSchema = Type.Object(
  {
    operation: Type.Union([
      Type.Literal("diagnostics"),
      Type.Literal("definition"),
      Type.Literal("references"),
      Type.Literal("hover"),
    ]),
    path: Type.String({
      minLength: 1,
      maxLength: MAX_SEMANTIC_PATH_BYTES,
      description: "Portable path to one admitted project file.",
    }),
    line: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_SEMANTIC_POSITION,
        description: "Zero-based line for definition, references, or hover.",
      }),
    ),
    character: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_SEMANTIC_POSITION,
        description: "Zero-based character for definition, references, or hover.",
      }),
    ),
  },
  { additionalProperties: false },
);

const delegationSchema = Type.Object({}, { additionalProperties: false });

export interface FlowAgentTools {
  readonly names: readonly string[];
  readonly definitions: readonly ToolDefinition[];
}

export interface FlowAgentToolOptions {
  readonly protectedPaths?: readonly string[];
  readonly effectRecorder?: AgentEffectRecorder;
  readonly commandRecorder?: AgentCommandRecorder;
  readonly editFile?: typeof editHashAnchoredTextFile;
  readonly createFile?: typeof createHashAnchoredTextFile;
  readonly createDirectory?: typeof createExclusiveDirectory;
  readonly capabilitySession?: AgentSkillSession;
  readonly toolPackages?: readonly ToolPackageSnapshot[];
  readonly semanticSession?: SemanticToolSession;
  readonly artifactStore?: ArtifactStore;
  readonly delegationSession?: NodeDelegationSession;
}

export interface SemanticToolSession {
  query(request: SemanticRequest, signal?: AbortSignal): Promise<SemanticResult>;
  evidence(): readonly SemanticQueryReceipt[];
}

export const WORKSPACE_AGENT_PUBLIC_LIMITS = Object.freeze<readonly PublicCapabilityLimitInput[]>([
  limit(
    "agent-commands-per-attempt",
    MAX_AGENT_COMMANDS_PER_ATTEMPT,
    "items",
    "Maximum flow_exec and command-tool-package executions started in one agent attempt.",
  ),
  limit(
    "agent-effects-per-attempt",
    MAX_AGENT_EFFECT_RECEIPTS,
    "items",
    "Maximum combined flow_edit, flow_create, and flow_mkdir effect reservations in one agent attempt.",
  ),
  limit("artifact-maximum-bytes", MAX_ARTIFACT_BYTES, "bytes", "Maximum retained artifact size."),
  limit(
    "artifact-read-window-bytes",
    MAX_ARTIFACT_READ_BYTES,
    "bytes",
    "Maximum bytes returned by one artifact read.",
    MAX_ARTIFACT_READ_BYTES,
  ),
  limit("edit-file-bytes", MAX_EDIT_FILE_BYTES, "bytes", "Maximum UTF-8 bytes in one edited file."),
  limit(
    "create-input-characters",
    MAX_CREATE_INPUT_BYTES,
    "characters",
    "Maximum characters in one create content schema value.",
  ),
  limit(
    "create-input-bytes",
    MAX_CREATE_INPUT_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one new file.",
  ),
  limit(
    "edit-input-characters",
    MAX_EDIT_INPUT_BYTES,
    "characters",
    "Maximum Unicode code points in one old or replacement text schema value.",
  ),
  limit(
    "edit-input-total-bytes",
    MAX_EDIT_INPUT_BYTES,
    "bytes",
    "Maximum combined UTF-8 bytes across every old and replacement text value.",
  ),
  limit(
    "edit-replacements",
    MAX_EDIT_REPLACEMENTS,
    "items",
    "Maximum exact replacements in one edit call.",
  ),
  limit(
    "exec-argument-bytes",
    MAX_AGENT_COMMAND_ARG_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one command argument.",
  ),
  limit(
    "exec-arguments",
    MAX_AGENT_COMMAND_ARGS,
    "items",
    "Maximum arguments in one command call.",
  ),
  limit(
    "exec-arguments-total-bytes",
    MAX_AGENT_COMMAND_ARGS_BYTES,
    "bytes",
    "Maximum combined UTF-8 bytes in one command argument vector.",
  ),
  limit(
    "exec-executable-bytes",
    MAX_AGENT_COMMAND_EXECUTABLE_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one executable value.",
  ),
  limit(
    "exec-artifact-bytes-per-stream",
    MAX_COMMAND_ARTIFACT_BYTES,
    "bytes",
    "Maximum retained command artifact bytes for each output stream.",
  ),
  limit(
    "exec-output-bytes-per-stream",
    MAX_AGENT_COMMAND_OUTPUT_BYTES,
    "bytes",
    "Maximum UTF-8 bytes returned inline for each command output stream.",
  ),
  limit(
    "exec-timeout-milliseconds",
    MAX_AGENT_COMMAND_TIMEOUT_MS,
    "milliseconds",
    "Maximum command deadline.",
    DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  ),
  limit(
    "ls-entries",
    MAX_LS_LIMIT,
    "entries",
    "Maximum requested directory entries.",
    DEFAULT_LS_LIMIT,
  ),
  limit(
    "ls-output-bytes",
    MAX_LS_OUTPUT_BYTES,
    "bytes",
    "Maximum UTF-8 bytes returned by one directory listing.",
  ),
  limit(
    "policy-decisions-per-attempt",
    MAX_POLICY_DECISIONS,
    "items",
    "Maximum authorization decisions shared by all policy-backed tools in one agent attempt. One workspace flow_read call records one decision; skill:// reads record none.",
  ),
  limit(
    "policy-target-bytes",
    MAX_POLICY_TARGET_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one policy authorization target.",
  ),
  limit(
    "read-output-bytes",
    DEFAULT_MAX_BYTES,
    "bytes",
    "Maximum text bytes returned by one underlying Pi read window.",
    DEFAULT_MAX_BYTES,
  ),
  limit(
    "read-output-lines",
    DEFAULT_MAX_LINES,
    "lines",
    "Maximum lines returned by one underlying Pi read window.",
    DEFAULT_MAX_LINES,
  ),
  limit(
    "read-distinct-skill-resources-per-attempt",
    MAX_CAPABILITY_READ_RECEIPTS,
    "items",
    "Maximum distinct skill:// resource receipts retained in one agent attempt.",
  ),
  limit(
    "read-skill-resource-bytes",
    MAX_AGENT_SKILL_FILE_BYTES,
    "bytes",
    "Maximum UTF-8 bytes returned for one admitted skill:// resource.",
  ),
  limit(
    "semantic-code-bytes",
    MAX_SEMANTIC_CODE_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one semantic code value.",
  ),
  limit(
    "semantic-hover-bytes",
    MAX_SEMANTIC_HOVER_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one hover value.",
  ),
  limit(
    "semantic-message-bytes",
    MAX_SEMANTIC_MESSAGE_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one semantic diagnostic message.",
  ),
  limit(
    "semantic-path-characters",
    MAX_SEMANTIC_PATH_BYTES,
    "characters",
    "Maximum Unicode code points in one semantic query path schema value.",
  ),
  limit(
    "semantic-path-bytes",
    MAX_SEMANTIC_PATH_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one normalized semantic query path.",
  ),
  limit(
    "semantic-position",
    MAX_SEMANTIC_POSITION,
    "position",
    "Maximum zero-based line or character position.",
  ),
  limit(
    "semantic-result-items",
    MAX_SEMANTIC_RESULT_ITEMS,
    "items",
    "Maximum diagnostics or locations returned by one semantic query.",
  ),
  limit(
    "semantic-result-bytes",
    MAX_SEMANTIC_RECEIPT_RESULT_BYTES,
    "bytes",
    "Maximum serialized bytes retained for one semantic query result.",
  ),
  limit(
    "semantic-queries-per-attempt",
    MAX_SEMANTIC_QUERY_RECEIPTS,
    "items",
    "Maximum semantic query receipts retained for one agent attempt.",
  ),
  limit(
    "tool-path-characters",
    MAX_TOOL_PATH_BYTES,
    "characters",
    "Maximum Unicode code points in one list or edit path schema value.",
  ),
  limit(
    "tool-path-bytes",
    MAX_TOOL_PATH_BYTES,
    "bytes",
    "Maximum UTF-8 bytes in one validated edit path.",
  ),
]);

const WORKSPACE_AGENT_TOOL_REFERENCE_BY_SELECTOR = Object.freeze({
  read: toolReference({
    selector: "read",
    name: "flow_read",
    label: "read",
    description:
      "Read a UTF-8 text file inside the Flow execution workspace or an explicitly selected immutable skill:// resource. Workspace results include a full-file SHA-256 version for flow_edit. Binary and image decoding is not supported.",
    inputSchema: readSchema,
    executionMode: "default",
    authority: ["read"],
    policyActions: [builtInAgentToolPolicyAction("read")],
    availability: [],
    limitIds: [
      "policy-decisions-per-attempt",
      "policy-target-bytes",
      "read-distinct-skill-resources-per-attempt",
      "read-output-bytes",
      "read-output-lines",
      "read-skill-resource-bytes",
    ],
  }),
  ls: toolReference({
    selector: "ls",
    name: "flow_ls",
    label: "ls",
    description: `List workspace directory contents alphabetically, including dotfiles and '/' suffixes for directories. Output is bounded to ${DEFAULT_LS_LIMIT} entries by default and ${MAX_LS_OUTPUT_BYTES / 1024} KiB.`,
    inputSchema: lsSchema,
    executionMode: "default",
    authority: ["read"],
    policyActions: [builtInAgentToolPolicyAction("ls")],
    availability: [],
    limitIds: [
      "ls-entries",
      "ls-output-bytes",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
      "tool-path-characters",
    ],
  }),
  edit: toolReference({
    selector: "edit",
    name: "flow_edit",
    label: "edit",
    description:
      "Atomically edit one existing UTF-8 workspace file using its flow_read SHA-256 version and exact, unique, non-overlapping replacements. Stale versions fail without automatic merging.",
    inputSchema: editSchema,
    executionMode: "sequential",
    authority: ["write"],
    policyActions: [builtInAgentToolPolicyAction("edit")],
    availability: ["effect-recorder"],
    limitIds: [
      "edit-file-bytes",
      "agent-effects-per-attempt",
      "edit-input-characters",
      "edit-input-total-bytes",
      "edit-replacements",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
      "tool-path-characters",
      "tool-path-bytes",
    ],
  }),
  create: toolReference({
    selector: "create",
    name: "flow_create",
    label: "create",
    description:
      "Atomically create one new UTF-8 workspace file with complete content. An existing path is never replaced.",
    inputSchema: createSchema,
    executionMode: "sequential",
    authority: ["write"],
    policyActions: [builtInAgentToolPolicyAction("create")],
    availability: ["effect-recorder"],
    limitIds: [
      "create-input-characters",
      "create-input-bytes",
      "agent-effects-per-attempt",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
      "tool-path-characters",
      "tool-path-bytes",
    ],
  }),
  mkdir: toolReference({
    selector: "mkdir",
    name: "flow_mkdir",
    label: "mkdir",
    description:
      "Atomically create one new empty workspace directory with mode 0755. The parent must already exist, and an existing path is never replaced.",
    inputSchema: mkdirSchema,
    executionMode: "sequential",
    authority: ["write"],
    policyActions: [builtInAgentToolPolicyAction("mkdir")],
    availability: ["effect-recorder"],
    limitIds: [
      "agent-effects-per-attempt",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
      "tool-path-characters",
      "tool-path-bytes",
    ],
  }),
  exec: toolReference({
    selector: "exec",
    name: "flow_exec",
    label: "exec",
    description:
      "Execute one bounded executable and literal argument vector in Flow's production sandbox. No shell, environment overrides, cwd overrides, stdin, PTY, background mode, or network access are available.",
    inputSchema: execSchema,
    executionMode: "sequential",
    authority: ["execute"],
    policyActions: [builtInAgentToolPolicyAction("exec")],
    availability: ["command-recorder"],
    limitIds: [
      "agent-commands-per-attempt",
      "exec-argument-bytes",
      "exec-arguments",
      "exec-arguments-total-bytes",
      "exec-artifact-bytes-per-stream",
      "exec-executable-bytes",
      "exec-output-bytes-per-stream",
      "exec-timeout-milliseconds",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
    ],
  }),
  semantic: toolReference({
    selector: "semantic",
    name: "flow_semantic",
    label: "semantic",
    description:
      "Query one operator-selected language server for bounded diagnostics, definitions, references, or hover information. The tool cannot edit files or run model-selected commands.",
    inputSchema: semanticSchema,
    executionMode: "sequential",
    authority: ["read"],
    policyActions: [builtInAgentToolPolicyAction("semantic")],
    availability: ["language-server"],
    limitIds: [
      "semantic-code-bytes",
      "semantic-hover-bytes",
      "semantic-message-bytes",
      "semantic-path-bytes",
      "semantic-path-characters",
      "semantic-position",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
      "semantic-queries-per-attempt",
      "semantic-result-bytes",
      "semantic-result-items",
    ],
  }),
  artifact: toolReference({
    selector: "artifact",
    name: "flow_artifact",
    label: "artifact",
    description:
      "Read one bounded binary window from a retained command artifact owned by this run. Results are base64 encoded and never interpreted as text.",
    inputSchema: artifactSchema,
    executionMode: "sequential",
    authority: ["read"],
    policyActions: [builtInAgentToolPolicyAction("artifact")],
    availability: ["artifact-store"],
    limitIds: [
      "artifact-maximum-bytes",
      "artifact-read-window-bytes",
      "policy-decisions-per-attempt",
      "policy-target-bytes",
    ],
  }),
} satisfies Record<AgentToolName, PublicCapabilityToolInput>);

export const WORKSPACE_AGENT_TOOL_REFERENCES = Object.freeze(
  Object.values(WORKSPACE_AGENT_TOOL_REFERENCE_BY_SELECTOR),
);

interface ReadVersionContext {
  sha256?: string;
  authorization?: {
    readonly requestedPath: string;
    readonly canonicalTarget: string;
  };
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
  const readReference = workspaceAgentToolReference("read");
  const readPolicyAction = onlyPolicyAction(readReference);
  const readOperations: ReadOperations = {
    access: async (path) =>
      broker.execute(readPolicyAction, path, async (target) => {
        await access(target);
        const context = readVersions.getStore();
        if (context !== undefined) {
          context.authorization = { requestedPath: path, canonicalTarget: target };
        }
      }),
    readFile: async (path) => {
      const context = readVersions.getStore();
      const authorization = context?.authorization;
      const content =
        authorization?.requestedPath === path
          ? await readFile(authorization.canonicalTarget)
          : await broker.execute(readPolicyAction, path, async (target) => await readFile(target));
      if (context !== undefined) {
        context.sha256 = sha256(content);
      }
      return content;
    },
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
      case "create":
        definition = createFileDefinition(broker, options);
        break;
      case "mkdir":
        definition = createDirectoryDefinition(broker, options);
        break;
      case "exec":
        definition = createExecDefinition(policy, options);
        break;
      case "semantic":
        definition = createSemanticDefinition(broker, options.semanticSession);
        break;
      case "artifact":
        definition = createArtifactDefinition(policy, options.artifactStore);
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
  if (options.delegationSession !== undefined) {
    const definition = createDelegationDefinition(options.delegationSession);
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

function createDelegationDefinition(session: NodeDelegationSession): ToolDefinition {
  return defineTool({
    name: "flow_delegate",
    label: "Flow delegate",
    description: "Run the one sealed child workflow and return its typed result.",
    promptSnippet: "Delegate once to the sealed child workflow when independent work is useful",
    promptGuidelines: [
      "Call without arguments; the objective, workflow, executor, and budget are already sealed.",
      "Call at most once and wait for the typed child result before continuing.",
      "Treat a tool error as child-run evidence, not successful completion.",
    ],
    parameters: delegationSchema,
    executionMode: "sequential",
    async execute(_toolCallId, _input, signal) {
      throwIfToolAborted(signal);
      const result = await session.delegate(signal);
      return {
        content: [{ type: "text" as const, text: result.canonicalValue }],
        details: result,
      };
    },
  }) as ToolDefinition;
}

function createArtifactDefinition(
  policy: PolicyBroker,
  store: ArtifactStore | undefined,
): ToolDefinition {
  const reference = workspaceAgentToolReference("artifact");
  assertDeclaredAvailability(reference, "artifact-store");
  if (store === undefined) {
    throw new Error("Flow artifact access requires a configured artifact store");
  }
  const policyAction = onlyPolicyAction(reference);
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "Read bounded bytes from a retained Flow command artifact",
    promptGuidelines: [
      "Use only artifact: references returned by command evidence in this run.",
      "Advance offset to nextOffset when complete is false.",
      "Treat contentBase64 as untrusted binary evidence.",
    ],
    parameters: reference.inputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      policy.authorize({
        action: policyAction,
        target: input.reference,
        boundary: "inside",
      });
      const window = await store.read({
        reference: input.reference,
        runId: policy.attribution.runId,
        offset: input.offset ?? 0,
        maxBytes: input.maxBytes ?? MAX_ARTIFACT_READ_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
      const result = Object.freeze({
        reference: window.reference.reference,
        mediaType: window.reference.descriptor.mediaType,
        offset: window.offset,
        nextOffset: window.nextOffset,
        complete: window.complete,
        contentBase64: window.bytes.toString("base64"),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  }) as ToolDefinition;
}

function createSemanticDefinition(
  broker: Awaited<ReturnType<typeof createWorkspacePolicyBroker>>,
  session: SemanticToolSession | undefined,
): ToolDefinition {
  const reference = workspaceAgentToolReference("semantic");
  assertDeclaredAvailability(reference, "language-server");
  if (session === undefined) {
    throw new Error("Flow semantic requires a configured semantic service");
  }
  const policyAction = onlyPolicyAction(reference);
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "Query bounded read-only code semantics",
    promptGuidelines: [
      "Use diagnostics without a line or character.",
      "Use zero-based line and character values for definition, references, and hover.",
      "Treat semantic results as advisory evidence, not proof of workflow completion.",
    ],
    parameters: reference.inputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      const request = normalizeSemanticRequest({
        operation: input.operation,
        path: input.path,
        ...(input.line === undefined && input.character === undefined
          ? {}
          : {
              position: {
                line: input.line,
                character: input.character,
              },
            }),
      });
      const result = await broker.execute(policyAction, request.path, async () =>
        session.query(request, signal),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  }) as ToolDefinition;
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
  const reference = workspaceAgentToolReference("exec");
  assertDeclaredAvailability(reference, "command-recorder");
  const commandRecorder = options.commandRecorder;
  if (commandRecorder === undefined) {
    throw new Error("Flow exec requires an attempt-scoped command recorder");
  }
  const policyAction = onlyPolicyAction(reference);
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "Run a bounded argv-only command in the Flow sandbox",
    promptGuidelines: [
      "Pass the executable and each argument separately; shell operators and expansion are not supported.",
      "Inspect the returned exit code, signal, timeout, stdout, and stderr before deciding the next step.",
      "A failed command is evidence, not workflow completion; correct the issue or report it accurately.",
    ],
    parameters: reference.inputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      const request = normalizeAgentCommandRequest(input);
      const operationDigest = calculateAgentCommandDigest(request);
      const decision = policy.authorize({
        action: policyAction,
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
    ...(evidence.stdoutArtifact === undefined
      ? []
      : [`stdout artifact: ${evidence.stdoutArtifact.reference}`]),
    ...(evidence.stderrArtifact === undefined
      ? []
      : [`stderr artifact: ${evidence.stderrArtifact.reference}`]),
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
  const reference = workspaceAgentToolReference("read");
  const definition = {
    ...base,
    name: reference.name,
    label: reference.label,
    description: reference.description,
    parameters: reference.inputSchema,
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
  const reference = workspaceAgentToolReference("ls");
  const policyAction = onlyPolicyAction(reference);
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "List workspace directories",
    promptGuidelines: ["Use flow_ls only for paths inside the Flow execution workspace."],
    parameters: reference.inputSchema,
    async execute(_toolCallId, input, signal) {
      throwIfToolAborted(signal);
      return await broker.execute(policyAction, input.path ?? ".", async (target) => {
        throwIfToolAborted(signal);
        const entries = await readdir(target, { withFileTypes: true });
        throwIfToolAborted(signal);
        entries.sort((left, right) => compareDirectoryNames(left.name, right.name));

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
        const bounded = boundDirectoryListing(
          lines,
          effectiveLimit,
          entryLimitReached,
          outputLimitReached,
        );
        return {
          content: [{ type: "text" as const, text: bounded.text }],
          details: { entryLimitReached, outputLimitReached: bounded.outputLimitReached },
        };
      });
    },
  }) as ToolDefinition;
}

function createEditDefinition(
  broker: Awaited<ReturnType<typeof createWorkspacePolicyBroker>>,
  options: FlowAgentToolOptions,
): ToolDefinition {
  const reference = workspaceAgentToolReference("edit");
  assertDeclaredAvailability(reference, "effect-recorder");
  const effectRecorder = options.effectRecorder;
  if (effectRecorder === undefined) {
    throw new Error("Flow edit requires an attempt-scoped effect recorder");
  }
  const policyAction = onlyPolicyAction(reference);
  const editFile = options.editFile ?? editHashAnchoredTextFile;
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "Edit an existing workspace file with exact hash-anchored replacements",
    promptGuidelines: [
      "Call flow_read first and pass its full-file SHA-256 version as expectedSha256.",
      "Keep every oldText exact and unique; all replacements are matched against the same original file.",
      "On stale_version, re-read and reconsider the change instead of retrying the old request.",
    ],
    parameters: reference.inputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      validateToolPath(input.path);
      const request: HashAnchoredEditRequest = {
        expectedSha256: input.expectedSha256,
        edits: input.edits,
      };
      const operationDigest = calculateEditOperationDigest(input);
      const result = await broker.execute(
        policyAction,
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

function createFileDefinition(
  broker: Awaited<ReturnType<typeof createWorkspacePolicyBroker>>,
  options: FlowAgentToolOptions,
): ToolDefinition {
  const reference = workspaceAgentToolReference("create");
  assertDeclaredAvailability(reference, "effect-recorder");
  const effectRecorder = options.effectRecorder;
  if (effectRecorder === undefined) {
    throw new Error("Flow create requires an attempt-scoped effect recorder");
  }
  const policyAction = onlyPolicyAction(reference);
  const createFile = options.createFile ?? createHashAnchoredTextFile;
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "Create one new workspace file from complete UTF-8 content",
    promptGuidelines: [
      "Use flow_create only when the destination does not exist.",
      "Provide the complete file content; flow_create never appends to or replaces a path.",
      "Use flow_read and flow_edit when a destination already exists.",
    ],
    parameters: reference.inputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      validateToolPath(input.path);
      const request: HashAnchoredCreateRequest = { content: input.content };
      const operationDigest = calculateCreateOperationDigest(input);
      const result = await broker.execute(
        policyAction,
        input.path,
        async (target) => {
          const reservation = effectRecorder.reserve({
            kind: "filesystem.create",
            target,
            operationDigest,
          });
          let prepared = false;
          try {
            const createResult = await createFile(target, request, {
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
            return createResult;
          } catch (error) {
            if (!prepared) {
              reservation.cancel();
            }
            throw error;
          }
        },
        { operationDigest },
      );
      return createResult(result, input.path);
    },
  }) as ToolDefinition;
}

function createResult(result: HashAnchoredCreateResult, path: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `File created for ${path}; version sha256:${result.afterSha256}`,
      },
    ],
    details: result,
  };
}

function createDirectoryDefinition(
  broker: Awaited<ReturnType<typeof createWorkspacePolicyBroker>>,
  options: FlowAgentToolOptions,
): ToolDefinition {
  const reference = workspaceAgentToolReference("mkdir");
  assertDeclaredAvailability(reference, "effect-recorder");
  const effectRecorder = options.effectRecorder;
  if (effectRecorder === undefined) {
    throw new Error("Flow mkdir requires an attempt-scoped effect recorder");
  }
  const policyAction = onlyPolicyAction(reference);
  const createDirectory = options.createDirectory ?? createExclusiveDirectory;
  return defineTool({
    name: reference.name,
    label: reference.label,
    description: reference.description,
    promptSnippet: "Create one new empty workspace directory",
    promptGuidelines: [
      "Use flow_mkdir only when the destination does not exist and its parent already exists.",
      "Create one directory per call; flow_mkdir never creates parents recursively.",
      "Use flow_create after flow_mkdir to add files inside the new directory.",
    ],
    parameters: reference.inputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      validateToolPath(input.path);
      const operationDigest = calculateMkdirOperationDigest(input);
      const result = await broker.execute(
        policyAction,
        input.path,
        async (target) => {
          const reservation = effectRecorder.reserve({
            kind: "filesystem.mkdir",
            target,
            operationDigest,
          });
          let prepared = false;
          try {
            const directoryResult = await createDirectory(target, {
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
            return directoryResult;
          } catch (error) {
            if (!prepared) {
              reservation.cancel();
            }
            throw error;
          }
        },
        { operationDigest },
      );
      return directoryResult(result, input.path);
    },
  }) as ToolDefinition;
}

function directoryResult(result: ExclusiveDirectoryCreateResult, path: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Directory created for ${path} with mode 0755`,
      },
    ],
    details: result,
  };
}

function workspaceAgentToolReference<TSelector extends AgentToolName>(
  selector: TSelector,
): (typeof WORKSPACE_AGENT_TOOL_REFERENCE_BY_SELECTOR)[TSelector] {
  return WORKSPACE_AGENT_TOOL_REFERENCE_BY_SELECTOR[selector];
}

function onlyPolicyAction<const TReference extends PublicCapabilityToolInput>(
  reference: TReference,
): TReference["policyActions"][number] {
  const [action, ...unexpected] = reference.policyActions;
  if (action === undefined || unexpected.length > 0) {
    throw new Error(`public tool "${reference.selector}" must declare exactly one policy action`);
  }
  return action as TReference["policyActions"][number];
}

function assertDeclaredAvailability(
  reference: PublicCapabilityToolInput,
  requirement: PublicAvailabilityRequirement,
): void {
  if (!reference.availability.includes(requirement)) {
    throw new Error(
      `public tool "${reference.selector}" must declare the ${requirement} availability requirement`,
    );
  }
}

function toolReference<const TInput extends PublicCapabilityToolInput>(input: TInput): TInput {
  return Object.freeze({
    ...input,
    inputSchema: deepFreeze(input.inputSchema),
    authority: Object.freeze([...input.authority]),
    policyActions: Object.freeze([...input.policyActions]),
    availability: Object.freeze([...input.availability]),
    limitIds: Object.freeze([...input.limitIds]),
  }) as TInput;
}

function boundDirectoryListing(
  sourceLines: readonly string[],
  effectiveLimit: number,
  entryLimitReached: boolean,
  initialOutputLimitReached: boolean,
): { readonly text: string; readonly outputLimitReached: boolean } {
  const lines = [...sourceLines];
  let outputLimitReached = initialOutputLimitReached;
  for (;;) {
    const notices = [
      ...(entryLimitReached ? [`${effectiveLimit} entries limit reached`] : []),
      ...(outputLimitReached ? [`${MAX_LS_OUTPUT_BYTES / 1024} KiB output limit reached`] : []),
    ];
    const notice = notices.length === 0 ? "" : `[Truncated: ${notices.join(", ")}]`;
    const text = [lines.join("\n"), notice].filter((part) => part.length > 0).join("\n\n");
    if (Buffer.byteLength(text, "utf8") <= MAX_LS_OUTPUT_BYTES) {
      return Object.freeze({ text, outputLimitReached });
    }
    outputLimitReached = true;
    lines.pop();
  }
}

function compareDirectoryNames(left: string, right: string): number {
  const folded = compareStrings(left.toLowerCase(), right.toLowerCase());
  return folded === 0 ? compareStrings(left, right) : folded;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function limit(
  id: string,
  value: number,
  unit: PublicCapabilityLimitInput["unit"],
  scope: string,
  defaultValue?: number,
): PublicCapabilityLimitInput {
  return Object.freeze({
    id,
    value,
    unit,
    scope,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  });
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

function calculateCreateOperationDigest(input: {
  readonly path: string;
  readonly content: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        operation: "create",
        path: input.path,
        content: input.content,
      }),
    )
    .digest("hex");
}

function calculateMkdirOperationDigest(input: { readonly path: string }): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        operation: "mkdir",
        path: input.path,
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
