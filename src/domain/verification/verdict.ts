import { parseDocument } from "yaml";

import type { VerifierVerdict } from "../run/events.js";

export interface ParsedVerifierVerdict {
  readonly verdict: VerifierVerdict;
  readonly reason: string;
}

export function parseVerifierVerdictJson(raw: string): ParsedVerifierVerdict | null {
  const document = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("verdict") ||
    !keys.includes("reason") ||
    (value.verdict !== "accepted" &&
      value.verdict !== "rejected" &&
      value.verdict !== "inconclusive") ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 4096 ||
    value.reason !== value.reason.trim()
  ) {
    return null;
  }
  return { verdict: value.verdict, reason: value.reason };
}
