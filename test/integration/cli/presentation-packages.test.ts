import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CliIo, main } from "../../../src/cli/main.js";
import { resolveFlowConfig } from "../../../src/domain/config/resolver.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("presentation package CLI", () => {
  it("lists, inspects, and validates exact content-bearing package evidence", async () => {
    const project = await fixture();
    const config = resolveFlowConfig({ projectRoot: project });
    const listed = capture();
    const inspected = capture();
    const validated = capture();

    expect(
      await main(["presentations", "list"], listed.io, {
        cwd: project,
        loadConfig: async () => config,
      }),
    ).toBe(0);
    expect(
      await main(["presentations", "inspect", "operations", "--version", "1.0.0"], inspected.io, {
        cwd: project,
        loadConfig: async () => config,
      }),
    ).toBe(0);
    expect(
      await main(
        ["presentations", "validate", ".flow/presentations/operations/PRESENTATION.yaml"],
        validated.io,
        {
          cwd: project,
          loadConfig: async () => config,
        },
      ),
    ).toBe(0);

    expect(JSON.parse(listed.stdout[0] ?? "null")).toMatchObject({
      packages: [
        {
          name: "operations",
          version: "1.0.0",
          provenance: ".flow/presentations/operations",
        },
      ],
    });
    const inspectedPackage = JSON.parse(inspected.stdout[0] ?? "null") as {
      readonly definition?: {
        readonly messages?: readonly [
          unknown,
          { readonly updateComponents?: { readonly components?: unknown[] } },
        ];
      };
    };
    expect(inspectedPackage).toMatchObject({
      kind: "presentation-package",
      name: "operations",
      version: "1.0.0",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifest: {
        bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(inspectedPackage.definition?.messages?.[1].updateComponents?.components).toEqual(
      expect.arrayContaining([
        {
          id: "package-notes",
          component: "FlowPackageNotes",
          notes: [
            {
              title: "Operator context",
              body: "This text is package-provided information.",
            },
          ],
        },
      ]),
    );
    expect(inspected.stdout.join("\n")).not.toContain("contentBase64");
    expect(inspected.stdout.join("\n")).not.toContain("PRIVATE");
    expect(JSON.parse(validated.stdout[0] ?? "null")).toMatchObject({
      valid: true,
      package: "operations@1.0.0",
    });
  });

  it("uses exact grammar and emits fixed errors without private catalog values", async () => {
    const project = await fixture();
    const output = capture();
    expect(
      await main(["presentations", "inspect", "operations"], output.io, { cwd: project }),
    ).toBe(2);
    expect(output.stderr.join("\n")).not.toContain(project);
  });

  it("closes catalog diagnostics without exposing a private package path", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-presentation-private-root-"));
    directories.push(root);
    const privatePackagePath = join(root, ".flow", "presentations", "PRIVATE_PACKAGE");
    await mkdir(privatePackagePath, { recursive: true });
    const config = resolveFlowConfig({ projectRoot: root });
    const output = capture();

    expect(
      await main(["presentations", "list"], output.io, {
        cwd: root,
        loadConfig: async () => config,
      }),
    ).toBe(1);
    expect(output.stderr).toEqual(["unsafe_entry: presentation package source is unsafe"]);
    expect(output.stderr.join("\n")).not.toContain(privatePackagePath);
  });

  it("rejects repeated exact-version authority before catalog discovery", async () => {
    const output = capture();
    let loadConfigCalls = 0;

    expect(
      await main(
        ["presentations", "inspect", "operations", "--version", "1.0.0", "--version=2.0.0"],
        output.io,
        {
          loadConfig: async () => {
            loadConfigCalls += 1;
            throw new Error("configuration must not be loaded");
          },
        },
      ),
    ).toBe(2);
    expect(loadConfigCalls).toBe(0);
    expect(output.stderr.join("\n")).not.toContain("2.0.0");
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-presentation-cli-"));
  directories.push(root);
  const directory = join(root, ".flow", "presentations", "operations");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "PRESENTATION.yaml"), source());
  return root;
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    stdout,
    stderr,
  };
}

function source(): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata: { name: operations, version: 1.0.0, description: Operator layout }
spec:
  messages:
    - version: v0.9
      createSurface: { surfaceId: flow-run, catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v2 }
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - { id: root, component: FlowLayout, density: compact, children: [group-1, package-notes] }
          - { id: group-1, component: FlowGroup, variant: stack, children: [resource-facts, run-summary, graph-progress, node-table, pending-approvals, outcome-notice] }
          - id: package-notes
            component: FlowPackageNotes
            notes:
              - title: Operator context
                body: This text is package-provided information.
          - { id: run-summary, component: FlowRunSummary }
          - { id: graph-progress, component: FlowGraphProgress }
          - { id: node-table, component: FlowNodeTable }
          - { id: resource-facts, component: FlowResourceFacts }
          - { id: pending-approvals, component: FlowPendingApprovals }
          - { id: outcome-notice, component: FlowOutcomeNotice }
`;
}
