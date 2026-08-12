import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ExternalHarnessProtocolError,
  ExternalHarnessProtocolSession,
  MAX_EXTERNAL_HARNESS_FRAME_BYTES,
  parseExternalHarnessParentLine,
  signExternalHarnessDriverFrame,
  signExternalHarnessParentFrame,
} from "../../../src/domain/evaluation/external-harness-protocol.js";
import { unavailableEvaluationMetrics } from "../../../src/domain/evaluation/records.js";

const sessionId = "018f4d63-9cc1-7a42-9a32-f31bb25e4c70";
const secretHex = "ab".repeat(32);
const trialId = `trial-${"1".repeat(48)}`;
const identityDigest = "2".repeat(64);

describe("external harness protocol", () => {
  it("accepts one ready, correlated inference request, and terminal result", () => {
    const session = protocolSession();

    expect(session.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }))).toEqual({
      type: "ready",
      trialId,
      identityDigest,
    });
    expect(
      session.acceptDriverLine(
        driverLine(2, "inference_request", {
          requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c71",
          body: '{"messages":[]}',
          bodySha256: sha256('{"messages":[]}'),
        }),
      ),
    ).toMatchObject({ type: "inference_request", body: '{"messages":[]}' });
    session.completeInference("018f4d63-9cc1-7a42-9a32-f31bb25e4c71");
    expect(
      session.acceptDriverLine(
        driverLine(3, "terminal", {
          harness: { outcome: "completed", runId: "pi-run", reason: null },
          metrics: unavailableEvaluationMetrics(),
        }),
      ),
    ).toMatchObject({
      type: "terminal",
      harness: { outcome: "completed", runId: "pi-run" },
      metrics: { costUsdMicros: null, turns: null, toolCalls: null },
    });
    expect(session.state).toBe("terminal");
  });

  it("signs HTML-sensitive protocol text with the Go canonical JSON escaping", () => {
    const signed = signExternalHarnessDriverFrame(
      {
        version: 1,
        sequence: 2,
        sessionId,
        type: "inference_request",
        payload: { body: "<skill_import> & \u2028" },
      },
      secretHex,
    );

    expect(signed.mac).toBe("a985265145e8d53de166cb114bd38ff151d99837e1d989315bae6853ff23a78d");
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "duplicate keys",
      `{"version":1,"version":1,"sequence":1,"sessionId":"${sessionId}","type":"ready","payload":{},"mac":"${"0".repeat(64)}"}`,
    ],
    [
      "unknown type",
      JSON.stringify({
        version: 1,
        sequence: 1,
        sessionId,
        type: "shell",
        payload: {},
        mac: "0".repeat(64),
      }),
    ],
    ["forged MAC", driverLine(1, "ready", { trialId, identityDigest }).replace(/.$/, "0")],
  ])("rejects %s with a bounded typed error", (_name, line) => {
    const session = protocolSession();

    expect(() => session.acceptDriverLine(line)).toThrow(ExternalHarnessProtocolError);
    try {
      session.acceptDriverLine(line);
    } catch (error) {
      expect(Buffer.byteLength(String(error), "utf8")).toBeLessThanOrEqual(16_384);
    }
  });

  it("rejects duplicate, skipped, and invalid state transitions", () => {
    const duplicate = protocolSession();
    duplicate.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }));
    expect(() =>
      duplicate.acceptDriverLine(driverLine(1, "event", { category: "progress", message: "x" })),
    ).toThrow(/sequence/i);

    const skipped = protocolSession();
    expect(() =>
      skipped.acceptDriverLine(driverLine(2, "ready", { trialId, identityDigest })),
    ).toThrow(/sequence/i);

    const earlyTerminal = protocolSession();
    expect(() =>
      earlyTerminal.acceptDriverLine(
        driverLine(1, "terminal", {
          harness: { outcome: "crashed", runId: null, reason: "early" },
          metrics: unavailableEvaluationMetrics(),
        }),
      ),
    ).toThrow(/ready|state/i);

    const pending = protocolSession();
    pending.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }));
    pending.acceptDriverLine(
      driverLine(2, "inference_request", {
        requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c71",
        body: "{}",
        bodySha256: sha256("{}"),
      }),
    );
    expect(() =>
      pending.acceptDriverLine(
        driverLine(3, "inference_request", {
          requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c72",
          body: "{}",
          bodySha256: sha256("{}"),
        }),
      ),
    ).toThrow(/pending|inference/i);
  });

  it("rejects process evidence asserted by the child driver", () => {
    const session = protocolSession();
    session.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }));

    expect(() =>
      session.acceptDriverLine(
        driverLine(2, "terminal", {
          harness: { outcome: "completed", runId: "pi-run", reason: null },
          metrics: unavailableEvaluationMetrics(),
          process: { exitCode: 0, signal: null, treeTerminated: true },
        }),
      ),
    ).toThrow(/schema|frame/i);
  });

  it("accepts the exact frame-byte limit and rejects one byte over", () => {
    const line = driverLine(1, "ready", { trialId, identityDigest });
    const exact = `${line}${" ".repeat(MAX_EXTERNAL_HARNESS_FRAME_BYTES - Buffer.byteLength(line))}`;

    expect(Buffer.byteLength(exact)).toBe(MAX_EXTERNAL_HARNESS_FRAME_BYTES);
    expect(protocolSession().acceptDriverLine(exact)).toMatchObject({ type: "ready" });
    expect(() => protocolSession().acceptDriverLine(`${exact} `)).toThrow(/frame|byte|limit/i);
  });

  it("enforces the event-message limit as UTF-8 bytes", () => {
    const exact = protocolSession();
    exact.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }));
    expect(
      exact.acceptDriverLine(
        driverLine(2, "event", { category: "diagnostic", message: "x".repeat(4_096) }),
      ),
    ).toMatchObject({ type: "event" });

    const over = protocolSession();
    over.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }));
    expect(() =>
      over.acceptDriverLine(
        driverLine(2, "event", { category: "diagnostic", message: `${"x".repeat(4_095)}é` }),
      ),
    ).toThrow(/frame|byte|limit/i);
  });

  it("rejects a body whose claimed digest does not match its exact bytes", () => {
    const session = protocolSession();
    session.acceptDriverLine(driverLine(1, "ready", { trialId, identityDigest }));

    expect(() =>
      session.acceptDriverLine(
        driverLine(2, "inference_request", {
          requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c71",
          body: '{"messages":[]}',
          bodySha256: "0".repeat(64),
        }),
      ),
    ).toThrow(/digest|body/i);
  });

  it("accepts only signed and bounded parent control frames", () => {
    const hello = signExternalHarnessParentFrame(
      {
        version: 1,
        sequence: 1,
        sessionId,
        type: "hello",
        payload: {
          secretHex,
          trialId,
          identityDigest,
          evaluation: evaluationInput(),
          instructionText: "Create RESULT.md.\n",
        },
      },
      secretHex,
    );
    const parsed = parseExternalHarnessParentLine(JSON.stringify(hello));

    expect(parsed).toMatchObject({
      type: "hello",
      payload: {
        trialId,
        identityDigest,
        evaluation: { trial: { profileId: "candidate" } },
        instructionText: "Create RESULT.md.\n",
      },
    });

    const response = signExternalHarnessParentFrame(
      {
        version: 1,
        sequence: 2,
        sessionId,
        type: "inference_response",
        payload: {
          requestId: "018f4d63-9cc1-7a42-9a32-f31bb25e4c71",
          body: "{}",
          bodySha256: "0".repeat(64),
        },
      },
      secretHex,
    );
    expect(() => parseExternalHarnessParentLine(JSON.stringify(response), secretHex)).toThrow(
      /digest|body/i,
    );
  });
});

function protocolSession(): ExternalHarnessProtocolSession {
  return new ExternalHarnessProtocolSession({ sessionId, secretHex, trialId, identityDigest });
}

function driverLine(
  sequence: number,
  type: "ready" | "event" | "inference_request" | "terminal",
  payload: unknown,
): string {
  return JSON.stringify(
    signExternalHarnessDriverFrame({ version: 1, sequence, sessionId, type, payload }, secretHex),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evaluationInput() {
  return {
    planDigest: "3".repeat(64),
    trial: {
      trialId,
      position: 1,
      taskId: "task",
      profileId: "candidate",
      seed: 7,
      repetition: 1,
    },
    workspace: {
      workspaceId: `workspace-${trialId}`,
      cwd: "/tmp/workspace",
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "4".repeat(64),
    },
    instruction: { path: "TASK.md", sha256: "5".repeat(64) },
    controls: {
      model: { provider: "test", id: "model", thinking: "off" as const },
      budget: {
        maxNodeStarts: 8,
        maxModelTokens: 4_096,
        maxCostUsdMicros: 100_000,
        maxExecutionMs: 30_000,
        maxArtifactBytes: 1_048_576,
      },
      network: "deny" as const,
      retry: { providerRetries: 0 as const, harnessRetries: 0 as const },
    },
  };
}
