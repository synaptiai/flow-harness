const MAX_PROVIDER_COUNT_REQUEST_BYTES = 1024 * 1024;
const MAX_PROVIDER_COUNT_RESPONSE_BYTES = 8 * 1024;
const PROVIDER_COUNT_TIMEOUT_MS = 15_000;

const OPENAI_COUNT_FIELDS = Object.freeze([
  "conversation",
  "input",
  "instructions",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "reasoning",
  "text",
  "tool_choice",
  "tools",
  "truncation",
] as const);

const ANTHROPIC_COUNT_FIELDS = Object.freeze([
  "messages",
  "model",
  "cache_control",
  "output_config",
  "system",
  "thinking",
  "tool_choice",
  "tools",
] as const);

const STRIPPED_REQUEST_HEADERS = Object.freeze([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
] as const);

export type ProviderInputTokenCountErrorCode =
  | "unsupported_adapter"
  | "request_invalid"
  | "request_failed"
  | "response_status"
  | "response_media_type"
  | "response_too_large"
  | "response_invalid";

export class ProviderInputTokenCountError extends Error {
  override readonly name = "ProviderInputTokenCountError";

  constructor(readonly code: ProviderInputTokenCountErrorCode) {
    super(providerCountFailureMessage(code));
  }
}

export interface ProviderInputTokenCount {
  readonly inputTokens: number;
  readonly method: "provider_exact" | "provider_estimate";
}

type ProviderHeaderInput = ConstructorParameters<typeof Headers>[0];

export async function countProviderInputTokens(input: {
  readonly apiAdapter: string;
  readonly inferenceUrl: string;
  readonly inferenceHeaders: ProviderHeaderInput;
  readonly inferencePayload: unknown;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ProviderInputTokenCount> {
  const contract = providerCountContract(input.apiAdapter, input.inferenceUrl);
  const requestBody = filterCountPayload(input.inferencePayload, contract.fields);
  const serializedBody = JSON.stringify(requestBody);
  if (Buffer.byteLength(serializedBody, "utf8") > MAX_PROVIDER_COUNT_REQUEST_BYTES) {
    throw new ProviderInputTokenCountError("request_invalid");
  }
  const headers = countRequestHeaders(input.inferenceHeaders);
  const timeoutMs = positiveSafeInteger(
    input.timeoutMs ?? PROVIDER_COUNT_TIMEOUT_MS,
    "provider count timeout",
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  let response: Response;
  try {
    response = await input.fetchImpl(contract.url, {
      method: "POST",
      headers,
      body: serializedBody,
      redirect: "error",
      signal,
    });
  } catch {
    throw new ProviderInputTokenCountError("request_failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderInputTokenCountError("response_status");
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderInputTokenCountError("response_media_type");
  }
  const responseText = await readBoundedResponse(response, MAX_PROVIDER_COUNT_RESPONSE_BYTES);
  const inputTokens = parseInputTokenCount(responseText);
  return Object.freeze({ inputTokens, method: contract.method });
}

function providerCountContract(
  apiAdapter: string,
  inferenceUrl: string,
): {
  readonly url: string;
  readonly fields: readonly string[];
  readonly method: ProviderInputTokenCount["method"];
} {
  let url: URL;
  try {
    url = new URL(inferenceUrl);
  } catch {
    throw new ProviderInputTokenCountError("request_invalid");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new ProviderInputTokenCountError("request_invalid");
  }
  url.search = "";
  if (apiAdapter === "openai-responses" && url.pathname.endsWith("/responses")) {
    url.pathname = `${url.pathname}/input_tokens`;
    return {
      url: url.toString(),
      fields: OPENAI_COUNT_FIELDS,
      method: "provider_exact",
    };
  }
  if (apiAdapter === "anthropic-messages" && url.pathname.endsWith("/messages")) {
    url.pathname = `${url.pathname}/count_tokens`;
    return {
      url: url.toString(),
      fields: ANTHROPIC_COUNT_FIELDS,
      method: "provider_estimate",
    };
  }
  if (apiAdapter === "openai-responses" || apiAdapter === "anthropic-messages") {
    throw new ProviderInputTokenCountError("request_invalid");
  }
  throw new ProviderInputTokenCountError("unsupported_adapter");
}

function filterCountPayload(
  payload: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(payload)) {
    throw new ProviderInputTokenCountError("request_invalid");
  }
  const filtered: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(payload, field) && payload[field] !== undefined) {
      filtered[field] = payload[field];
    }
  }
  return Object.freeze(filtered);
}

function countRequestHeaders(input: ProviderHeaderInput): Headers {
  const headers = new Headers(input);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderInputTokenCountError("response_too_large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ProviderInputTokenCountError("response_invalid");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderInputTokenCountError("response_too_large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof ProviderInputTokenCountError) throw error;
    throw new ProviderInputTokenCountError("request_failed");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function parseInputTokenCount(source: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ProviderInputTokenCountError("response_invalid");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, "input_tokens") ||
    !Number.isSafeInteger(parsed.input_tokens) ||
    (parsed.input_tokens as number) < 0
  ) {
    throw new ProviderInputTokenCountError("response_invalid");
  }
  return parsed.input_tokens as number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function providerCountFailureMessage(code: ProviderInputTokenCountErrorCode): string {
  switch (code) {
    case "unsupported_adapter":
      return "provider input-token counting is unsupported for this adapter";
    case "request_invalid":
      return "provider input-token count request is invalid";
    case "request_failed":
      return "provider input-token count request failed";
    case "response_status":
      return "provider input-token count returned an unsuccessful status";
    case "response_media_type":
      return "provider input-token count returned an unsupported media type";
    case "response_too_large":
      return "provider input-token count response exceeds the byte limit";
    case "response_invalid":
      return "provider input-token count response is invalid";
  }
}
