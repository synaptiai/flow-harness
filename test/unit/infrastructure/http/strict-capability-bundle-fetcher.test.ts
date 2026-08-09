import { describe, expect, it, vi } from "vitest";

import {
  CapabilityBundleFetchError,
  createStrictCapabilityBundleFetcher,
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
} from "../../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";

describe("strict capability bundle HTTPS fetcher", () => {
  it.each([
    "http://packages.example.test/review.flowpkg",
    "https://user:secret@packages.example.test/review.flowpkg",
    "https://packages.example.test/review.flowpkg?token=secret",
    "https://packages.example.test/review.flowpkg?",
    "https://packages.example.test/review.flowpkg#fragment",
    "https://packages.example.test/review.flowpkg#",
    " https://packages.example.test/review.flowpkg",
  ])("rejects an unsafe source URL before DNS or transport: %s", async (source) => {
    const resolveHostname = vi.fn();
    const openPinnedResponse = vi.fn();
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname,
      openPinnedResponse,
    });

    await expect(fetcher.fetch(source)).rejects.toMatchObject({
      name: "CapabilityBundleFetchError",
      code: "invalid_url",
    });
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(openPinnedResponse).not.toHaveBeenCalled();
  });

  it.each([
    { address: "127.0.0.1", family: 4 as const },
    { address: "10.1.2.3", family: 4 as const },
    { address: "169.254.169.254", family: 4 as const },
    { address: "::1", family: 6 as const },
    { address: "fc00::1", family: 6 as const },
    { address: "2001:db8::1", family: 6 as const },
    { address: "3fff::1", family: 6 as const },
    { address: "3fff:fff::1", family: 6 as const },
  ])("rejects non-public resolved address $address", async (resolved) => {
    const openPinnedResponse = vi.fn();
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname: vi.fn().mockResolvedValue([resolved]),
      openPinnedResponse,
    });

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg"),
    ).rejects.toMatchObject({ code: "non_public_address" });
    expect(openPinnedResponse).not.toHaveBeenCalled();
  });

  it("pins a validated public address and returns bounded response bytes", async () => {
    const close = vi.fn();
    const openPinnedResponse = vi.fn(
      async (_request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> => ({
        statusCode: 200,
        headers: { "content-length": "6" },
        body: chunks("abc", "def"),
        close,
      }),
    );
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname: vi.fn().mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
      openPinnedResponse,
    });

    await expect(fetcher.fetch("https://packages.example.test/review.flowpkg")).resolves.toEqual(
      Buffer.from("abcdef"),
    );
    expect(openPinnedResponse).toHaveBeenCalledOnce();
    expect(openPinnedResponse.mock.calls[0]?.[0]).toMatchObject({
      url: "https://packages.example.test/review.flowpkg",
      hostname: "packages.example.test",
      address: { address: "93.184.216.34", family: 4 },
      headers: {
        accept: "application/vnd.synapti.flow-capability-bundle+json",
        "user-agent": "flow-harness",
      },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects redirects without consuming their response body", async () => {
    const body = vi.fn(() => chunks("redirect target"));
    const fetcher = fetcherForResponse({
      statusCode: 302,
      headers: { location: "https://other.example.test/review.flowpkg" },
      get body() {
        return body();
      },
      close: vi.fn(),
    });

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg"),
    ).rejects.toMatchObject({ code: "redirect_denied" });
    expect(body).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared response before consuming its body", async () => {
    const body = vi.fn(() => chunks("ignored"));
    const fetcher = fetcherForResponse(
      {
        statusCode: 200,
        headers: { "content-length": "7" },
        get body() {
          return body();
        },
        close: vi.fn(),
      },
      { maximumBytes: 6 },
    );

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg"),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(body).not.toHaveBeenCalled();
  });

  it("stops a streamed response as soon as it exceeds the byte limit", async () => {
    const close = vi.fn();
    const fetcher = fetcherForResponse(
      {
        statusCode: 200,
        headers: {},
        body: chunks("abcd", "efg"),
        close,
      },
      { maximumBytes: 6 },
    );

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg"),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("applies one deadline while DNS resolution is pending", async () => {
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname: vi.fn(() => new Promise<readonly []>(() => undefined)),
      openPinnedResponse: vi.fn(),
      timeoutMs: 10,
    });

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg"),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not start DNS resolution when the caller signal is already aborted", async () => {
    const resolveHostname = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before fetch"));
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname,
      openPinnedResponse: vi.fn(),
    });

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg", controller.signal),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("propagates cancellation to in-flight DNS resolution", async () => {
    const observedAbort = vi.fn();
    const controller = new AbortController();
    const resolveHostname = vi.fn(
      async (_hostname: string, signal: AbortSignal): Promise<readonly []> =>
        await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname,
      openPinnedResponse: vi.fn(),
    });
    const pending = fetcher.fetch(
      "https://packages.example.test/review.flowpkg",
      controller.signal,
    );

    controller.abort(new Error("cancelled during DNS"));

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(observedAbort).toHaveBeenCalledOnce();
  });

  it("applies the same deadline while the response body is stalled", async () => {
    const close = vi.fn();
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
      openPinnedResponse: vi.fn().mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: delayedFailingBody(30),
        close,
      }),
      timeoutMs: 10,
    });

    await expect(
      fetcher.fetch("https://packages.example.test/review.flowpkg"),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses bounded typed errors for transport failures", async () => {
    const fetcher = createStrictCapabilityBundleFetcher({
      resolveHostname: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
      openPinnedResponse: vi.fn().mockRejectedValue(new Error("x".repeat(20_000))),
    });

    await expect(fetcher.fetch("https://packages.example.test/review.flowpkg")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CapabilityBundleFetchError &&
        error.code === "transport_failed" &&
        Buffer.byteLength(error.message, "utf8") <= 16_384,
    );
  });
});

function fetcherForResponse(
  response: PinnedHttpsResponse,
  options: { readonly maximumBytes?: number } = {},
) {
  return createStrictCapabilityBundleFetcher({
    resolveHostname: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
    openPinnedResponse: vi.fn().mockResolvedValue(response),
    ...options,
  });
}

async function* chunks(...values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value);
  }
}

function delayedFailingBody(delayMs: number): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          throw new Error("late response body failure");
        },
      };
    },
  };
}
