import { parseStrictJson } from "../strict-json.js";
import { parseSafeDisplayText } from "./safe-display-text.js";

export const MAX_BROWSER_ACTION_BODY_BYTES = 8 * 1024;
export const MAX_BROWSER_ACTION_REASON_BYTES = 4 * 1024;

const MAX_ACTION_ID_CHARACTERS = 256;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface BrowserPresentationActionRequest {
  readonly documentSequence: number;
  readonly actionId: string;
  readonly reason?: string;
}

export class BrowserPresentationProtocolError extends Error {
  override readonly name = "BrowserPresentationProtocolError";
}

export function parseBrowserPresentationActionRequest(
  source: Uint8Array,
): BrowserPresentationActionRequest {
  try {
    if (source.byteLength > MAX_BROWSER_ACTION_BODY_BYTES) {
      throw new Error("action body is too large");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    const input = parseStrictJson(text, {
      maxDepth: 2,
      maxNodes: 4,
      valueLabel: "browser action request",
    });
    if (!isRecord(input)) {
      throw new Error("action request is not an object");
    }
    const keys = Object.keys(input);
    if (
      keys.length < 2 ||
      keys.length > 3 ||
      !keys.includes("documentSequence") ||
      !keys.includes("actionId") ||
      keys.some((key) => key !== "documentSequence" && key !== "actionId" && key !== "reason")
    ) {
      throw new Error("action request members are invalid");
    }
    const documentSequence = input.documentSequence;
    if (
      typeof documentSequence !== "number" ||
      !Number.isSafeInteger(documentSequence) ||
      documentSequence < 1
    ) {
      throw new Error("action document sequence is invalid");
    }
    const actionId = input.actionId;
    if (
      typeof actionId !== "string" ||
      actionId.length > MAX_ACTION_ID_CHARACTERS ||
      !ACTION_ID_PATTERN.test(actionId)
    ) {
      throw new Error("action identity is invalid");
    }
    if (input.reason === undefined) {
      return { documentSequence, actionId };
    }
    const admittedReason = parseSafeDisplayText(input.reason);
    const reason = admittedReason.trim();
    if (
      reason.length === 0 ||
      Buffer.byteLength(admittedReason, "utf8") > MAX_BROWSER_ACTION_REASON_BYTES
    ) {
      throw new Error("action reason is invalid");
    }
    return { documentSequence, actionId, reason };
  } catch {
    throw new BrowserPresentationProtocolError("Browser action request is invalid");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
