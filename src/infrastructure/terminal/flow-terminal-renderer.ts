import { ProcessTerminal, type Terminal, Text, TuiAltScreen, VStack } from "@earendil-works/pi-tui";

import {
  type FlowPresentationComponent,
  type FlowPresentationDocument,
  parseFlowPresentationDocument,
} from "../../domain/presentation/flow-presentation.js";

const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";
const INVERSE = "\u001b[7m";

export interface FlowTerminalRendererOptions {
  readonly terminal: Terminal;
  readonly onAction: (actionId: string) => Promise<void>;
  readonly onExit: () => void;
}

export interface InteractiveRunPresentationRenderer {
  readonly start: () => void;
  readonly render: (document: FlowPresentationDocument) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function isProcessTerminalInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function createProcessFlowTerminalRenderer(
  options: Omit<FlowTerminalRendererOptions, "terminal">,
): InteractiveRunPresentationRenderer {
  return new FlowTerminalRenderer({ ...options, terminal: new ProcessTerminal() });
}

export class FlowTerminalRendererError extends Error {
  override readonly name = "FlowTerminalRendererError";
}

export class FlowTerminalRenderer implements InteractiveRunPresentationRenderer {
  readonly #tui: TuiAltScreen;
  readonly #text = new Text();
  readonly #onAction: (actionId: string) => Promise<void>;
  readonly #onExit: () => void;
  #state: "new" | "active" | "closed" = "new";
  #removeInputListener: (() => void) | undefined;
  #document: FlowPresentationDocument | undefined;
  #selectedAction = 0;
  #actionPending = false;
  #actionNotice: "Action failed." | "Action submitted." | undefined;

  constructor(options: FlowTerminalRendererOptions) {
    this.#tui = new TuiAltScreen(options.terminal, false, undefined, { mouse: false });
    this.#tui.setLayoutRoot(new VStack([this.#text]));
    this.#onAction = options.onAction;
    this.#onExit = options.onExit;
  }

  start(): void {
    if (this.#state === "closed") {
      throw new FlowTerminalRendererError(
        "Cannot render Flow terminal presentation: renderer is closed",
      );
    }
    if (this.#state === "active") {
      throw new FlowTerminalRendererError(
        "Cannot render Flow terminal presentation: renderer is already active",
      );
    }
    this.#removeInputListener = this.#tui.addInputListener((data) => {
      this.#handleInput(data);
      return { consume: true };
    });
    try {
      this.#tui.start();
      this.#state = "active";
    } catch {
      this.#state = "closed";
      this.#removeInputListener?.();
      this.#removeInputListener = undefined;
      try {
        this.#tui.stop();
      } catch {
        // The fixed start stage remains primary after best-effort terminal restoration.
      }
      throw new FlowTerminalRendererError(
        "Cannot render Flow terminal presentation: start renderer",
      );
    }
  }

  async render(input: FlowPresentationDocument): Promise<void> {
    if (this.#state !== "active") {
      throw new FlowTerminalRendererError(
        "Cannot render Flow terminal presentation: renderer is not active",
      );
    }
    let document: FlowPresentationDocument;
    try {
      document = parseFlowPresentationDocument(input);
    } catch {
      throw new FlowTerminalRendererError(
        "Cannot render Flow terminal presentation: document is invalid",
      );
    }
    this.#document = document;
    this.#selectedAction = Math.min(this.#selectedAction, Math.max(0, document.actions.length - 1));
    this.#actionNotice = undefined;
    this.#draw();
  }

  async close(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#removeInputListener?.();
    this.#removeInputListener = undefined;
    try {
      this.#tui.stop();
    } catch {
      throw new FlowTerminalRendererError(
        "Cannot render Flow terminal presentation: restore terminal",
      );
    }
  }

  #handleInput(data: string): void {
    if (this.#state !== "active") {
      return;
    }
    if (data === "q" || data === "\u0003") {
      this.#onExit();
      return;
    }
    const actionCount = this.#document?.actions.length ?? 0;
    if ((data === "j" || data === "\u001b[B") && actionCount > 0) {
      this.#selectedAction = (this.#selectedAction + 1) % actionCount;
      this.#draw();
      return;
    }
    if ((data === "k" || data === "\u001b[A") && actionCount > 0) {
      this.#selectedAction = (this.#selectedAction - 1 + actionCount) % actionCount;
      this.#draw();
      return;
    }
    if ((data === "\r" || data === "\n") && !this.#actionPending) {
      const action = this.#document?.actions[this.#selectedAction];
      if (action !== undefined) {
        this.#actionPending = true;
        this.#actionNotice = undefined;
        void this.#onAction(action.actionId)
          .then(() => {
            this.#actionNotice = "Action submitted.";
          })
          .catch(() => {
            this.#actionNotice = "Action failed.";
          })
          .finally(() => {
            this.#actionPending = false;
            this.#draw();
          });
      }
    }
  }

  #draw(): void {
    if (this.#state !== "active" || this.#document === undefined) {
      return;
    }
    this.#text.setText(
      formatFlowPresentation(this.#document, this.#selectedAction, this.#actionNotice),
    );
    this.#tui.renderNow(true);
  }
}

export function formatFlowPresentation(
  input: FlowPresentationDocument,
  selectedAction: number,
  actionNotice?: string,
): string {
  const document = parseFlowPresentationDocument(input);
  const lines: string[] = [];
  for (const [sectionIndex, section] of document.sections.entries()) {
    if (section.title !== undefined) {
      lines.push(`${BOLD}${CYAN}${section.title}${RESET}`);
    }
    for (const component of section.components) {
      lines.push(...formatComponent(component));
    }
    if (sectionIndex < document.sections.length - 1) {
      lines.push(...presentationSpacing(document.layout?.density));
    }
  }
  if (document.truncated) {
    lines.push(
      `${YELLOW}The bounded view is truncated; use the JSON commands for full detail.${RESET}`,
    );
  }
  if (document.actions.length > 0) {
    lines.push(`${BOLD}Actions${RESET} ${DIM}(j/k or arrows, Enter, q to quit)${RESET}`);
    for (const [index, action] of document.actions.entries()) {
      const prefix = index === selectedAction ? ">" : " ";
      const content = `${prefix} ${index + 1}. ${action.label}`;
      lines.push(index === selectedAction ? `${INVERSE}${content}${RESET}` : content);
    }
  } else {
    lines.push(`${DIM}Press q to close.${RESET}`);
  }
  if (actionNotice !== undefined) {
    lines.push(
      actionNotice === "Action failed."
        ? `${RED}${actionNotice}${RESET}`
        : `${GREEN}${actionNotice}${RESET}`,
    );
  }
  return lines.join("\n").trimEnd();
}

function presentationSpacing(density: "compact" | "comfortable" | undefined): readonly string[] {
  return density === "compact" ? [] : density === "comfortable" ? ["", ""] : [""];
}

function formatComponent(component: FlowPresentationComponent): readonly string[] {
  switch (component.kind) {
    case "heading":
      return [`${BOLD}${component.text}${RESET}`];
    case "facts":
      return component.items.map((item) => `${BOLD}${item.label}:${RESET} ${item.value}`);
    case "progress": {
      const width = 20;
      const filled =
        component.total === 0
          ? 0
          : Math.min(width, Math.floor((component.completed / component.total) * width));
      return [
        `${component.label} [${GREEN}${"#".repeat(filled)}${DIM}${"-".repeat(width - filled)}${RESET}] ${component.completed}/${component.total}`,
      ];
    }
    case "table":
      return [
        `${BOLD}${component.columns.map((column) => column.label).join(" | ")}${RESET}`,
        ...component.rows.map((row) => row.cells.join(" | ")),
        ...(component.truncated ? [`${YELLOW}Table truncated.${RESET}`] : []),
      ];
    case "notice":
      return [`${noticeColor(component.tone)}${component.text}${RESET}`];
    case "divider":
      return [`${DIM}${"─".repeat(48)}${RESET}`];
  }
}

function noticeColor(
  tone: Extract<FlowPresentationComponent, { readonly kind: "notice" }>["tone"],
): string {
  switch (tone) {
    case "info":
      return CYAN;
    case "success":
      return GREEN;
    case "warning":
      return YELLOW;
    case "danger":
      return RED;
  }
}
