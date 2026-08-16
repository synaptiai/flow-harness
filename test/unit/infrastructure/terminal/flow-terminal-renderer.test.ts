import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  FLOW_PRESENTATION_API_VERSION,
  type FlowPresentationDocument,
} from "../../../../src/domain/presentation/flow-presentation.js";
import {
  FlowTerminalRenderer,
  FlowTerminalRendererError,
  formatFlowPresentation,
} from "../../../../src/infrastructure/terminal/flow-terminal-renderer.js";

describe("Flow terminal renderer", () => {
  it("renders every closed component using only Flow-owned terminal styling", async () => {
    const terminal = new CaptureTerminal();
    const actions: string[] = [];
    const exits: string[] = [];
    const renderer = new FlowTerminalRenderer({
      terminal,
      onAction: async (actionId) => {
        actions.push(actionId);
      },
      onExit: () => exits.push("exit"),
    });

    renderer.start();
    await renderer.render(completeDocument());

    const output = terminal.output.join("");
    const visibleOutput = stripTerminalSequences(output);
    expect(visibleOutput).toContain("Flow run");
    expect(visibleOutput).toContain("Run: run-1");
    expect(visibleOutput).toContain("Nodes");
    expect(visibleOutput).toContain("node-a");
    expect(visibleOutput).toContain("Approval required");
    expect(visibleOutput).toContain("1. Approve request");
    expect(output).not.toContain("contentBase64");
    expect(output).not.toContain("PRIVATE_");
    expect(terminal.startCalls).toBe(1);

    terminal.input("\u001b[B");
    terminal.input("\r");
    await Promise.resolve();
    expect(actions).toEqual(["deny:request-1"]);

    terminal.input("q");
    expect(exits).toEqual(["exit"]);

    await renderer.close();
    await renderer.close();
    expect(terminal.stopCalls).toBe(1);
  });

  it("maps supported selection keys and ignores unsupported input", async () => {
    const terminal = new CaptureTerminal();
    const actions: string[] = [];
    const exits: string[] = [];
    const renderer = new FlowTerminalRenderer({
      terminal,
      onAction: async (actionId) => {
        actions.push(actionId);
      },
      onExit: () => exits.push("exit"),
    });
    renderer.start();
    await renderer.render(completeDocument());

    terminal.input("PRIVATE_UNSUPPORTED");
    terminal.input("k");
    terminal.input("\r");
    await settleMicrotasks();
    terminal.input("j");
    terminal.input("\n");
    await settleMicrotasks();

    expect(actions).toEqual(["cancel:run-1", "approve:request-1"]);
    terminal.input("\u0003");
    expect(exits).toEqual(["exit"]);
    await renderer.close();
  });

  it("rerenders the current bounded document after a terminal resize", async () => {
    const terminal = new CaptureTerminal();
    const renderer = new FlowTerminalRenderer({
      terminal,
      onAction: async () => {},
      onExit: () => {},
    });
    renderer.start();
    await renderer.render(completeDocument());
    const writesBeforeResize = terminal.output.length;

    terminal.columnsValue = 80;
    terminal.rowsValue = 30;
    terminal.resize();
    await waitFor(() => terminal.output.length > writesBeforeResize);

    expect(terminal.output.length).toBeGreaterThan(writesBeforeResize);
    expect(stripTerminalSequences(terminal.output.join(""))).toContain("Flow run");
    await renderer.close();
  });

  it("does not let renderer errors retain private callback values", async () => {
    const terminal = new CaptureTerminal();
    const renderer = new FlowTerminalRenderer({
      terminal,
      onAction: async () => {
        throw "PRIVATE_ACTION_REJECTION";
      },
      onExit: () => {},
    });
    renderer.start();
    await renderer.render(completeDocument());

    terminal.input("\r");
    await settleMicrotasks();

    expect(terminal.output.join("")).toContain("Action failed.");
    expect(terminal.output.join("")).not.toContain("PRIVATE_ACTION_REJECTION");
    await renderer.close();
  });

  it("rejects render before start and restores a partial start failure once", async () => {
    const terminal = new CaptureTerminal();
    const renderer = new FlowTerminalRenderer({
      terminal,
      onAction: async () => {},
      onExit: () => {},
    });

    await expect(renderer.render(completeDocument())).rejects.toThrow(
      "Cannot render Flow terminal presentation: renderer is not active",
    );

    terminal.startError = new Error("PRIVATE_START_FAILURE");
    expect(() => renderer.start()).toThrow(FlowTerminalRendererError);
    expect(() => renderer.start()).toThrow(
      "Cannot render Flow terminal presentation: renderer is closed",
    );
    await renderer.close();
    expect(terminal.stopCalls).toBe(1);
    expect(terminal.output.join("")).not.toContain("PRIVATE_START_FAILURE");
  });

  it("normalizes a terminal restore failure and never retries ownership release", async () => {
    const terminal = new CaptureTerminal();
    terminal.stopError = new Error("PRIVATE_RESTORE_FAILURE_AT_/PRIVATE/tty");
    const renderer = new FlowTerminalRenderer({
      terminal,
      onAction: async () => {},
      onExit: () => {},
    });
    renderer.start();

    const error = await captureError(renderer.close());

    expect(error).toEqual(
      new FlowTerminalRendererError("Cannot render Flow terminal presentation: restore terminal"),
    );
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_");
    await expect(renderer.close()).resolves.toBeUndefined();
    expect(terminal.stopCalls).toBe(1);
  });

  it("formats only already-safe document text and never synthesizes hyperlinks", () => {
    const formatted = formatFlowPresentation(completeDocument(), 0);

    expect(formatted).not.toContain("\u001b]8;");
    expect(formatted).not.toContain("\u001b]52;");
    expect(formatted).not.toContain("https://");
    expect(formatted).toContain("Cancel run");
  });
});

class CaptureTerminal implements Terminal {
  readonly output: string[] = [];
  startCalls = 0;
  stopCalls = 0;
  columnsValue = 100;
  rowsValue = 40;
  startError: Error | undefined;
  stopError: Error | undefined;
  #onInput: ((data: string) => void) | undefined;
  #onResize: (() => void) | undefined;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startCalls += 1;
    this.#onInput = onInput;
    this.#onResize = onResize;
    if (this.startError !== undefined) {
      throw this.startError;
    }
  }

  stop(): void {
    this.stopCalls += 1;
    if (this.stopError !== undefined) {
      throw this.stopError;
    }
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.output.push(data);
  }

  get columns(): number {
    return this.columnsValue;
  }

  get rows(): number {
    return this.rowsValue;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  input(data: string): void {
    this.#onInput?.(data);
  }

  resize(): void {
    this.#onResize?.();
  }
}

async function settleMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("expected operation to reject");
  } catch (error) {
    return error;
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function completeDocument(): FlowPresentationDocument {
  return {
    apiVersion: FLOW_PRESENTATION_API_VERSION,
    run: {
      runId: "run-1",
      workflowId: "workflow-1",
      status: "waiting_for_approval",
      sequence: 12,
    },
    sections: [
      {
        id: "overview",
        title: "Overview",
        components: [
          { kind: "heading", level: 1, text: "Flow run" },
          { kind: "facts", items: [{ label: "Run", value: "run-1" }] },
          { kind: "progress", label: "Nodes", completed: 1, total: 2 },
          {
            kind: "table",
            columns: [
              { key: "node", label: "Node" },
              { key: "status", label: "Status" },
            ],
            rows: [{ id: "node-a", cells: ["node-a", "running"] }],
            truncated: false,
          },
          { kind: "notice", tone: "warning", text: "Approval required" },
          { kind: "divider" },
        ],
      },
    ],
    actions: [
      {
        kind: "approve",
        actionId: "approve:request-1",
        requestId: "request-1",
        label: "Approve request",
      },
      {
        kind: "deny",
        actionId: "deny:request-1",
        requestId: "request-1",
        label: "Deny request",
      },
      { kind: "cancel", actionId: "cancel:run-1", runId: "run-1", label: "Cancel run" },
    ],
    truncated: false,
  };
}
