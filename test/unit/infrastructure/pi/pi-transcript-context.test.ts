import {
  type Context,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import {
  flowContextFromPiTranscript,
  PiTranscriptContextError,
  piTranscriptFromFlowContext,
} from "../../../../src/infrastructure/pi/pi-transcript-context.js";

const tool = {
  name: "flow_read",
  description: "Read one workspace file.",
  parameters: Type.Object({ path: Type.String() }),
};

const flowContext: Context = {
  systemPrompt: "You are executing one bounded node in a Flow workflow.",
  messages: [
    { role: "user", content: "Inspect source.ts.", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  ],
  tools: [tool],
};

describe("Pi transcript context adapter", () => {
  it("round-trips a Flow context through the Pi transcript form", () => {
    const transcript = piTranscriptFromFlowContext(flowContext);

    expect(transcript.messages[0]?.role).toBe("system");
    expect(getCurrentSystemPrompt(transcript.messages)).toBe(flowContext.systemPrompt);
    expect(getCurrentTools(transcript.messages).map((entry) => entry.name)).toEqual(["flow_read"]);

    const restored = flowContextFromPiTranscript(transcript);
    expect(restored.systemPrompt).toBe(flowContext.systemPrompt);
    expect(restored.messages).toEqual(flowContext.messages);
    expect(restored.tools).toEqual(getCurrentTools(transcript.messages));
    expect(restored.messages.some((message) => message.role === "system")).toBe(false);
  });

  it("preserves the rendered provider prompt when Pi declares prompt sections", () => {
    const transcript = {
      messages: [
        {
          role: "system",
          content: "Base instructions.",
          sections: { environment: "<cwd>\n/workspace\n</cwd>" },
          toolsAdded: [tool],
        },
        { role: "user", content: "Inspect source.ts.", timestamp: 1 },
      ],
    } as unknown as TranscriptContext;
    const rendered = getCurrentSystemPrompt(transcript.messages);

    const restored = flowContextFromPiTranscript(transcript);

    expect(restored.systemPrompt).toBe(rendered);
    expect(getCurrentSystemPrompt(piTranscriptFromFlowContext(restored).messages)).toBe(rendered);
    expect(restored.tools?.map((entry) => entry.name)).toEqual(["flow_read"]);
  });

  it("passes a context without system messages through unchanged", () => {
    expect(flowContextFromPiTranscript(flowContext)).toEqual(flowContext);
    expect(
      flowContextFromPiTranscript({ messages: flowContext.messages } as unknown as Context),
    ).toEqual({ messages: flowContext.messages });
  });

  it("rejects mid-conversation system messages", () => {
    const transcript = normalizeContext(flowContext);
    const changed = {
      messages: [
        ...transcript.messages,
        { role: "system", content: "Changed instructions.", timestamp: 3 },
      ],
    } as unknown as TranscriptContext;

    expect(() => flowContextFromPiTranscript(changed)).toThrow(PiTranscriptContextError);
  });

  it("rejects a leading system message that removes tools", () => {
    const transcript = {
      messages: [
        { role: "system", content: "Base instructions.", toolsRemoved: [{ name: "flow_read" }] },
      ],
    } as unknown as TranscriptContext;

    expect(() => flowContextFromPiTranscript(transcript)).toThrow(PiTranscriptContextError);
  });

  it("rejects instructions declared both inline and in a system message", () => {
    const mixed = {
      systemPrompt: "Inline instructions.",
      messages: normalizeContext(flowContext).messages,
    } as unknown as Context;

    expect(() => flowContextFromPiTranscript(mixed)).toThrow(PiTranscriptContextError);
  });

  it("rejects Flow contexts that already contain Pi system messages", () => {
    const polluted = {
      messages: normalizeContext(flowContext).messages,
    } as unknown as Context;

    expect(() => piTranscriptFromFlowContext(polluted)).toThrow(PiTranscriptContextError);
  });
});
