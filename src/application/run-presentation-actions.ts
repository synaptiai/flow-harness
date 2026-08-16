import { isValidApprovalActor } from "../domain/approval/command-approval.js";
import {
  type FlowPresentationDocument,
  parseFlowPresentationDocument,
} from "../domain/presentation/flow-presentation.js";
import { parseSafeDisplayText } from "../domain/presentation/safe-display-text.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RunPresentationControl {
  readonly decide: (input: {
    readonly runId: string;
    readonly requestId: string;
    readonly actor: string;
    readonly decision: "approve" | "deny";
    readonly reason?: string;
  }) => Promise<unknown>;
  readonly cancel: (input: {
    readonly runId: string;
    readonly commandId: string;
    readonly actor: string;
    readonly reason?: string;
  }) => Promise<unknown>;
}

export interface RunPresentationActionControllerOptions {
  readonly runId: string;
  readonly actor: string;
  readonly control: RunPresentationControl;
  readonly createCommandId: () => string;
  readonly signal?: AbortSignal;
}

export class RunPresentationActionError extends Error {
  override readonly name = "RunPresentationActionError";
}

export class RunPresentationActionController {
  readonly #runId: string;
  readonly #actor: string;
  readonly #control: RunPresentationControl;
  readonly #createCommandId: () => string;
  readonly #signal: AbortSignal | undefined;
  #document: FlowPresentationDocument | undefined;
  #cancelCommandId: string | undefined;

  constructor(options: RunPresentationActionControllerOptions) {
    this.#runId = options.runId;
    this.#actor = parseActor(options.actor);
    this.#control = options.control;
    this.#createCommandId = options.createCommandId;
    this.#signal = options.signal;
  }

  update(input: FlowPresentationDocument): void {
    let document: FlowPresentationDocument;
    try {
      document = parseFlowPresentationDocument(input);
    } catch {
      throw new RunPresentationActionError(
        "Cannot steer Flow run presentation: document is invalid",
      );
    }
    if (
      document.run.runId !== this.#runId ||
      document.actions.some((action) => action.kind === "cancel" && action.runId !== this.#runId)
    ) {
      throw new RunPresentationActionError(
        "Cannot steer Flow run presentation: document run does not match",
      );
    }
    this.#document = document;
  }

  async execute(actionId: string, options: { readonly reason?: string } = {}): Promise<unknown> {
    this.#signal?.throwIfAborted();
    const document = this.#document;
    if (document === undefined) {
      throw new RunPresentationActionError(
        "Cannot steer Flow run presentation: no current document",
      );
    }
    const action = document.actions.find((candidate) => candidate.actionId === actionId);
    if (action === undefined) {
      throw new RunPresentationActionError(
        "Cannot steer Flow run presentation: action is not current",
      );
    }
    const reason = options.reason === undefined ? undefined : parseReason(options.reason);
    try {
      if (action.kind === "approve" || action.kind === "deny") {
        return await this.#control.decide({
          runId: this.#runId,
          requestId: action.requestId,
          actor: this.#actor,
          decision: action.kind,
          ...(action.kind === "deny" && reason !== undefined ? { reason } : {}),
        });
      }
      return await this.#control.cancel({
        runId: this.#runId,
        commandId: this.#cancellationCommandId(),
        actor: this.#actor,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new RunPresentationActionError("Cannot steer Flow run presentation: control rejected");
    }
  }

  executeCurrent(
    documentSequence: number,
    actionId: string,
    options: { readonly reason?: string } = {},
  ): Promise<unknown> {
    const document = this.#document;
    if (document === undefined) {
      return Promise.reject(
        new RunPresentationActionError("Cannot steer Flow run presentation: no current document"),
      );
    }
    if (!Number.isSafeInteger(documentSequence) || document.run.sequence !== documentSequence) {
      return Promise.reject(
        new RunPresentationActionError("Cannot steer Flow run presentation: document is stale"),
      );
    }
    return this.execute(actionId, options);
  }

  #cancellationCommandId(): string {
    if (this.#cancelCommandId !== undefined) {
      return this.#cancelCommandId;
    }
    let commandId: string;
    try {
      commandId = this.#createCommandId();
    } catch {
      throw new RunPresentationActionError(
        "Cannot steer Flow run presentation: create cancellation identity",
      );
    }
    if (!UUID_PATTERN.test(commandId)) {
      throw new RunPresentationActionError(
        "Cannot steer Flow run presentation: cancellation identity is invalid",
      );
    }
    this.#cancelCommandId = commandId;
    return commandId;
  }
}

function parseActor(input: string): string {
  try {
    const actor = parseSafeDisplayText(input).trim();
    if (!isValidApprovalActor(actor)) {
      throw new Error("invalid actor");
    }
    return actor;
  } catch {
    throw new RunPresentationActionError("Cannot steer Flow run presentation: actor is invalid");
  }
}

function parseReason(input: string): string {
  try {
    const reason = parseSafeDisplayText(input).trim();
    if (reason.length === 0 || reason.length > 4096) {
      throw new Error("invalid reason");
    }
    return reason;
  } catch {
    throw new RunPresentationActionError("Cannot steer Flow run presentation: reason is invalid");
  }
}
