import { TextDecoder } from "node:util";

const MAX_CONFIGURATION_BYTES = 1_048_576;
const MAX_CONFIGURATION_RECORDS = 4_096;
const FORBIDDEN_ORIGIN_KEYS = new Set([
  "remote.origin.pushurl",
  "remote.origin.receivepack",
  "remote.origin.mirror",
]);
const URL_REWRITE_KEY_PATTERN = /^url\..+\.(?:insteadof|pushinsteadof)$/;

export class ExactLocalGitOriginConfigurationError extends Error {
  override readonly name = "ExactLocalGitOriginConfigurationError";

  constructor() {
    super("local Git origin configuration is unsupported");
  }
}

/** Returns the sole raw origin URL after rejecting local destination overrides. */
export function parseExactLocalGitOriginConfiguration(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CONFIGURATION_BYTES) fail();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
  if (!source.endsWith("\0")) fail();
  const records = source.slice(0, -1).split("\0");
  if (records.length < 1 || records.length > MAX_CONFIGURATION_RECORDS) fail();
  const originUrls: string[] = [];
  for (const record of records) {
    const separator = record.indexOf("\n");
    if (separator < 1) fail();
    const key = record.slice(0, separator).toLowerCase();
    const value = record.slice(separator + 1);
    if (key === "remote.origin.url") originUrls.push(value);
    if (FORBIDDEN_ORIGIN_KEYS.has(key) || URL_REWRITE_KEY_PATTERN.test(key)) fail();
  }
  const originUrl = originUrls[0];
  if (originUrls.length !== 1 || originUrl === undefined || originUrl.length === 0) fail();
  return originUrl;
}

function fail(): never {
  throw new ExactLocalGitOriginConfigurationError();
}
