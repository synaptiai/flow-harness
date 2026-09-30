import {
  type Context,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export class PiTranscriptContextError extends Error {
  override readonly name = "PiTranscriptContextError";
}

/**
 * Pi carries the system prompt and tool declarations in the transcript's leading system message.
 * Flow records, admits, and compacts model requests against a separate prompt, tool catalog, and
 * system-free message history. Accept only the leading form. A later system message would change
 * instructions or tools mid-conversation, which Flow cannot record faithfully, so it fails closed.
 */
export function flowContextFromPiTranscript(context: TranscriptContext | Context): Context {
  const [first, ...rest] = context.messages;
  const leading = first?.role === "system" ? first : undefined;
  const messages = leading === undefined ? context.messages : rest;
  if (messages.some((message) => message.role === "system")) {
    throw new PiTranscriptContextError(
      "Pi transcript contains a mid-conversation system message that Flow cannot record",
    );
  }
  if (leading === undefined) {
    return {
      ...("systemPrompt" in context && context.systemPrompt !== undefined
        ? { systemPrompt: context.systemPrompt }
        : {}),
      messages: [...messages],
      ...("tools" in context && context.tools !== undefined ? { tools: context.tools } : {}),
    };
  }
  if (("systemPrompt" in context && context.systemPrompt !== undefined) || "tools" in context) {
    throw new PiTranscriptContextError(
      "Pi context declares system instructions both inline and in a system message",
    );
  }
  if ((leading.toolsRemoved?.length ?? 0) > 0) {
    throw new PiTranscriptContextError("Pi transcript removes tools in its leading system message");
  }
  const tools = getCurrentTools([leading]);
  return {
    systemPrompt: getCurrentSystemPrompt([leading]),
    messages: [...messages],
    ...(tools.length === 0 ? {} : { tools }),
  };
}

/** Convert a Flow-owned context into the transcript form Pi providers require. */
export function piTranscriptFromFlowContext(context: Context): TranscriptContext {
  if (context.messages.some((message) => message.role === "system")) {
    throw new PiTranscriptContextError("Flow context must not contain Pi system messages");
  }
  return normalizeContext(context);
}
