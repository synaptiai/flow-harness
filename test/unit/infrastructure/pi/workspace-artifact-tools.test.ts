import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_ARTIFACT_READ_BYTES } from "../../../../src/domain/artifact/reference.js";
import { PolicyBroker, PolicyDeniedError } from "../../../../src/domain/policy/broker.js";
import { LocalArtifactStore } from "../../../../src/infrastructure/fs/local-artifact-store.js";
import { createWorkspaceAgentTools } from "../../../../src/infrastructure/pi/workspace-agent-tools.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("workspace artifact tool", () => {
  it("reads one policy-authorized window from an artifact owned by the current run", async () => {
    const root = await temporaryProject();
    const store = new LocalArtifactStore(root);
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    const reference = await store.retain({
      bytes,
      mediaType: "application/octet-stream",
      producer: producer("run-artifact"),
    });
    const policy = policyBroker(["artifact.read"]);
    const tools = await createWorkspaceAgentTools(root, ["artifact"], policy, {
      artifactStore: store,
    });
    const tool = tools.definitions[0];
    if (tool === undefined) throw new Error("artifact tool was not registered");

    const result = await tool.execute(
      "artifact-call",
      { reference: reference.reference, offset: 2, maxBytes: 3 },
      undefined,
      undefined,
      {} as never,
    );

    expect(tools.names).toEqual(["flow_artifact"]);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          reference: reference.reference,
          mediaType: "application/octet-stream",
          offset: 2,
          nextOffset: 5,
          complete: false,
          contentBase64: bytes.subarray(2, 5).toString("base64"),
        }),
      },
    ]);
    expect(policy.snapshot()).toEqual([
      expect.objectContaining({
        action: "artifact.read",
        target: reference.reference,
        outcome: "allowed",
      }),
    ]);
  });

  it("rejects an artifact selection when the runtime did not inject a store", async () => {
    const root = await temporaryProject();

    await expect(
      createWorkspaceAgentTools(root, ["artifact"], policyBroker(["artifact.read"])),
    ).rejects.toThrow("Flow artifact access requires a configured artifact store");
  });

  it("denies undeclared artifact authority before reading the store", async () => {
    const root = await temporaryProject();
    const store = new LocalArtifactStore(root);
    const reference = await store.retain({
      bytes: Buffer.from("PRIVATE_ARTIFACT"),
      mediaType: "application/octet-stream",
      producer: producer("run-artifact"),
    });
    const tools = await createWorkspaceAgentTools(root, ["artifact"], policyBroker([]), {
      artifactStore: store,
    });
    const tool = tools.definitions[0];
    if (tool === undefined) throw new Error("artifact tool was not registered");

    await expect(
      tool.execute(
        "artifact-call",
        { reference: reference.reference, offset: 0, maxBytes: MAX_ARTIFACT_READ_BYTES },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});

async function temporaryProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-artifact-tool-")));
  temporaryDirectories.push(root);
  return root;
}

function policyBroker(actions: readonly "artifact.read"[]): PolicyBroker {
  return new PolicyBroker(
    { runId: "run-artifact", workflowId: "artifact-workflow", nodeId: "analyze", attempt: 1 },
    actions,
  );
}

function producer(runId: string) {
  return {
    kind: "agent-command" as const,
    runId,
    workflowId: "artifact-workflow",
    nodeId: "analyze",
    attempt: 1,
    commandId: "command-1",
    commandSequence: 1,
    stream: "stdout" as const,
  };
}
