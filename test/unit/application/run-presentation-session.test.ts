import { describe, expect, it } from "vitest";
import {
  type RunPresentationEventSource,
  type RunPresentationRenderer,
  RunPresentationSessionError,
  runPresentationSession,
} from "../../../src/application/run-presentation-session.js";
import { createCapabilitySnapshot } from "../../../src/domain/capability/agent-skills.js";
import type { FlowPresentationDocument } from "../../../src/domain/presentation/flow-presentation.js";
import { projectRunPresentation } from "../../../src/domain/presentation/run-presentation-projector.js";
import { type RunEvent, reduceRunEvents } from "../../../src/domain/run/events.js";

describe("run presentation session", () => {
  it("reduces bounded pages to the same terminal state as authoritative replay", async () => {
    const events = cancelledEvents();
    const source = new PageSource([
      { type: "events", events: [events[0]], cursor: 1, terminal: false },
      { type: "events", events: [], cursor: 1, terminal: false },
      { type: "events", events: [events[1]], cursor: 2, terminal: true },
    ]);
    const renderer = new CaptureRenderer();

    const state = await runPresentationSession({
      runId: "run-1",
      source,
      renderer,
      waitForMore: async () => {
        source.waits += 1;
      },
    });

    expect(state).toEqual(reduceRunEvents(events));
    expect(source.requests).toEqual([
      { runId: "run-1", afterSequence: 0, limit: 256 },
      { runId: "run-1", afterSequence: 1, limit: 256 },
      { runId: "run-1", afterSequence: 1, limit: 256 },
    ]);
    expect(source.waits).toBe(1);
    expect(renderer.documents.map((document) => document.run.sequence)).toEqual([1, 2]);
    expect(renderer.documents.at(-1)?.run.status).toBe("cancelled");
    expect(renderer.closeCalls).toBe(1);
  });

  it("projects only public run output while retaining private bytes in durable state", async () => {
    const privateContent = Buffer.from("PRIVATE_SKILL_RESOURCE").toString("base64");
    const events = cancelledEvents();
    const started = {
      ...events[0],
      capabilitySnapshot: createCapabilitySnapshot([
        {
          kind: "agent-skill",
          name: "review",
          description: "Review code when selected.",
          metadata: { version: "1" },
          requestedTools: [],
          trust: "project-explicit" as const,
          provenance: ".flow/skills/review",
          files: [
            {
              path: "SKILL.md",
              content: Buffer.from(privateContent, "base64"),
            },
          ],
        },
      ]),
    };
    let projectionInput: unknown;

    const state = await runPresentationSession({
      runId: "run-1",
      source: new PageSource([
        { type: "events", events: [started, events[1]], cursor: 2, terminal: true },
      ]),
      renderer: new CaptureRenderer(),
      waitForMore: async () => {},
      projectDocument: (input: unknown) => {
        projectionInput = input;
        return projectRunPresentation(input);
      },
    });

    expect(projectionInput).toBeDefined();
    expect(JSON.stringify(projectionInput)).not.toContain("contentBase64");
    expect(JSON.stringify(projectionInput)).not.toContain(privateContent);
    expect(JSON.stringify(state)).toContain("contentBase64");
    expect(JSON.stringify(state)).toContain(privateContent);
  });

  it.each([
    [
      "a duplicate event",
      [
        { type: "events", events: [cancelledEvents()[0]], cursor: 1, terminal: false },
        { type: "events", events: [cancelledEvents()[0]], cursor: 1, terminal: false },
      ],
    ],
    [
      "an event sequence gap",
      [
        { type: "events", events: [cancelledEvents()[0]], cursor: 1, terminal: false },
        {
          type: "events",
          events: [{ ...cancelledEvents()[1], sequence: 3 }],
          cursor: 3,
          terminal: true,
        },
      ],
    ],
    [
      "a regressed page cursor",
      [{ type: "events", events: [cancelledEvents()[0]], cursor: 0, terminal: false }],
    ],
    [
      "a terminal claim for active state",
      [{ type: "events", events: [cancelledEvents()[0]], cursor: 1, terminal: true }],
    ],
    [
      "a nonterminal claim for terminal state",
      [
        {
          type: "events",
          events: cancelledEvents(),
          cursor: 2,
          terminal: false,
        },
      ],
    ],
    ["a malformed response", [{ type: "PRIVATE_RESPONSE", private: "PRIVATE_PAGE" }]],
  ])("fails closed for %s", async (_label, pages) => {
    const renderer = new CaptureRenderer();

    await expect(
      runPresentationSession({
        runId: "run-1",
        source: new PageSource(pages),
        renderer,
        waitForMore: async () => {},
      }),
    ).rejects.toThrow("Cannot observe Flow run presentation: event page is incompatible");
    expect(renderer.closeCalls).toBe(1);
  });

  it("checks cancellation before the first source call", async () => {
    const reason = new Error("operator cancelled presentation");
    const controller = new AbortController();
    controller.abort(reason);
    const source = new PageSource([]);
    const renderer = new CaptureRenderer();

    await expect(
      runPresentationSession({
        runId: "run-1",
        source,
        renderer,
        waitForMore: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(source.requests).toEqual([]);
    expect(renderer.documents).toEqual([]);
    expect(renderer.closeCalls).toBe(1);
  });

  it("gives cancellation precedence immediately after an event-page boundary", async () => {
    const reason = new Error("operator cancelled after page");
    const controller = new AbortController();
    const source: RunPresentationEventSource = {
      readPage: async () => {
        controller.abort(reason);
        return { type: "events", events: [cancelledEvents()[0]], cursor: 1, terminal: false };
      },
    };
    const renderer = new CaptureRenderer();

    await expect(
      runPresentationSession({
        runId: "run-1",
        source,
        renderer,
        waitForMore: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(renderer.documents).toEqual([]);
    expect(renderer.closeCalls).toBe(1);
  });

  it("normalizes private source and renderer failures without retaining causes", async () => {
    const sourceFailure = new PageSource([new Error("PRIVATE_SOURCE_FAILURE")]);
    const firstRenderer = new CaptureRenderer();

    const sourceError = await captureError(
      runPresentationSession({
        runId: "run-1",
        source: sourceFailure,
        renderer: firstRenderer,
        waitForMore: async () => {},
      }),
    );
    expect(sourceError).toEqual(
      new RunPresentationSessionError("Cannot observe Flow run presentation: read event page"),
    );
    expect(errorText(sourceError)).not.toContain("PRIVATE_SOURCE_FAILURE");

    const renderer = new CaptureRenderer();
    renderer.renderError = new Error("PRIVATE_RENDER_FAILURE");
    const renderError = await captureError(
      runPresentationSession({
        runId: "run-1",
        source: new PageSource([
          { type: "events", events: cancelledEvents(), cursor: 2, terminal: true },
        ]),
        renderer,
        waitForMore: async () => {},
      }),
    );
    expect(renderError).toEqual(
      new RunPresentationSessionError("Cannot observe Flow run presentation: render document"),
    );
    expect(errorText(renderError)).not.toContain("PRIVATE_RENDER_FAILURE");
  });

  it("normalizes a private polling failure and closes the renderer", async () => {
    const events = cancelledEvents();
    const renderer = new CaptureRenderer();

    const error = await captureError(
      runPresentationSession({
        runId: "run-1",
        source: new PageSource([
          { type: "events", events: [events[0]], cursor: 1, terminal: false },
          { type: "events", events: [], cursor: 1, terminal: false },
        ]),
        renderer,
        waitForMore: async () => {
          throw new Error("PRIVATE_POLL_FAILURE");
        },
      }),
    );

    expect(error).toEqual(
      new RunPresentationSessionError("Cannot observe Flow run presentation: wait for events"),
    );
    expect(error).not.toHaveProperty("cause");
    expect(errorText(error)).not.toContain("PRIVATE_POLL_FAILURE");
    expect(renderer.closeCalls).toBe(1);
  });

  it("reports a renderer close failure after a successful terminal replay", async () => {
    const renderer = new CaptureRenderer();
    renderer.closeError = new Error("PRIVATE_CLOSE_FAILURE");

    const error = await captureError(
      runPresentationSession({
        runId: "run-1",
        source: new PageSource([
          { type: "events", events: cancelledEvents(), cursor: 2, terminal: true },
        ]),
        renderer,
        waitForMore: async () => {},
      }),
    );

    expect(error).toEqual(
      new RunPresentationSessionError("Cannot observe Flow run presentation: close renderer"),
    );
    expect(error).not.toHaveProperty("cause");
    expect(errorText(error)).not.toContain("PRIVATE_CLOSE_FAILURE");
    expect(renderer.closeCalls).toBe(1);
  });

  it("preserves the primary stage while settling one renderer close", async () => {
    const renderer = new CaptureRenderer();
    renderer.renderError = new Error("PRIVATE_RENDER_FAILURE");
    renderer.closeError = new Error("PRIVATE_CLOSE_FAILURE");

    const error = await captureError(
      runPresentationSession({
        runId: "run-1",
        source: new PageSource([
          { type: "events", events: cancelledEvents(), cursor: 2, terminal: true },
        ]),
        renderer,
        waitForMore: async () => {},
      }),
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect(errorText(error)).toContain("Cannot observe Flow run presentation: render document");
    expect(errorText(error)).toContain("Cannot observe Flow run presentation: close renderer");
    expect(errorText(error)).not.toContain("PRIVATE_");
    expect(renderer.closeCalls).toBe(1);
  });
});

class PageSource implements RunPresentationEventSource {
  readonly requests: {
    readonly runId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }[] = [];
  waits = 0;

  constructor(private readonly pages: readonly unknown[]) {}

  async readPage(input: {
    readonly runId: string;
    readonly afterSequence: number;
    readonly limit: number;
  }): Promise<unknown> {
    this.requests.push(input);
    const next = this.pages[this.requests.length - 1];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

class CaptureRenderer implements RunPresentationRenderer {
  readonly documents: FlowPresentationDocument[] = [];
  closeCalls = 0;
  renderError: Error | undefined;
  closeError: Error | undefined;

  async render(document: FlowPresentationDocument): Promise<void> {
    if (this.renderError !== undefined) {
      throw this.renderError;
    }
    this.documents.push(document);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

function cancelledEvents(): readonly [RunEvent, RunEvent] {
  return [
    {
      version: 1,
      sequence: 1,
      at: "2026-08-16T08:00:01.000Z",
      runId: "run-1",
      workflowId: "workflow-1",
      type: "run_started",
      nodeIds: ["work"],
      workflowApiVersion: "flow.synapti.ai/v1alpha1",
      workflowDigest: "a".repeat(64),
    },
    {
      version: 1,
      sequence: 2,
      at: "2026-08-16T08:00:02.000Z",
      runId: "run-1",
      workflowId: "workflow-1",
      type: "run_cancelled",
      reason: "operator cancelled",
    },
  ];
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("expected operation to reject");
  } catch (error) {
    return error;
  }
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(errorText).join(" ")}`;
  }
  return error instanceof Error ? `${error.name} ${error.message}` : "non-error rejection";
}
