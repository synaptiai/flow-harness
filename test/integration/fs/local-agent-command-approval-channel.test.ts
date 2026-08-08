import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentCommandApprovalDecision,
  AgentCommandApprovalDecisionSourceError,
  AgentCommandApprovalWait,
} from "../../../src/application/ports.js";
import { normalizeAgentCommandRequest } from "../../../src/domain/agent-command.js";
import {
  calculateAgentCommandApprovalRequestDigest,
  createAgentCommandApprovalRequest,
} from "../../../src/domain/approval/command-approval.js";
import {
  LocalAgentCommandApprovalChannel,
  type LocalAgentCommandApprovalChannelError,
} from "../../../src/infrastructure/fs/local-agent-command-approval-channel.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
  );
});

describe("LocalAgentCommandApprovalChannel", () => {
  it("atomically publishes and returns one exact durable decision", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const decision = approvalDecision(wait);

    await channel.submitDecision(decision);
    await expect(channel.waitForDecision(wait)).resolves.toEqual(decision);

    const path = join(root, "run-1", "agent-command-approvals", "agent-approval-3.decision.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(decision);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing decision receipt", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    await channel.submitDecision(approvalDecision(wait));

    await expect(
      channel.submitDecision({ ...approvalDecision(wait), decision: "deny", reason: "no" }),
    ).rejects.toMatchObject({
      code: "decision_exists",
    } satisfies Partial<LocalAgentCommandApprovalChannelError>);
  });

  it("selects exactly one winner across concurrent conflicting submissions", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const results = await Promise.allSettled([
      channel.submitDecision(approvalDecision(wait)),
      channel.submitDecision({ ...approvalDecision(wait), decision: "deny", reason: "no" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: { code: "decision_exists" },
    });
    await expect(channel.waitForDecision(wait)).resolves.toMatchObject({
      decision: expect.stringMatching(/^(approve|deny)$/),
    });
  });

  it("rejects a receipt whose exact request identity does not match the waiter", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    await channel.submitDecision({
      ...approvalDecision(wait),
      requestDigest: "f".repeat(64),
    });

    await expect(channel.waitForDecision(wait)).rejects.toMatchObject({
      name: "AgentCommandApprovalDecisionSourceError",
      code: "decision_invalid",
    } satisfies Partial<AgentCommandApprovalDecisionSourceError>);
  });

  it("wakes a live waiter after another process submits the decision", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const waiting = channel.waitForDecision(wait);

    await channel.submitDecision(approvalDecision(wait));

    await expect(waiting).resolves.toMatchObject({ decision: "approve" });
  });

  it("closes a pending wait when its signal is aborted", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const controller = new AbortController();
    controller.abort(new Error("tool cancelled"));

    await expect(channel.waitForDecision(approvalWait(), controller.signal)).rejects.toThrow(
      "tool cancelled",
    );
  });

  it("does not return a receipt when cancellation races its asynchronous read", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const controller = new AbortController();
    await channel.submitDecision(approvalDecision(wait));

    const waiting = channel.waitForDecision(wait, controller.signal);
    queueMicrotask(() => controller.abort(new Error("tool cancelled during receipt read")));

    await expect(waiting).rejects.toThrow("tool cancelled during receipt read");
  });

  it("rejects an oversized decision receipt without reading it as unbounded JSON", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const directory = join(root, "run-1", "agent-command-approvals");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "agent-approval-3.decision.json"), "x".repeat(16_385), "utf8");

    await expect(channel.waitForDecision(wait)).rejects.toThrow(/exceeds.*16384 bytes/i);
  });

  it("rejects a decision receipt containing malformed UTF-8 bytes", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const directory = join(root, "run-1", "agent-command-approvals");
    const path = join(directory, "agent-approval-3.decision.json");
    const serialized = JSON.stringify({ ...approvalDecision(wait), actor: "op~erator" });
    const [prefix, suffix] = serialized.split("~");
    if (prefix === undefined || suffix === undefined) {
      throw new Error("malformed UTF-8 fixture marker was not found");
    }
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      Buffer.concat([Buffer.from(prefix), Buffer.from([0x80]), Buffer.from(suffix)]),
    );

    await expect(channel.waitForDecision(wait)).rejects.toMatchObject({
      name: "AgentCommandApprovalDecisionSourceError",
      code: "decision_invalid",
    } satisfies Partial<AgentCommandApprovalDecisionSourceError>);
  });

  it("rejects a decision receipt reached through a symlink", async () => {
    const root = await temporaryRoot();
    const channel = new LocalAgentCommandApprovalChannel(root, 2);
    const wait = approvalWait();
    const directory = join(root, "run-1", "agent-command-approvals");
    const target = join(root, "forged-decision.json");
    await mkdir(directory, { recursive: true });
    await writeFile(target, `${JSON.stringify(approvalDecision(wait))}\n`, "utf8");
    await symlink(target, join(directory, "agent-approval-3.decision.json"));

    await expect(channel.waitForDecision(wait)).rejects.toMatchObject({
      name: "AgentCommandApprovalDecisionSourceError",
      code: "decision_invalid",
    } satisfies Partial<AgentCommandApprovalDecisionSourceError>);
  });
});

function approvalWait(): AgentCommandApprovalWait {
  const request = createAgentCommandApprovalRequest({
    runId: "run-1",
    workflowId: "agent-exec",
    nodeId: "implement",
    attempt: 1,
    cwd: "/workspace/project",
    command: normalizeAgentCommandRequest({ executable: "npm", args: ["test"] }),
    grantTtlMs: 300_000,
  });
  return {
    requestId: "agent-approval-3",
    request,
    requestDigest: calculateAgentCommandApprovalRequestDigest(request),
  };
}

function approvalDecision(wait: AgentCommandApprovalWait): AgentCommandApprovalDecision {
  return {
    version: 1,
    runId: wait.request.runId,
    requestId: wait.requestId,
    requestDigest: wait.requestDigest,
    operationDigest: wait.request.operationDigest,
    decision: "approve",
    actor: "operator:alice",
    submittedAt: "2026-08-08T10:00:04.000Z",
  };
}

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-agent-approval-channel-"));
  directories.push(directory);
  return directory;
}
