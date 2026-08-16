import { z } from "zod";

import type { FlowPresentationDocument } from "../domain/presentation/flow-presentation.js";
import { projectRunPresentation } from "../domain/presentation/run-presentation-projector.js";
import { appendRunEvent, parseRunEvent, type RunState } from "../domain/run/events.js";
import { projectPublicRunOutput } from "../domain/run/public-output.js";

export const RUN_PRESENTATION_EVENT_PAGE_LIMIT = 256;

const eventPageSchema = z
  .object({
    type: z.literal("events"),
    events: z.array(z.unknown()).max(RUN_PRESENTATION_EVENT_PAGE_LIMIT),
    cursor: z.number().int().nonnegative(),
    terminal: z.boolean(),
  })
  .strict();

export interface RunPresentationEventSource {
  readonly readPage: (input: {
    readonly runId: string;
    readonly afterSequence: number;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
}

export interface RunPresentationRenderer {
  readonly render: (document: FlowPresentationDocument) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface RunPresentationSessionOptions {
  readonly runId: string;
  readonly source: RunPresentationEventSource;
  readonly renderer: RunPresentationRenderer;
  readonly waitForMore: (signal?: AbortSignal) => Promise<void>;
  readonly projectDocument?: (publicRunState: unknown) => FlowPresentationDocument;
  readonly signal?: AbortSignal;
}

export class RunPresentationSessionError extends Error {
  override readonly name = "RunPresentationSessionError";
}

export async function runPresentationSession(
  options: RunPresentationSessionOptions,
): Promise<RunState> {
  let hasPrimaryError = false;
  let primaryError: unknown;
  let result: RunState | undefined;
  try {
    result = await observeRun(options);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  let closeError: Error | undefined;
  try {
    await options.renderer.close();
  } catch {
    closeError = new RunPresentationSessionError(
      "Cannot observe Flow run presentation: close renderer",
    );
  }

  if (hasPrimaryError && closeError !== undefined) {
    throw new AggregateError(
      [primaryError, closeError],
      "Cannot observe Flow run presentation: operation and cleanup failed",
    );
  }
  if (hasPrimaryError) {
    throw primaryError;
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  if (result === undefined) {
    throw new RunPresentationSessionError(
      "Cannot observe Flow run presentation: session ended without state",
    );
  }
  return result;
}

async function observeRun(options: RunPresentationSessionOptions): Promise<RunState> {
  let cursor = 0;
  let state: RunState | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    let response: unknown;
    try {
      response = await options.source.readPage({
        runId: options.runId,
        afterSequence: cursor,
        limit: RUN_PRESENTATION_EVENT_PAGE_LIMIT,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new RunPresentationSessionError(
        "Cannot observe Flow run presentation: read event page",
      );
    }
    options.signal?.throwIfAborted();

    const page = eventPageSchema.safeParse(response);
    if (!page.success) {
      throw incompatiblePage();
    }
    const previousCursor = cursor;
    try {
      for (const event of page.data.events) {
        state = appendRunEvent(state, parseRunEvent(event));
      }
    } catch {
      throw incompatiblePage();
    }
    if (
      page.data.cursor < previousCursor ||
      (page.data.events.length === 0 && page.data.cursor !== previousCursor) ||
      (page.data.events.length > 0 && state?.lastSequence !== page.data.cursor) ||
      (state !== undefined && state.runId !== options.runId)
    ) {
      throw incompatiblePage();
    }
    cursor = page.data.cursor;

    if (page.data.events.length === 0) {
      if (state === undefined || page.data.terminal) {
        throw incompatiblePage();
      }
      await waitForMore(options);
      continue;
    }
    if (state === undefined) {
      throw incompatiblePage();
    }
    const terminalState = isTerminalStatus(state.status);
    if (page.data.terminal !== terminalState) {
      throw incompatiblePage();
    }
    try {
      const publicRunState = projectPublicRunOutput(state);
      await options.renderer.render(
        (options.projectDocument ?? projectRunPresentation)(publicRunState),
      );
    } catch {
      options.signal?.throwIfAborted();
      throw new RunPresentationSessionError(
        "Cannot observe Flow run presentation: render document",
      );
    }
    options.signal?.throwIfAborted();
    if (terminalState) {
      return state;
    }
  }
}

async function waitForMore(options: RunPresentationSessionOptions): Promise<void> {
  options.signal?.throwIfAborted();
  try {
    await options.waitForMore(options.signal);
  } catch {
    options.signal?.throwIfAborted();
    throw new RunPresentationSessionError("Cannot observe Flow run presentation: wait for events");
  }
  options.signal?.throwIfAborted();
}

function incompatiblePage(): RunPresentationSessionError {
  return new RunPresentationSessionError(
    "Cannot observe Flow run presentation: event page is incompatible",
  );
}

function isTerminalStatus(status: RunState["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "resource_exhausted"
  );
}
