import { describe, expect, it } from "vitest";

import {
  BrowserPresentationProtocolError,
  MAX_BROWSER_ACTION_BODY_BYTES,
  MAX_BROWSER_ACTION_REASON_BYTES,
  parseBrowserPresentationActionRequest,
} from "../../../src/domain/presentation/browser-presentation-protocol.js";

describe("browser presentation protocol", () => {
  it("parses one strict current-document action request", () => {
    expect(
      parseBrowserPresentationActionRequest(
        bytes(
          JSON.stringify({
            documentSequence: 4,
            actionId: "deny:request-1",
            reason: "requires another review",
          }),
        ),
      ),
    ).toEqual({
      documentSequence: 4,
      actionId: "deny:request-1",
      reason: "requires another review",
    });
  });

  it.each([
    ["empty", ""],
    ["duplicate member", '{"documentSequence":4,"actionId":"approve:1","actionId":"approve:2"}'],
    ["unknown member", '{"documentSequence":4,"actionId":"approve:1","PRIVATE_EXTRA":true}'],
    ["zero sequence", '{"documentSequence":0,"actionId":"approve:1"}'],
    ["fractional sequence", '{"documentSequence":4.5,"actionId":"approve:1"}'],
    ["unsafe sequence", '{"documentSequence":9007199254740992,"actionId":"approve:1"}'],
    ["invalid action identity", '{"documentSequence":4,"actionId":"PRIVATE ACTION"}'],
    ["empty reason", '{"documentSequence":4,"actionId":"deny:1","reason":"   "}'],
    ["unsafe reason", '{"documentSequence":4,"actionId":"deny:1","reason":"PRIVATE\\u001b[2J"}'],
  ])("rejects %s with one fixed private error", (_label, source) => {
    const error = captureError(() => parseBrowserPresentationActionRequest(bytes(source)));
    expect(error).toEqual(
      new BrowserPresentationProtocolError("Browser action request is invalid"),
    );
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  });

  it("rejects fatal UTF-8 without retaining input bytes", () => {
    const error = captureError(() =>
      parseBrowserPresentationActionRequest(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d])),
    );
    expect(error).toEqual(
      new BrowserPresentationProtocolError("Browser action request is invalid"),
    );
    expect(error).not.toHaveProperty("cause");
  });

  it("binds the action body and reason UTF-8 byte limits", () => {
    const reason = "é".repeat(MAX_BROWSER_ACTION_REASON_BYTES / 2);
    const canonical = JSON.stringify({
      documentSequence: 4,
      actionId: "deny:request-1",
      reason,
    });
    const paddingBytes = MAX_BROWSER_ACTION_BODY_BYTES - Buffer.byteLength(canonical, "utf8");
    const exact = `${canonical}${" ".repeat(paddingBytes)}`;

    expect(Buffer.byteLength(reason, "utf8")).toBe(MAX_BROWSER_ACTION_REASON_BYTES);
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_BROWSER_ACTION_BODY_BYTES);
    expect(parseBrowserPresentationActionRequest(bytes(exact))).toEqual({
      documentSequence: 4,
      actionId: "deny:request-1",
      reason,
    });
    expect(() => parseBrowserPresentationActionRequest(bytes(`${exact} `))).toThrow(
      "Browser action request is invalid",
    );
    expect(() =>
      parseBrowserPresentationActionRequest(
        bytes(
          JSON.stringify({
            documentSequence: 4,
            actionId: "deny:request-1",
            reason: `${reason}x`,
          }),
        ),
      ),
    ).toThrow("Browser action request is invalid");
  });
});

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    throw new Error("expected operation to reject");
  } catch (error) {
    return error;
  }
}
