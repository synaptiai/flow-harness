import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  encodeSupervisorMessage,
  MAX_SUPERVISOR_EVENT_PAGE,
  MAX_SUPERVISOR_FRAME_BYTES,
  parseSupervisorRequestFrame,
  parseSupervisorResponseFrame,
  parseWorkerRequestFrame,
  parseWorkerResponseFrame,
  SUPERVISOR_PROTOCOL_VERSION,
  SupervisorProtocolError,
} from "../../../src/supervisor/protocol.js";

describe("supervisor protocol", () => {
  it("parses a strict detached-run submission with stable identities", () => {
    const requestId = randomUUID();
    const commandId = randomUUID();
    const request = parseSupervisorRequestFrame(
      encodeSupervisorMessage({
        version: SUPERVISOR_PROTOCOL_VERSION,
        requestId,
        command: {
          type: "submit",
          commandId,
          mode: "run",
          runId: "detached-run",
          sourceName: "/workspace/workflow.yaml",
          workflowSource:
            "apiVersion: flow.synapti.ai/v1alpha1\nkind: Workflow\nmetadata: { id: detached }\nnodes: []\n",
          cwd: "/workspace",
        },
      }),
    );

    expect(request).toEqual({
      version: 1,
      requestId,
      command: {
        type: "submit",
        commandId,
        mode: "run",
        runId: "detached-run",
        sourceName: "/workspace/workflow.yaml",
        workflowSource:
          "apiVersion: flow.synapti.ai/v1alpha1\nkind: Workflow\nmetadata: { id: detached }\nnodes: []\n",
        cwd: "/workspace",
      },
    });
  });

  it("parses bounded cursor replay and attributable cancellation commands", () => {
    const eventRequest = parseSupervisorRequestFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId: randomUUID(),
        command: {
          type: "events",
          runId: "run-1",
          afterSequence: 7,
          limit: MAX_SUPERVISOR_EVENT_PAGE,
        },
      }),
    );
    const cancelRequest = parseSupervisorRequestFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId: randomUUID(),
        command: {
          type: "cancel",
          commandId: randomUUID(),
          runId: "run-1",
          actor: "operator:test",
          reason: "Stopping the detached verification run.",
        },
      }),
    );

    expect(eventRequest.command).toMatchObject({ type: "events", afterSequence: 7 });
    expect(cancelRequest.command).toMatchObject({ type: "cancel", actor: "operator:test" });
  });

  it("parses strict success and structured error responses", () => {
    const requestId = randomUUID();
    const success = parseSupervisorResponseFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId,
        ok: true,
        result: {
          type: "accepted",
          commandId: randomUUID(),
          runId: "run-1",
          workerId: randomUUID(),
          acceptedAt: "2026-08-07T12:00:00.000Z",
        },
      }),
    );
    const failure = parseSupervisorResponseFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId,
        ok: false,
        error: { code: "protocol_invalid", message: "request was rejected" },
      }),
    );

    expect(success).toMatchObject({ ok: true, result: { type: "accepted" } });
    expect(failure).toEqual({
      version: 1,
      requestId,
      ok: false,
      error: { code: "protocol_invalid", message: "request was rejected" },
    });
  });

  it("requires a token-bound worker identity for control commands", () => {
    const request = parseWorkerRequestFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId: randomUUID(),
        workerId: randomUUID(),
        token: "a".repeat(64),
        command: { type: "identify" },
      }),
    );

    expect(request.command).toEqual({ type: "identify" });
    expect(request.token).toHaveLength(64);
  });

  it("parses worker identity and terminal cancellation responses", () => {
    const requestId = randomUUID();
    const workerId = randomUUID();
    const identity = parseWorkerResponseFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId,
        ok: true,
        result: {
          type: "identity",
          workerId,
          runId: "run-1",
          pid: 1234,
          jobDigest: "d".repeat(64),
          status: "running",
          runStatus: "running",
        },
      }),
    );
    const cancelled = parseWorkerResponseFrame(
      encodeSupervisorMessage({
        version: 1,
        requestId,
        ok: true,
        result: {
          type: "cancelled",
          commandId: randomUUID(),
          runId: "run-1",
          runStatus: "cancelled",
          lastSequence: 4,
        },
      }),
    );

    expect(identity).toMatchObject({ ok: true, result: { type: "identity", workerId } });
    expect(cancelled).toMatchObject({
      ok: true,
      result: { type: "cancelled", runStatus: "cancelled" },
    });
  });

  it.each([
    ["missing LF delimiter", "{}"],
    ["CRLF delimiter", "{}\r\n"],
    ["multiple frames", "{}\n{}\n"],
    ["invalid JSON", "{\n"],
  ])("rejects %s", (_case, frame) => {
    expect(() => parseSupervisorRequestFrame(frame)).toThrow(SupervisorProtocolError);
  });

  it("rejects unknown fields and unsupported protocol versions", () => {
    const base = {
      requestId: randomUUID(),
      command: { type: "status" },
    };

    expect(() =>
      parseSupervisorRequestFrame(`${JSON.stringify({ version: 2, ...base })}\n`),
    ).toThrow(/version/i);
    expect(() =>
      parseSupervisorRequestFrame(`${JSON.stringify({ version: 1, ...base, extra: true })}\n`),
    ).toThrow(/unrecognized|invalid/i);
  });

  it("rejects invalid paths, identities, actors, cursors, and page limits", () => {
    const cases = [
      {
        type: "submit",
        commandId: randomUUID(),
        mode: "run",
        runId: "../escape",
        sourceName: "/workflow.yaml",
        workflowSource: "source",
        cwd: "/workspace",
      },
      {
        type: "submit",
        commandId: randomUUID(),
        mode: "run",
        runId: "run-1",
        sourceName: "relative.yaml",
        workflowSource: "source",
        cwd: "/workspace",
      },
      {
        type: "submit",
        commandId: randomUUID(),
        mode: "run",
        runId: "run-1",
        sourceName: "/workflow.yaml",
        workflowSource: "source",
        cwd: "relative",
      },
      { type: "events", runId: "run-1", afterSequence: -1, limit: 1 },
      {
        type: "events",
        runId: "run-1",
        afterSequence: 0,
        limit: MAX_SUPERVISOR_EVENT_PAGE + 1,
      },
      {
        type: "cancel",
        commandId: randomUUID(),
        runId: "run-1",
        actor: "bad\nactor",
      },
    ];

    for (const command of cases) {
      expect(() =>
        parseSupervisorRequestFrame(
          encodeSupervisorMessage({
            version: 1,
            requestId: randomUUID(),
            command,
          }),
        ),
      ).toThrow(SupervisorProtocolError);
    }
  });

  it("rejects a frame at the byte boundary before JSON parsing", () => {
    const oversized = `${"x".repeat(MAX_SUPERVISOR_FRAME_BYTES)}\n`;

    expect(() => parseSupervisorRequestFrame(oversized)).toThrow(/maximum/i);
  });
});
