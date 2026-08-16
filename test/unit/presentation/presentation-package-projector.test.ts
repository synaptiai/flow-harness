import { describe, expect, it } from "vitest";

import { createPresentationPackageSnapshot } from "../../../src/domain/capability/presentation-packages.js";
import type { FlowPresentationDocument } from "../../../src/domain/presentation/flow-presentation.js";
import { applyPresentationPackage } from "../../../src/domain/presentation/presentation-package-projector.js";

const encoder = new TextEncoder();

describe("presentation package projection", () => {
  it("reorders only host-owned widgets and preserves actions exactly", () => {
    const source = document();
    const projected = applyPresentationPackage(source, snapshot("compact", "separated"));

    expect(projected.layout).toEqual({ density: "compact" });
    expect(projected.sections.map((section) => section.id)).toEqual([
      "resource-facts",
      "run-summary",
      "graph-progress",
      "node-table",
      "pending-approvals",
      "outcome-notice",
    ]);
    expect(projected.sections[0]?.components.at(-1)).toEqual({ kind: "divider" });
    expect(projected.actions).toEqual(source.actions);
    expect(projected.run).toEqual(source.run);
    expect(projected.truncated).toBe(source.truncated);
    expect(JSON.stringify(projected)).not.toContain("PresentationPackage");
  });

  it("omits inapplicable conditional widgets without changing the declared package", () => {
    const source = document();
    const projected = applyPresentationPackage(
      {
        ...source,
        sections: source.sections.filter(
          (section) => !["approvals", "outcome"].includes(section.id),
        ),
      },
      snapshot("comfortable", "stack"),
    );

    expect(projected.layout).toEqual({ density: "comfortable" });
    expect(projected.sections.map((section) => section.id)).toEqual([
      "resource-facts",
      "run-summary",
      "graph-progress",
      "node-table",
    ]);
  });
});

function snapshot(density: "compact" | "comfortable", variant: "stack" | "separated") {
  const content = `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata:
  name: operations
  version: 1.0.0
  description: Operator layout
spec:
  messages:
    - version: v0.9
      createSurface:
        surfaceId: flow-run
        catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - id: root
            component: FlowLayout
            density: ${density}
            children: [group-1]
          - id: group-1
            component: FlowGroup
            variant: ${variant}
            children: [resource-facts, run-summary, graph-progress, node-table, pending-approvals, outcome-notice]
          - id: run-summary
            component: FlowRunSummary
          - id: graph-progress
            component: FlowGraphProgress
          - id: node-table
            component: FlowNodeTable
          - id: resource-facts
            component: FlowResourceFacts
          - id: pending-approvals
            component: FlowPendingApprovals
          - id: outcome-notice
            component: FlowOutcomeNotice
`;
  return createPresentationPackageSnapshot({
    kind: "presentation-package",
    trust: "project-explicit",
    provenance: "presentations/operations",
    manifest: { content: encoder.encode(content) },
  });
}

function document(): FlowPresentationDocument {
  return {
    apiVersion: "flow.synapti.ai/presentation/v1",
    run: { runId: "run-1", workflowId: "workflow-1", status: "waiting_for_approval", sequence: 2 },
    sections: [
      {
        id: "overview",
        title: "Run overview",
        components: [
          { kind: "heading", level: 1, text: "Flow run" },
          { kind: "facts", items: [{ label: "Run", value: "run-1" }] },
          { kind: "progress", label: "Settled nodes", completed: 1, total: 2 },
        ],
      },
      {
        id: "nodes",
        title: "Graph progress",
        components: [
          { kind: "table", columns: [{ key: "node", label: "Node" }], rows: [], truncated: false },
        ],
      },
      {
        id: "resources",
        title: "Resource use",
        components: [{ kind: "facts", items: [{ label: "Node starts", value: "1" }] }],
      },
      {
        id: "approvals",
        title: "Pending approvals",
        components: [
          {
            kind: "table",
            columns: [{ key: "request", label: "Request" }],
            rows: [],
            truncated: false,
          },
        ],
      },
      {
        id: "outcome",
        title: "Outcome",
        components: [{ kind: "notice", tone: "warning", text: "Waiting" }],
      },
    ],
    actions: [{ kind: "cancel", actionId: "cancel:run-1", runId: "run-1", label: "Cancel run" }],
    truncated: true,
  };
}
