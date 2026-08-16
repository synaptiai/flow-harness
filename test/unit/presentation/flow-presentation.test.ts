import { describe, expect, it } from "vitest";

import {
  encodeFlowPresentationDocument,
  FLOW_PRESENTATION_API_VERSION,
  type FlowPresentationDocument,
  FlowPresentationError,
  MAX_FLOW_PRESENTATION_ACTIONS,
  MAX_FLOW_PRESENTATION_BYTES,
  MAX_FLOW_PRESENTATION_COLUMNS,
  MAX_FLOW_PRESENTATION_COMPONENTS_PER_SECTION,
  MAX_FLOW_PRESENTATION_FACTS,
  MAX_FLOW_PRESENTATION_JSON_DEPTH,
  MAX_FLOW_PRESENTATION_JSON_NODES,
  MAX_FLOW_PRESENTATION_ROWS,
  MAX_FLOW_PRESENTATION_SECTIONS,
  parseFlowPresentationDocument,
} from "../../../src/domain/presentation/flow-presentation.js";
import { MAX_SAFE_DISPLAY_TEXT_BYTES } from "../../../src/domain/presentation/safe-display-text.js";

describe("Flow presentation document", () => {
  it("accepts the closed version 1 component and action catalog", () => {
    const document = parseFlowPresentationDocument(completeDocument());

    expect(document.apiVersion).toBe(FLOW_PRESENTATION_API_VERSION);
    expect(document.sections[0]?.components.map((component) => component.kind)).toEqual([
      "heading",
      "facts",
      "progress",
      "table",
      "notice",
      "divider",
    ]);
    expect(document.actions.map((action) => action.kind)).toEqual(["approve", "deny", "cancel"]);
    expect(
      parseFlowPresentationDocument(JSON.parse(encodeFlowPresentationDocument(document))),
    ).toEqual(document);
  });

  it.each([
    ["root", { ...completeDocument(), privateValue: "PRIVATE_ROOT" }],
    [
      "run",
      {
        ...completeDocument(),
        run: { ...completeDocument().run, privateValue: "PRIVATE_RUN" },
      },
    ],
    [
      "section",
      {
        ...completeDocument(),
        sections: [{ ...completeDocument().sections[0], privateValue: "PRIVATE_SECTION" }],
      },
    ],
    [
      "component",
      {
        ...completeDocument(),
        sections: [{ id: "overview", components: [{ kind: "PRIVATE_COMPONENT" }] }],
      },
    ],
    [
      "action",
      { ...completeDocument(), actions: [{ kind: "PRIVATE_ACTION", actionId: "private" }] },
    ],
  ])("rejects unknown %s fields or union members", (_label, input) => {
    expect(() => parseFlowPresentationDocument(input)).toThrow(FlowPresentationError);
  });

  it("rejects terminal-active text rather than delegating safety to a renderer", () => {
    const input = completeDocument();
    const firstSection = input.sections[0];
    if (firstSection === undefined) {
      throw new Error("test fixture must contain a section");
    }
    firstSection.components[0] = {
      kind: "heading",
      level: 1,
      text: "\u001b]52;c;PRIVATE_CLIPBOARD\u0007",
    };

    expect(() => parseFlowPresentationDocument(input)).toThrow(
      "Flow presentation document is invalid",
    );
  });

  it.each([
    [
      "duplicate section ids",
      {
        ...minimalDocument(),
        sections: [
          { id: "duplicate", components: [{ kind: "divider" }] },
          { id: "duplicate", components: [{ kind: "divider" }] },
        ],
      },
    ],
    [
      "duplicate action ids",
      {
        ...minimalDocument(),
        actions: [
          { kind: "cancel", actionId: "duplicate", runId: "run-1", label: "Cancel one" },
          { kind: "cancel", actionId: "duplicate", runId: "run-1", label: "Cancel two" },
        ],
      },
    ],
    ["duplicate table column keys", tableDocument(["value", "value"], [["one", "two"]])],
    [
      "duplicate table row ids",
      tableDocument(["value"], [["one"], ["two"]], ["duplicate", "duplicate"]),
    ],
    ["table cell count mismatch", tableDocument(["left", "right"], [["one"]])],
    [
      "progress beyond total",
      {
        ...minimalDocument(),
        sections: [
          {
            id: "progress",
            components: [{ kind: "progress", label: "Work", completed: 2, total: 1 }],
          },
        ],
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => parseFlowPresentationDocument(input)).toThrow(
      "Flow presentation document is invalid",
    );
  });

  it.each([
    [
      "sections",
      () => ({
        ...minimalDocument(),
        sections: Array.from({ length: MAX_FLOW_PRESENTATION_SECTIONS + 1 }, (_, index) => ({
          id: `section-${index}`,
          components: [{ kind: "divider" }],
        })),
      }),
    ],
    [
      "section components",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "components",
            components: Array.from(
              { length: MAX_FLOW_PRESENTATION_COMPONENTS_PER_SECTION + 1 },
              () => ({ kind: "divider" }),
            ),
          },
        ],
      }),
    ],
    [
      "facts",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "facts",
            components: [
              {
                kind: "facts",
                items: Array.from({ length: MAX_FLOW_PRESENTATION_FACTS + 1 }, (_, index) => ({
                  label: `Fact ${index}`,
                  value: String(index),
                })),
              },
            ],
          },
        ],
      }),
    ],
    [
      "table columns",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "table",
            components: [
              {
                kind: "table",
                columns: Array.from({ length: MAX_FLOW_PRESENTATION_COLUMNS + 1 }, (_, index) => ({
                  key: `column-${index}`,
                  label: `Column ${index}`,
                })),
                rows: [],
                truncated: false,
              },
            ],
          },
        ],
      }),
    ],
    [
      "table rows",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "table",
            components: [
              {
                kind: "table",
                columns: [{ key: "value", label: "Value" }],
                rows: Array.from({ length: MAX_FLOW_PRESENTATION_ROWS + 1 }, (_, index) => ({
                  id: `row-${index}`,
                  cells: [`Row ${index}`],
                })),
                truncated: false,
              },
            ],
          },
        ],
      }),
    ],
    [
      "actions",
      () => ({
        ...minimalDocument(),
        actions: Array.from({ length: MAX_FLOW_PRESENTATION_ACTIONS + 1 }, (_, index) => ({
          kind: "cancel",
          actionId: `cancel-${index}`,
          runId: "run-1",
          label: `Cancel ${index}`,
        })),
      }),
    ],
  ])("rejects excessive %s", (_label, createInput) => {
    expect(() => parseFlowPresentationDocument(createInput())).toThrow(FlowPresentationError);
  });

  it.each([
    [
      "sections",
      () => ({
        ...minimalDocument(),
        sections: Array.from({ length: MAX_FLOW_PRESENTATION_SECTIONS }, (_, index) => ({
          id: `section-${index}`,
          components: [{ kind: "divider" }],
        })),
      }),
    ],
    [
      "section components",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "components",
            components: Array.from(
              { length: MAX_FLOW_PRESENTATION_COMPONENTS_PER_SECTION },
              () => ({ kind: "divider" }),
            ),
          },
        ],
      }),
    ],
    [
      "facts",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "facts",
            components: [
              {
                kind: "facts",
                items: Array.from({ length: MAX_FLOW_PRESENTATION_FACTS }, (_, index) => ({
                  label: `Fact ${index}`,
                  value: String(index),
                })),
              },
            ],
          },
        ],
      }),
    ],
    [
      "table columns",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "columns",
            components: [
              {
                kind: "table",
                columns: Array.from({ length: MAX_FLOW_PRESENTATION_COLUMNS }, (_, index) => ({
                  key: `column-${index}`,
                  label: `Column ${index}`,
                })),
                rows: [],
                truncated: false,
              },
            ],
          },
        ],
      }),
    ],
    [
      "table rows",
      () => ({
        ...minimalDocument(),
        sections: [
          {
            id: "rows",
            components: [
              {
                kind: "table",
                columns: [{ key: "value", label: "Value" }],
                rows: Array.from({ length: MAX_FLOW_PRESENTATION_ROWS }, (_, index) => ({
                  id: `row-${index}`,
                  cells: [String(index)],
                })),
                truncated: false,
              },
            ],
          },
        ],
      }),
    ],
    [
      "actions",
      () => ({
        ...minimalDocument(),
        actions: Array.from({ length: MAX_FLOW_PRESENTATION_ACTIONS }, (_, index) => ({
          kind: "cancel",
          actionId: `cancel-${index}`,
          runId: "run-1",
          label: `Cancel ${index}`,
        })),
      }),
    ],
  ])("accepts the exact %s bound", (_label, createInput) => {
    expect(() => parseFlowPresentationDocument(createInput())).not.toThrow();
  });

  it("accepts the exact JSON shape bounds and rejects one value or level more", () => {
    const exactNodes = Array.from({ length: MAX_FLOW_PRESENTATION_JSON_NODES - 1 }, () => null);
    const excessiveNodes = [...exactNodes, null];
    const exactDepth = nestedJsonValue(MAX_FLOW_PRESENTATION_JSON_DEPTH);
    const excessiveDepth = nestedJsonValue(MAX_FLOW_PRESENTATION_JSON_DEPTH + 1);

    expect(() => parseFlowPresentationDocument(exactNodes)).toThrow(
      "Flow presentation document is invalid",
    );
    expect(() => parseFlowPresentationDocument(excessiveNodes)).toThrow(
      "Flow presentation document contains too many values",
    );
    expect(() => parseFlowPresentationDocument(exactDepth)).toThrow(
      "Flow presentation document is invalid",
    );
    expect(() => parseFlowPresentationDocument(excessiveDepth)).toThrow(
      "Flow presentation document is too deeply nested",
    );
  });

  it("accepts the exact canonical document byte limit and rejects one byte more", () => {
    const exact = exactByteDocument();
    const encoded = JSON.stringify(exact);

    expect(Buffer.byteLength(encoded, "utf8")).toBe(MAX_FLOW_PRESENTATION_BYTES);
    expect(parseFlowPresentationDocument(exact)).toEqual(exact);

    const excessive = structuredClone(exact);
    const table = excessive.sections[0]?.components[0];
    if (table?.kind !== "table") {
      throw new Error("test fixture must contain a table");
    }
    const lastRow = table.rows.at(-1);
    if (lastRow === undefined) {
      throw new Error("test fixture must contain table rows");
    }
    const lastCell = lastRow.cells.at(-1);
    if (lastCell === undefined) {
      throw new Error("test fixture must contain table cells");
    }
    lastRow.cells[lastRow.cells.length - 1] = `${lastCell}x`;
    expect(Buffer.byteLength(JSON.stringify(excessive), "utf8")).toBe(
      MAX_FLOW_PRESENTATION_BYTES + 1,
    );
    expect(() => parseFlowPresentationDocument(excessive)).toThrow(
      `Flow presentation document must not exceed ${MAX_FLOW_PRESENTATION_BYTES} UTF-8 bytes`,
    );
  });
});

function minimalDocument(): FlowPresentationDocument {
  return {
    apiVersion: FLOW_PRESENTATION_API_VERSION,
    run: {
      runId: "run-1",
      workflowId: "workflow-1",
      status: "running",
      sequence: 1,
    },
    sections: [{ id: "overview", components: [{ kind: "divider" }] }],
    actions: [],
    truncated: false,
  };
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
          {
            kind: "facts",
            items: [
              { label: "Run", value: "run-1" },
              { label: "Workflow", value: "workflow-1" },
            ],
          },
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
        label: "Approve request-1",
      },
      {
        kind: "deny",
        actionId: "deny:request-1",
        requestId: "request-1",
        label: "Deny request-1",
      },
      { kind: "cancel", actionId: "cancel:run-1", runId: "run-1", label: "Cancel run" },
    ],
    truncated: false,
  };
}

function exactByteDocument(): FlowPresentationDocument {
  const cells = Array.from({ length: MAX_FLOW_PRESENTATION_ROWS }, () =>
    Array.from({ length: MAX_FLOW_PRESENTATION_COLUMNS }, () => "x"),
  );
  const document: FlowPresentationDocument = {
    ...minimalDocument(),
    sections: [
      {
        id: "bounded-table",
        components: [
          {
            kind: "table",
            columns: Array.from({ length: MAX_FLOW_PRESENTATION_COLUMNS }, (_, index) => ({
              key: `c${index}`,
              label: `C${index}`,
            })),
            rows: cells.map((row, index) => ({ id: `r${index}`, cells: row })),
            truncated: false,
          },
        ],
      },
    ],
  };
  let remaining = MAX_FLOW_PRESENTATION_BYTES - Buffer.byteLength(JSON.stringify(document), "utf8");
  for (const row of cells) {
    for (let index = 0; index < row.length && remaining > 0; index += 1) {
      const current = row[index];
      if (current === undefined) {
        throw new Error("test fixture must contain every table cell");
      }
      const added = Math.min(remaining, MAX_SAFE_DISPLAY_TEXT_BYTES - current.length);
      row[index] = `${current}${"x".repeat(added)}`;
      remaining -= added;
    }
  }
  expect(remaining).toBe(0);
  return document;
}

function nestedJsonValue(depth: number): unknown {
  let value: unknown = null;
  for (let index = 1; index < depth; index += 1) {
    value = { value };
  }
  return value;
}

function tableDocument(
  columnKeys: readonly string[],
  cells: readonly (readonly string[])[],
  rowIds: readonly string[] = cells.map((_, index) => `row-${index}`),
): unknown {
  return {
    ...minimalDocument(),
    sections: [
      {
        id: "table",
        components: [
          {
            kind: "table",
            columns: columnKeys.map((key) => ({ key, label: key })),
            rows: cells.map((row, index) => ({ id: rowIds[index], cells: row })),
            truncated: false,
          },
        ],
      },
    ],
  };
}
