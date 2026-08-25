import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type LocalCompatibilityCorpusError,
  loadLocalCompatibilityCorpus,
} from "../../../../src/infrastructure/compatibility/local-corpus.js";

const WORKFLOW_PATH = "releases/0.1.0-alpha.1/workflow.yaml";
const WORKFLOW = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: historical
nodes:
  - id: check
    type: command
    command:
      executable: node
      args: [--version]
`;

describe("local compatibility corpus", () => {
  it("loads a contained corpus without changing its bytes", async () => {
    const root = await createCorpus();
    const manifestBefore = await readFile(join(root, "manifest.json"));
    const sourceBefore = await readFile(join(root, WORKFLOW_PATH));

    const loaded = await loadLocalCompatibilityCorpus(root);

    expect(loaded.manifest.id).toBe("test-corpus");
    expect(loaded.corpusSha256).toBe(sha256(manifestBefore));
    expect(loaded.sources.get(WORKFLOW_PATH)).toEqual(sourceBefore);
    await expect(readFile(join(root, "manifest.json"))).resolves.toEqual(manifestBefore);
    await expect(readFile(join(root, WORKFLOW_PATH))).resolves.toEqual(sourceBefore);
  });

  it("represents an oversized artifact as a bounded result input", async () => {
    const root = await createCorpus();
    await writeFile(join(root, WORKFLOW_PATH), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));

    const loaded = await loadLocalCompatibilityCorpus(root);

    expect(loaded.sources.get(WORKFLOW_PATH)).toEqual({ category: "resource_limit" });
  });

  it("does not follow an artifact symbolic link", async () => {
    const root = await createCorpus();
    const target = join(root, "outside.yaml");
    await writeFile(target, WORKFLOW);
    await writeFile(join(root, WORKFLOW_PATH), "replacement");
    const artifact = join(root, WORKFLOW_PATH);
    await rm(artifact);
    await symlink(target, artifact);

    const loaded = await loadLocalCompatibilityCorpus(root);

    expect(loaded.sources.get(WORKFLOW_PATH)).toEqual({ category: "artifact_malformed" });
  });

  it("rejects a missing manifest with a stable diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-empty-compatibility-"));

    await expect(loadLocalCompatibilityCorpus(root)).rejects.toEqual(
      expect.objectContaining<Partial<LocalCompatibilityCorpusError>>({
        name: "LocalCompatibilityCorpusError",
        code: "corpus_missing",
        message: "compatibility corpus is missing",
      }),
    );
  });

  it("rejects duplicate manifest keys before artifact reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-invalid-compatibility-"));
    await writeFile(
      join(root, "manifest.json"),
      '{"version":"flow.compatibility-corpus/v1","version":"flow.compatibility-corpus/v1","id":"test-corpus","artifacts":[]}',
    );

    await expect(loadLocalCompatibilityCorpus(root)).rejects.toEqual(
      expect.objectContaining<Partial<LocalCompatibilityCorpusError>>({
        name: "LocalCompatibilityCorpusError",
        code: "corpus_malformed",
        message: "compatibility corpus is malformed",
      }),
    );
  });
});

async function createCorpus(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-compatibility-"));
  await mkdir(join(root, "releases", "0.1.0-alpha.1"), { recursive: true });
  await writeFile(join(root, WORKFLOW_PATH), WORKFLOW);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      version: "flow.compatibility-corpus/v1",
      id: "test-corpus",
      artifacts: [
        {
          id: "historical-workflow",
          kind: "authored_workflow",
          path: WORKFLOW_PATH,
          sha256: sha256(WORKFLOW),
          producer: {
            package: "@synaptiai/flow-harness",
            version: "0.1.0-alpha.1",
            archiveSha256: "3a8d76564dae33e2c43951c483a3cd69b146fa7788ce311949d5242cb0229568",
          },
          expected: {
            apiVersion: "flow.synapti.ai/v1alpha1",
            workflowId: "historical",
            workflowDigest: "79b1d70ae3ae20fac6497bc309287f2c5927197d101bf1c7b5e5d19d18a6c114",
            nodeCount: 1,
            criterionCount: 0,
          },
        },
      ],
    }),
  );
  return root;
}

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}
