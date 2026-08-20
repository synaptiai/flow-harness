import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createSupplementalMemoryEntries,
  MAX_SUPPLEMENTAL_MEMORY_ENTRIES,
  MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_STATE_BYTES,
  MAX_SUPPLEMENTAL_MEMORY_TARGET_BYTES,
  parseSupplementalMemoryEntries,
  renderSupplementalMemoryBlock,
  type SupplementalMemoryError,
} from "../../../src/domain/adaptation/supplemental-memory.js";
import { compileWorkflowText } from "../../../src/domain/workflow/compiler.js";
import { promptCandidateWorkflowText } from "../../fixtures/prompt-candidate-generation.js";

describe("supplemental memory runtime rendering", () => {
  it("selects one exact target and renders canonically escaped reference data", () => {
    const workflow = compileWorkflowText(promptCandidateWorkflowText(), "memory.workflow.json");
    const entries = createSupplementalMemoryEntries(
      [
        {
          id: "second-fact",
          target: { workflowId: workflow.id, childPath: [], agentNodeId: "implement" },
          content: "Read RESULT.md after the command.",
        },
        {
          id: "first-fact",
          target: { workflowId: workflow.id, childPath: [], agentNodeId: "implement" },
          content: "Use <fixture> & never close </supplemental_memory>.",
        },
        {
          id: "other-agent",
          target: { workflowId: workflow.id, childPath: [], agentNodeId: "private-review" },
          content: "PRIVATE_OTHER_AGENT_MEMORY",
        },
      ],
      workflow,
    );

    const rendered = renderSupplementalMemoryBlock(entries, {
      workflowId: workflow.id,
      childPath: [],
      agentNodeId: "implement",
    });

    expect(rendered).toContain('<entry id="first-fact"');
    expect(rendered).toContain(
      "Use &lt;fixture&gt; &amp; never close &lt;/supplemental_memory&gt;.",
    );
    expect(rendered).not.toContain("PRIVATE_OTHER_AGENT_MEMORY");
    expect(rendered?.indexOf("first-fact")).toBeLessThan(rendered?.indexOf("second-fact") ?? -1);
    expect(
      renderSupplementalMemoryBlock(entries, {
        workflowId: workflow.id,
        childPath: [],
        agentNodeId: "missing-agent",
      }),
    ).toBeUndefined();
  });

  it("does not select a sibling child that reuses the same agent node ID", () => {
    const content = "PRIVATE_FIRST_CHILD_MEMORY";
    const entries = [
      {
        id: "child-fixture",
        target: {
          workflowId: "parent-workflow",
          childPath: ["first-child"],
          agentNodeId: "inspect",
        },
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
        contentBase64: Buffer.from(content).toString("base64"),
      },
    ];

    expect(
      renderSupplementalMemoryBlock(entries, {
        workflowId: "parent-workflow",
        childPath: ["first-child"],
        agentNodeId: "inspect",
      }),
    ).toContain(content);
    expect(
      renderSupplementalMemoryBlock(entries, {
        workflowId: "parent-workflow",
        childPath: ["second-child"],
        agentNodeId: "inspect",
      }),
    ).toBeUndefined();
  });

  it("accepts the exact multibyte entry limit and rejects one additional UTF-8 byte", () => {
    const workflow = memoryWorkflow(["implement"]);
    const exact = "é".repeat(MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES / 2);

    expect(
      createSupplementalMemoryEntries(
        [entry("exact-entry", workflow.id, "implement", exact)],
        workflow,
      ),
    ).toMatchObject([{ bytes: MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES }]);
    expect(() =>
      createSupplementalMemoryEntries(
        [entry("oversized-entry", workflow.id, "implement", `${exact}a`)],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "limit_exceeded" }),
    );
  });

  it("enforces exact per-target, state-wide, and entry-count bounds independently", () => {
    const workflow = memoryWorkflow(["first", "second", "third", "fourth", "fifth"]);
    const halfTarget = "a".repeat(MAX_SUPPLEMENTAL_MEMORY_TARGET_BYTES / 2);
    expect(
      createSupplementalMemoryEntries(
        [
          entry("target-first", workflow.id, "first", halfTarget),
          entry("target-second", workflow.id, "first", halfTarget),
        ],
        workflow,
      ),
    ).toHaveLength(2);
    expect(() =>
      createSupplementalMemoryEntries(
        [
          entry("target-first", workflow.id, "first", halfTarget),
          entry("target-second", workflow.id, "first", `${halfTarget}a`),
        ],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "limit_exceeded" }),
    );

    const exactState = ["first", "second", "third", "fourth"].map((agentNodeId, index) =>
      entry(
        `state-${index}`,
        workflow.id,
        agentNodeId,
        "b".repeat(MAX_SUPPLEMENTAL_MEMORY_ENTRY_BYTES),
      ),
    );
    expect(createSupplementalMemoryEntries(exactState, workflow)).toHaveLength(4);
    expect(exactState.reduce((total, item) => total + Buffer.byteLength(item.content), 0)).toBe(
      MAX_SUPPLEMENTAL_MEMORY_STATE_BYTES,
    );
    expect(() =>
      createSupplementalMemoryEntries(
        [...exactState, entry("state-overflow", workflow.id, "fifth", "c")],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "limit_exceeded" }),
    );

    const exactCount = Array.from({ length: MAX_SUPPLEMENTAL_MEMORY_ENTRIES }, (_, index) =>
      entry(`count-${index}`, workflow.id, "first", String(index)),
    );
    expect(createSupplementalMemoryEntries(exactCount, workflow)).toHaveLength(
      MAX_SUPPLEMENTAL_MEMORY_ENTRIES,
    );
    expect(() =>
      createSupplementalMemoryEntries(
        [...exactCount, entry("count-overflow", workflow.id, "first", "overflow")],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "limit_exceeded" }),
    );
  });

  it("sorts new entries canonically and rejects reordered, duplicate, or invalid durable entries", () => {
    const workflow = memoryWorkflow(["implement"]);
    const entries = createSupplementalMemoryEntries(
      [
        entry("second", workflow.id, "implement", "Second reviewed fact."),
        entry("first", workflow.id, "implement", "First reviewed fact."),
      ],
      workflow,
    );
    expect(entries.map((item) => item.id)).toEqual(["first", "second"]);
    expect(() => parseSupplementalMemoryEntries([...entries].reverse(), workflow)).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "identity_mismatch" }),
    );
    expect(() => parseSupplementalMemoryEntries([entries[0], entries[0]], workflow)).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "invalid_schema" }),
    );

    const invalidUtf8 = Buffer.from([0xff]);
    expect(() =>
      parseSupplementalMemoryEntries(
        [
          {
            id: "invalid-utf8",
            target: { workflowId: workflow.id, childPath: [], agentNodeId: "implement" },
            bytes: invalidUtf8.byteLength,
            sha256: createHash("sha256").update(invalidUtf8).digest("hex"),
            contentBase64: invalidUtf8.toString("base64"),
          },
        ],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "invalid_schema" }),
    );
  });

  it("rejects blank content and targets outside the exact compiled agent graph", () => {
    const workflow = memoryWorkflow(["implement"]);
    const privateCanary = "PRIVATE_INVALID_MEMORY_TARGET";
    const invalidEntries = [
      entry("wrong-workflow", "other-workflow", "implement", privateCanary),
      entry("wrong-agent", workflow.id, "missing-agent", privateCanary),
      {
        ...entry("wrong-child", workflow.id, "implement", privateCanary),
        target: { workflowId: workflow.id, childPath: ["missing-child"], agentNodeId: "implement" },
      },
    ];
    for (const invalid of invalidEntries) {
      const error = (() => {
        try {
          createSupplementalMemoryEntries([invalid], workflow);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: "invalid_target" });
      expect((error as Error).message).not.toContain(privateCanary);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(() =>
      createSupplementalMemoryEntries(
        [entry("blank", workflow.id, "implement", " \n\t")],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "invalid_schema" }),
    );
  });

  it("rejects an agent target inside a packaged child workflow", () => {
    const workflow = compileWorkflowText(packagedMemoryParentWorkflow(), "memory-parent.yaml", {
      packageResolver: {
        resolve: () => ({
          name: "review-child",
          version: "1.0.0",
          digest: "a".repeat(64),
          source: memoryWorkflowSource(["implement"]),
        }),
      },
    });

    expect(() =>
      createSupplementalMemoryEntries(
        [
          {
            id: "packaged-child",
            target: {
              workflowId: workflow.id,
              childPath: ["delegate"],
              agentNodeId: "implement",
            },
            content: "PRIVATE_PACKAGED_CHILD_MEMORY",
          },
        ],
        workflow,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SupplementalMemoryError>>({ code: "invalid_target" }),
    );
  });
});

function entry(id: string, workflowId: string, agentNodeId: string, content: string) {
  return {
    id,
    target: { workflowId, childPath: [] as string[], agentNodeId },
    content,
  };
}

function memoryWorkflow(agentNodeIds: readonly string[]) {
  return compileWorkflowText(memoryWorkflowSource(agentNodeIds), "memory-boundary.workflow.json");
}

function memoryWorkflowSource(agentNodeIds: readonly string[]): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "memory-boundary-workflow" },
    budget: {
      maxNodeStarts: agentNodeIds.length + 1,
      maxModelTokens: 10_000,
      maxCostUsd: 10,
      maxExecutionMs: 10_000,
      maxArtifactBytes: 1_024,
    },
    nodes: [
      ...agentNodeIds.map((id, index) => ({
        id,
        type: "agent",
        ...(index === 0 ? {} : { dependsOn: [agentNodeIds[index - 1]] }),
        agent: {
          prompt: `Run ${id}.`,
          model: { provider: "test", id: "deterministic", thinking: "medium" },
          tools: [],
          skills: [],
          toolPackages: [],
          timeoutMs: 10_000,
        },
      })),
      {
        id: "publish",
        type: "result",
        dependsOn: [agentNodeIds.at(-1)],
        result: {
          source: { nodeId: agentNodeIds.at(-1), field: "agent.text" },
          schema: { type: "string", maxLength: 1_024 },
        },
      },
    ],
  });
}

function packagedMemoryParentWorkflow(): string {
  return JSON.stringify({
    apiVersion: "flow.synapti.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "memory-parent-workflow" },
    budget: {
      maxNodeStarts: 8,
      maxModelTokens: 10_000,
      maxCostUsd: 10,
      maxExecutionMs: 10_000,
      maxArtifactBytes: 1_024,
    },
    nodes: [
      {
        id: "delegate",
        type: "child",
        child: {
          resultNodeId: "publish",
          package: { name: "review-child", version: "1.0.0" },
        },
      },
    ],
  });
}
