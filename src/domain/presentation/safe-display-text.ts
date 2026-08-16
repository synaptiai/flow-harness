export const MAX_SAFE_DISPLAY_TEXT_BYTES = 16 * 1024;

const REPLACEMENT = "�";

export class SafeDisplayTextError extends Error {
  override readonly name = "SafeDisplayTextError";
}

export function neutralizeDisplayText(input: string): string {
  let result = "";
  for (const character of input) {
    result += isUnsafeDisplayCharacter(character) ? REPLACEMENT : character;
  }
  assertBounded(result);
  return result;
}

export function parseSafeDisplayText(input: unknown): string {
  if (typeof input !== "string") {
    throw new SafeDisplayTextError("safe display text must be a string");
  }
  assertBounded(input);
  if (neutralizeDisplayText(input) !== input) {
    throw new SafeDisplayTextError("safe display text contains a disallowed character");
  }
  return input;
}

export function isSafeDisplayText(input: string): boolean {
  try {
    return parseSafeDisplayText(input) === input;
  } catch {
    return false;
  }
}

function assertBounded(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_SAFE_DISPLAY_TEXT_BYTES) {
    throw new SafeDisplayTextError(
      `safe display text must not exceed ${MAX_SAFE_DISPLAY_TEXT_BYTES} UTF-8 bytes`,
    );
  }
}

function isUnsafeDisplayCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x061c ||
    codePoint === 0x00ad ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    codePoint === 0xe0001 ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  );
}
