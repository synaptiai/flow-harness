import { describe, expect, it } from "vitest";

import {
  RunPresentationActionController,
  RunPresentationActionError,
  type RunPresentationControl,
} from "../../../src/application/run-presentation-actions.js";
import {
  FLOW_PRESENTATION_API_VERSION,
  type FlowPresentationDocument,
} from "../../../src/domain/presentation/flow-presentation.js";

describe("run presentation actions", () => {
  it("routes exact current approve and deny identities with the configured actor", async () => {
    const control = new CaptureControl();
    const controller = createController(control);
    controller.update(documentWithActions());

    await expect(controller.execute("approve:request-1")).resolves.toEqual({ outcome: "approved" });
    await expect(controller.execute("deny:request-1", { reason: "not safe" })).resolves.toEqual({
      outcome: "denied",
    });
    expect(control.decisions).toEqual([
      {
        runId: "run-1",
        requestId: "request-1",
        actor: "operator:alice",
        decision: "approve",
      },
      {
        runId: "run-1",
        requestId: "request-1",
        actor: "operator:alice",
        decision: "deny",
        reason: "not safe",
      },
    ]);
  });

  it("rejects stale, unknown, or cross-run actions before a control call", async () => {
    const control = new CaptureControl();
    const controller = createController(control);

    await expect(controller.execute("approve:request-1")).rejects.toThrow(
      "Cannot steer Flow run presentation: no current document",
    );
    controller.update(documentWithActions());
    await expect(controller.execute("approve:PRIVATE_UNKNOWN")).rejects.toThrow(
      "Cannot steer Flow run presentation: action is not current",
    );
    expect(() =>
      controller.update({
        ...documentWithActions(),
        run: { ...documentWithActions().run, runId: "run-2" },
      }),
    ).toThrow("Cannot steer Flow run presentation: document run does not match");
    expect(control.decisions).toEqual([]);
    expect(control.cancellations).toEqual([]);
  });

  it("rejects a cancel action that carries a different run identity", () => {
    const control = new CaptureControl();
    const controller = createController(control);
    const document = documentWithActions();
    document.actions[2] = {
      kind: "cancel",
      actionId: "cancel:run-2",
      runId: "run-2",
      label: "Cancel other run",
    };

    expect(() => controller.update(document)).toThrow(
      "Cannot steer Flow run presentation: document run does not match",
    );
    expect(control.cancellations).toEqual([]);
  });

  it("reuses one cancellation command identity across explicit recovery", async () => {
    const control = new CaptureControl();
    control.cancelError = new Error("first cancellation settlement uncertain");
    const generated: string[] = [];
    const controller = createController(control, () => {
      const commandId = "11111111-1111-4111-8111-111111111111";
      generated.push(commandId);
      return commandId;
    });
    controller.update(documentWithActions());

    await expect(controller.execute("cancel:run-1", { reason: "operator requested" })).rejects.toBe(
      control.cancelError,
    );
    control.cancelError = undefined;
    await expect(
      controller.execute("cancel:run-1", { reason: "operator requested" }),
    ).resolves.toEqual({ outcome: "cancelled" });

    expect(generated).toHaveLength(1);
    expect(control.cancellations).toEqual([
      {
        runId: "run-1",
        commandId: "11111111-1111-4111-8111-111111111111",
        actor: "operator:alice",
        reason: "operator requested",
      },
      {
        runId: "run-1",
        commandId: "11111111-1111-4111-8111-111111111111",
        actor: "operator:alice",
        reason: "operator requested",
      },
    ]);
  });

  it("checks cancellation before mutation but lets owned settlement win afterward", async () => {
    const beforeReason = new Error("cancelled before action");
    const beforeController = new AbortController();
    beforeController.abort(beforeReason);
    const untouched = new CaptureControl();
    const rejected = createController(untouched, undefined, beforeController.signal);
    rejected.update(documentWithActions());

    await expect(rejected.execute("approve:request-1")).rejects.toBe(beforeReason);
    expect(untouched.decisions).toEqual([]);

    const afterController = new AbortController();
    const settling = new CaptureControl();
    settling.afterDecision = () => afterController.abort(new Error("late cancellation"));
    const owned = createController(settling, undefined, afterController.signal);
    owned.update(documentWithActions());

    await expect(owned.execute("approve:request-1")).resolves.toEqual({ outcome: "approved" });
    expect(settling.decisions).toHaveLength(1);
  });

  it("preserves public Error identity and normalizes non-Error rejection privately", async () => {
    const publicError = new Error("approval expired");
    const control = new CaptureControl();
    control.decisionError = publicError;
    const controller = createController(control);
    controller.update(documentWithActions());

    await expect(controller.execute("approve:request-1")).rejects.toBe(publicError);

    control.decisionError = "PRIVATE_NON_ERROR_REJECTION";
    const normalized = await captureError(controller.execute("approve:request-1"));
    expect(normalized).toEqual(
      new RunPresentationActionError("Cannot steer Flow run presentation: control rejected"),
    );
    expect(normalized).not.toHaveProperty("cause");
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE_NON_ERROR_REJECTION");
  });

  it("rejects an invalid cancellation identity before calling the control", async () => {
    const control = new CaptureControl();
    const controller = createController(control, () => "PRIVATE_INVALID_COMMAND_ID");
    controller.update(documentWithActions());

    await expect(controller.execute("cancel:run-1")).rejects.toThrow(
      "Cannot steer Flow run presentation: cancellation identity is invalid",
    );
    expect(control.cancellations).toEqual([]);
  });

  it.each(["", "x".repeat(4097), "PRIVATE\u001b[2J"])(
    "rejects an invalid reason before a control call: %j",
    async (reason) => {
      const control = new CaptureControl();
      const controller = createController(control);
      controller.update(documentWithActions());

      await expect(controller.execute("deny:request-1", { reason })).rejects.toThrow(
        "Cannot steer Flow run presentation: reason is invalid",
      );
      expect(control.decisions).toEqual([]);
    },
  );

  it.each(["", "x".repeat(129), "operator\u001b[2J"])(
    "rejects an invalid actor before accepting a document: %j",
    (actor) => {
      expect(
        () =>
          new RunPresentationActionController({
            runId: "run-1",
            actor,
            control: new CaptureControl(),
            createCommandId: () => "11111111-1111-4111-8111-111111111111",
          }),
      ).toThrow("Cannot steer Flow run presentation: actor is invalid");
    },
  );
});

class CaptureControl implements RunPresentationControl {
  readonly decisions: unknown[] = [];
  readonly cancellations: unknown[] = [];
  decisionError: unknown;
  cancelError: Error | undefined;
  afterDecision: (() => void) | undefined;

  async decide(input: unknown): Promise<unknown> {
    this.decisions.push(input);
    this.afterDecision?.();
    if (this.decisionError !== undefined) {
      throw this.decisionError;
    }
    return {
      outcome:
        typeof input === "object" && input !== null && "decision" in input
          ? input.decision === "approve"
            ? "approved"
            : "denied"
          : "unknown",
    };
  }

  async cancel(input: unknown): Promise<unknown> {
    this.cancellations.push(input);
    if (this.cancelError !== undefined) {
      throw this.cancelError;
    }
    return { outcome: "cancelled" };
  }
}

function createController(
  control: CaptureControl,
  createCommandId: (() => string) | undefined = undefined,
  signal: AbortSignal | undefined = undefined,
): RunPresentationActionController {
  return new RunPresentationActionController({
    runId: "run-1",
    actor: "operator:alice",
    control,
    createCommandId: createCommandId ?? (() => "11111111-1111-4111-8111-111111111111"),
    ...(signal === undefined ? {} : { signal }),
  });
}

function documentWithActions(): FlowPresentationDocument {
  return {
    apiVersion: FLOW_PRESENTATION_API_VERSION,
    run: { runId: "run-1", workflowId: "workflow-1", status: "running", sequence: 4 },
    sections: [{ id: "overview", components: [{ kind: "divider" }] }],
    actions: [
      {
        kind: "approve",
        actionId: "approve:request-1",
        requestId: "request-1",
        label: "Approve request",
      },
      {
        kind: "deny",
        actionId: "deny:request-1",
        requestId: "request-1",
        label: "Deny request",
      },
      { kind: "cancel", actionId: "cancel:run-1", runId: "run-1", label: "Cancel run" },
    ],
    truncated: false,
  };
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    throw new Error("expected operation to reject");
  } catch (error) {
    return error;
  }
}
