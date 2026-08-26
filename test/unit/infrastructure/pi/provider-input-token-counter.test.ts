import { describe, expect, it, vi } from "vitest";

import {
  countProviderInputTokens,
  ProviderInputTokenCountError,
} from "../../../../src/infrastructure/pi/provider-input-token-counter.js";

describe("provider input-token counter", () => {
  it("counts an exact OpenAI Responses payload through the same origin and closed body", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://gateway.example/v1/responses/input_tokens");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer private-key");
      expect(headers.get("x-project-id")).toBe("project-1");
      expect(headers.get("content-length")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        input: [{ role: "user", content: "hello" }],
        model: "gpt-5.6",
        reasoning: { effort: "high" },
        tools: [],
      });
      return Response.json({ input_tokens: 42 });
    });

    await expect(
      countProviderInputTokens({
        apiAdapter: "openai-responses",
        inferenceUrl: "https://gateway.example/v1/responses",
        inferenceHeaders: {
          authorization: "Bearer private-key",
          "content-length": "999",
          "x-project-id": "project-1",
        },
        inferencePayload: {
          model: "gpt-5.6",
          input: [{ role: "user", content: "hello" }],
          reasoning: { effort: "high" },
          tools: [],
          stream: true,
          store: true,
          max_output_tokens: 128_000,
          vendor_extension: "discard",
        },
        fetchImpl,
      }),
    ).resolves.toEqual({ inputTokens: 42, method: "provider_exact" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("counts an Anthropic Messages payload through its documented estimate contract", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://proxy.example/anthropic/v1/messages/count_tokens");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("private-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(JSON.parse(String(init?.body))).toEqual({
        messages: [{ role: "user", content: "hello" }],
        model: "claude-opus-4-6",
        system: "system",
        thinking: { type: "enabled", budget_tokens: 16_384 },
        tools: [],
      });
      return Response.json({ input_tokens: 84 });
    });

    await expect(
      countProviderInputTokens({
        apiAdapter: "anthropic-messages",
        inferenceUrl: "https://proxy.example/anthropic/v1/messages?beta=true",
        inferenceHeaders: {
          "x-api-key": "private-key",
          "anthropic-version": "2023-06-01",
        },
        inferencePayload: {
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: "hello" }],
          system: "system",
          thinking: { type: "enabled", budget_tokens: 16_384 },
          tools: [],
          stream: true,
          max_tokens: 64_000,
          metadata: { user_id: "discard" },
        },
        fetchImpl,
      }),
    ).resolves.toEqual({ inputTokens: 84, method: "provider_estimate" });
  });

  it("fails closed for an unsupported adapter before network I/O", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      countProviderInputTokens({
        apiAdapter: "openai-completions",
        inferenceUrl: "https://example.test/v1/chat/completions",
        inferenceHeaders: {},
        inferencePayload: {},
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "unsupported_adapter" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unsuccessful status",
      async () => new Response("private prompt and credential", { status: 400 }),
      "response_status",
    ],
    [
      "wrong media type",
      async () => new Response('{"input_tokens":1}', { headers: { "content-type": "text/plain" } }),
      "response_media_type",
    ],
    [
      "oversized response",
      async () =>
        new Response("x".repeat(8_193), { headers: { "content-type": "application/json" } }),
      "response_too_large",
    ],
    [
      "unknown response field",
      async () => Response.json({ input_tokens: 1, prompt: "private" }),
      "response_invalid",
    ],
    ["fractional count", async () => Response.json({ input_tokens: 1.5 }), "response_invalid"],
  ])("returns a content-free failure for an %s", async (_case, response, code) => {
    let failure: unknown;
    try {
      await countProviderInputTokens({
        apiAdapter: "openai-responses",
        inferenceUrl: "https://example.test/v1/responses",
        inferenceHeaders: { authorization: "Bearer private-key" },
        inferencePayload: { model: "gpt-5.6", input: "private prompt" },
        fetchImpl: response,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProviderInputTokenCountError);
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain("private");
    expect(String(failure)).not.toContain("credential");
    expect(String(failure)).not.toContain("prompt");
  });

  it("maps transport failures without retaining provider details", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("private-key appeared in a proxy failure");
    });

    let failure: unknown;
    try {
      await countProviderInputTokens({
        apiAdapter: "anthropic-messages",
        inferenceUrl: "https://example.test/v1/messages",
        inferenceHeaders: { "x-api-key": "private-key" },
        inferencePayload: { model: "claude-opus-4-6", messages: [] },
        fetchImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "request_failed" });
    expect(String(failure)).not.toContain("private-key");
    expect(String(failure)).not.toContain("proxy failure");
  });
});
