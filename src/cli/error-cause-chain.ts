const MAX_CAUSE_DEPTH = 8;
const MAX_CAUSE_ENTRIES = 16;
const AWS_ACCESS_KEY = /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g;
// Keep newlines and tabs; replace every other C0/C1 control so captured tool
// output cannot move the cursor or inject terminal escape sequences.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are the match target.
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Render an error and its bounded `cause` and `AggregateError` chain for an operator diagnostic.
 * Messages are already bounded by their producers; this adds depth and entry limits, cycle
 * detection, control-character removal, and access-key redaction before terminal output.
 */
export function formatErrorCauseChain(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<object>();
  let truncated = false;

  const visit = (value: unknown, depth: number, label: string): void => {
    if (lines.length >= MAX_CAUSE_ENTRIES) {
      truncated = true;
      return;
    }
    const indent = "  ".repeat(depth);
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        lines.push(`${indent}${label}(repeated cause omitted)`);
        return;
      }
      seen.add(value);
    }
    lines.push(`${indent}${label}${describe(value).replaceAll("\n", `\n${indent}  `)}`);
    if (!(value instanceof Error)) return;
    if (depth >= MAX_CAUSE_DEPTH) {
      if (value.cause !== undefined || value instanceof AggregateError) truncated = true;
      return;
    }
    if (value instanceof AggregateError) {
      for (const member of value.errors) visit(member, depth + 1, "- ");
    }
    if (value.cause !== undefined) visit(value.cause, depth + 1, "caused by: ");
  };

  visit(error, 0, "");
  if (truncated) lines.push("(further causes omitted)");
  return lines.join("\n");
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    const message = sanitize(value.message);
    return value.name === "Error" || value.name === "" ? message : `${value.name}: ${message}`;
  }
  if (typeof value === "string") return sanitize(value);
  try {
    return sanitize(String(value));
  } catch {
    return "(unprintable cause)";
  }
}

function sanitize(text: string): string {
  return text.replace(TERMINAL_CONTROL, "�").replace(AWS_ACCESS_KEY, "AKIA[REDACTED]");
}
