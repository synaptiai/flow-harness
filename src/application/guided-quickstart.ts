import type { RunStatus } from "../domain/run/events.js";
import type { CompiledWorkflow } from "../domain/workflow/types.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type GuidedQuickstartMode =
  | { readonly kind: "foundation" }
  | { readonly kind: "provider"; readonly provider: string; readonly model: string };

export interface GuidedQuickstartInput {
  readonly directory: string;
  readonly mode: GuidedQuickstartMode;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export type GuidedQuickstartPublication =
  | { readonly outcome: "published"; readonly projectRoot: string }
  | { readonly outcome: "already_exists" }
  | { readonly outcome: "commit_uncertain" }
  | { readonly outcome: "settlement_uncertain" };

export type GuidedQuickstartTerminalStatus = Exclude<RunStatus, "running" | "waiting_for_approval">;

export interface GuidedQuickstartPorts {
  readonly prepareWorkflow: (
    mode: GuidedQuickstartMode,
    signal?: AbortSignal,
  ) => Promise<CompiledWorkflow>;
  readonly publishProject: (
    directory: string,
    signal?: AbortSignal,
  ) => Promise<GuidedQuickstartPublication>;
  readonly validateProvider: (input: {
    readonly projectRoot: string;
    readonly provider: string;
    readonly model: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly executeWorkflow: (input: {
    readonly projectRoot: string;
    readonly workflow: CompiledWorkflow;
    readonly runId: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly status: GuidedQuickstartTerminalStatus }>;
}

export type GuidedQuickstartErrorCode =
  | "cancelled_after_publication"
  | "execution_failed"
  | "invalid_input"
  | "preparation_failed"
  | "project_exists"
  | "provider_unavailable"
  | "publication_failed"
  | "publication_uncertain";

export class GuidedQuickstartError extends Error {
  override readonly name = "GuidedQuickstartError";

  constructor(
    readonly code: GuidedQuickstartErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GuidedQuickstartResult {
  readonly version: 1;
  readonly mode: GuidedQuickstartMode["kind"];
  readonly project: { readonly publication: "created" };
  readonly run: {
    readonly id: string;
    readonly status: GuidedQuickstartTerminalStatus;
    readonly evidence: string;
  };
  readonly commands: {
    readonly inspect: readonly ["flow", "inspect", string];
    readonly browser: readonly ["flow", "web", string, "--actor", "operator:quickstart"];
  };
}

export async function runGuidedQuickstart(
  input: GuidedQuickstartInput,
  ports: GuidedQuickstartPorts,
): Promise<GuidedQuickstartResult> {
  assertInput(input);
  input.signal?.throwIfAborted();

  const workflow = await prepareWorkflow(input, ports);
  input.signal?.throwIfAborted();

  const publication = await publishProject(input, ports);
  if (publication.outcome === "already_exists") {
    throw new GuidedQuickstartError(
      "project_exists",
      "Quick start requires a directory without Flow project configuration.",
    );
  }
  if (
    publication.outcome === "commit_uncertain" ||
    publication.outcome === "settlement_uncertain"
  ) {
    throw new GuidedQuickstartError(
      "publication_uncertain",
      "Quick-start project publication is uncertain; inspect the project before retrying.",
    );
  }

  assertNotCancelledAfterPublication(input.signal);
  if (input.mode.kind === "provider") {
    await validateProvider(input.mode, input.signal, publication.projectRoot, ports);
    assertNotCancelledAfterPublication(input.signal);
  }

  const execution = await executeWorkflow(input, publication.projectRoot, workflow, ports);
  return quickstartResult(input.mode.kind, input.runId, execution.status);
}

function assertInput(input: GuidedQuickstartInput): void {
  if (
    input.directory.length === 0 ||
    input.directory.length > 4_096 ||
    input.directory.includes("\0") ||
    !RUN_ID_PATTERN.test(input.runId)
  ) {
    throw invalidInput();
  }
  if (input.mode.kind === "provider") {
    if (
      input.mode.provider.length > 96 ||
      !PROVIDER_PATTERN.test(input.mode.provider) ||
      input.mode.model.length === 0 ||
      input.mode.model.length > 256 ||
      input.mode.model !== input.mode.model.trim() ||
      input.mode.model.includes("\0")
    ) {
      throw invalidInput();
    }
  }
}

async function prepareWorkflow(
  input: GuidedQuickstartInput,
  ports: GuidedQuickstartPorts,
): Promise<CompiledWorkflow> {
  try {
    return await ports.prepareWorkflow(input.mode, input.signal);
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new GuidedQuickstartError(
      "preparation_failed",
      "Quick-start workflow preparation failed.",
      { cause: error },
    );
  }
}

async function publishProject(
  input: GuidedQuickstartInput,
  ports: GuidedQuickstartPorts,
): Promise<GuidedQuickstartPublication> {
  try {
    return await ports.publishProject(input.directory, input.signal);
  } catch (error) {
    input.signal?.throwIfAborted();
    throw new GuidedQuickstartError(
      "publication_failed",
      "Quick-start project publication failed.",
      { cause: error },
    );
  }
}

async function validateProvider(
  mode: Extract<GuidedQuickstartMode, { readonly kind: "provider" }>,
  signal: AbortSignal | undefined,
  projectRoot: string,
  ports: GuidedQuickstartPorts,
): Promise<void> {
  try {
    await ports.validateProvider({
      projectRoot,
      provider: mode.provider,
      model: mode.model,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw cancelledAfterPublication();
    }
    throw new GuidedQuickstartError(
      "provider_unavailable",
      "Quick-start provider configuration is unavailable.",
      { cause: error },
    );
  }
}

async function executeWorkflow(
  input: GuidedQuickstartInput,
  projectRoot: string,
  workflow: CompiledWorkflow,
  ports: GuidedQuickstartPorts,
): Promise<{ readonly status: GuidedQuickstartTerminalStatus }> {
  try {
    return await ports.executeWorkflow({
      projectRoot,
      workflow,
      runId: input.runId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    throw new GuidedQuickstartError("execution_failed", "Quick-start workflow execution failed.", {
      cause: error,
    });
  }
}

function assertNotCancelledAfterPublication(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledAfterPublication();
  }
}

function cancelledAfterPublication(): GuidedQuickstartError {
  return new GuidedQuickstartError(
    "cancelled_after_publication",
    "Quick start stopped after project publication; inspect the project before retrying.",
  );
}

function invalidInput(): GuidedQuickstartError {
  return new GuidedQuickstartError("invalid_input", "Quick-start input is invalid.");
}

function quickstartResult(
  mode: GuidedQuickstartMode["kind"],
  runId: string,
  status: GuidedQuickstartTerminalStatus,
): GuidedQuickstartResult {
  return Object.freeze({
    version: 1,
    mode,
    project: Object.freeze({ publication: "created" as const }),
    run: Object.freeze({
      id: runId,
      status,
      evidence: `.flow/runs/${runId}/events.jsonl`,
    }),
    commands: Object.freeze({
      inspect: Object.freeze(["flow", "inspect", runId] as const),
      browser: Object.freeze(["flow", "web", runId, "--actor", "operator:quickstart"] as const),
    }),
  });
}
