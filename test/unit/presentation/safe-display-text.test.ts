import { describe, expect, it } from "vitest";

import {
  isSafeDisplayText,
  MAX_SAFE_DISPLAY_TEXT_BYTES,
  neutralizeDisplayText,
  parseSafeDisplayText,
  SafeDisplayTextError,
} from "../../../src/domain/presentation/safe-display-text.js";

describe("safe display text", () => {
  it("preserves printable Unicode without normalization", () => {
    const input = "Flow — café — 你好 — 👩🏽‍💻";

    expect(neutralizeDisplayText(input)).toBe(input);
    expect(parseSafeDisplayText(input)).toBe(input);
    expect(isSafeDisplayText(input)).toBe(true);
  });

  it.each([
    ["escape", "before\u001b[31mPRIVATEafter", "before�[31mPRIVATEafter"],
    ["newline", "before\nafter", "before�after"],
    ["carriage return", "before\rafter", "before�after"],
    ["tab", "before\tafter", "before�after"],
    ["backspace", "before\bafter", "before�after"],
    ["delete", "before\u007fafter", "before�after"],
    ["C1 control", "before\u009b31mafter", "before�31mafter"],
    ["bidi override", "before\u202eafter", "before�after"],
    ["bidi isolate", "before\u2066after", "before�after"],
    ["Arabic letter mark", "before\u061cafter", "before�after"],
    ["zero-width format", "before\u200bafter", "before�after"],
    ["line separator", "before\u2028after", "before�after"],
    ["lone high surrogate", "before\ud800after", "before�after"],
    ["lone low surrogate", "before\udfffafter", "before�after"],
  ])("neutralizes %s to visible inert text", (_label, input, expected) => {
    const result = neutralizeDisplayText(input);

    expect(result).toBe(expected);
    expect(result).not.toContain("\u001b");
    expect(isSafeDisplayText(result)).toBe(true);
    expect(() => parseSafeDisplayText(input)).toThrow(SafeDisplayTextError);
  });

  it.each([
    ["CSI cursor movement", "\u001b[2J\u001b[HPRIVATE_CSI"],
    ["OSC hyperlink", "\u001b]8;;https://PRIVATE.example\u0007label\u001b]8;;\u0007"],
    ["OSC clipboard", "\u001b]52;c;PRIVATE_CLIPBOARD\u0007"],
    ["OSC title", "\u001b]0;PRIVATE_TITLE\u0007"],
    ["alternate screen", "\u001b[?1049hPRIVATE_SCREEN\u001b[?1049l"],
  ])("never emits an escape byte for %s", (_label, input) => {
    const result = neutralizeDisplayText(input);

    expect(result).not.toContain("\u001b");
    expect(result).toContain("�");
  });

  it("accepts the exact UTF-8 byte limit and rejects one byte more", () => {
    const exact = "é".repeat(MAX_SAFE_DISPLAY_TEXT_BYTES / 2);
    const excessive = `${exact}x`;

    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_SAFE_DISPLAY_TEXT_BYTES);
    expect(parseSafeDisplayText(exact)).toBe(exact);
    expect(() => parseSafeDisplayText(excessive)).toThrow(
      `safe display text must not exceed ${MAX_SAFE_DISPLAY_TEXT_BYTES} UTF-8 bytes`,
    );
    expect(() => neutralizeDisplayText(excessive)).toThrow(SafeDisplayTextError);
  });
});
