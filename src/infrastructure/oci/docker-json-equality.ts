import { isDeepStrictEqual } from "node:util";

export function isDockerJsonEqual(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(normalizeDockerJson(actual), normalizeDockerJson(expected));
}

function normalizeDockerJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDockerJson(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      normalizeDockerJson(item),
    ]),
  );
}
