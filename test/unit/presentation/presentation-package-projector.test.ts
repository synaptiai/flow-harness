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

  it("appends visibly attributed package notes without changing host authority", () => {
    const source = document();
    const projected = applyPresentationPackage(source, contentSnapshot());

    expect(projected.sections.at(-1)).toEqual({
      id: "presentation-package-content",
      title: "Package-provided information — operations@1.0.0",
      components: [
        {
          kind: "notice",
          tone: "info",
          text: "The selected presentation package provides this information. It is not Flow status or an action.",
        },
        { kind: "heading", level: 2, text: "Operator context" },
        { kind: "notice", tone: "info", text: "Use <b>literal text</b> during review." },
        { kind: "heading", level: 2, text: "Authority" },
        { kind: "notice", tone: "info", text: "Flow still owns run status and actions." },
      ],
    });
    expect(projected.run).toEqual(source.run);
    expect(projected.actions).toEqual(source.actions);
    expect(projected.truncated).toBe(source.truncated);
    expect(projected.layout).toEqual({ density: "compact" });
  });

  it.each([
    [
      "an unfamiliar overview component",
      () => {
        const source = document();
        return {
          ...source,
          sections: source.sections.map((section) =>
            section.id === "overview"
              ? {
                  ...section,
                  components: [
                    ...section.components,
                    { kind: "notice" as const, tone: "danger" as const, text: "Host warning" },
                  ],
                }
              : section,
          ),
        };
      },
    ],
    [
      "an unfamiliar host section",
      () => {
        const source = document();
        return {
          ...source,
          sections: [
            ...source.sections,
            {
              id: "new-host-evidence",
              title: "New host evidence",
              components: [
                { kind: "notice" as const, tone: "danger" as const, text: "Host warning" },
              ],
            },
          ],
        };
      },
    ],
  ])("fails closed instead of suppressing %s", (_label, changed) => {
    expect(() => applyPresentationPackage(changed(), snapshot("compact", "stack"))).toThrow(
      "Cannot apply Flow presentation package",
    );
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

function contentSnapshot() {
  const content = `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata:
  name: operations
  version: 1.0.0
  description: Operator layout with attributed information
spec:
  messages:
    - version: v0.9
      createSurface:
        surfaceId: flow-run
        catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v2
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - id: root
            component: FlowLayout
            density: compact
            children: [group-1, package-notes]
          - id: group-1
            component: FlowGroup
            variant: stack
            children: [resource-facts, run-summary, graph-progress, node-table, pending-approvals, outcome-notice]
          - id: package-notes
            component: FlowPackageNotes
            notes:
              - title: Operator context
                body: Use <b>literal text</b> during review.
              - title: Authority
                body: Flow still owns run status and actions.
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
