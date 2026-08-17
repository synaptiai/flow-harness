import { describe, expect, it, vi } from "vitest";

import type {
  PinnedHttpsRequest,
  PinnedHttpsResponse,
  ResolvedNetworkAddress,
} from "../../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";
import {
  CapabilityRepositoryFetchError,
  createStrictCapabilityRepositoryFetcher,
} from "../../../../src/infrastructure/http/strict-capability-repository-fetcher.js";

const source = "https://packages.example.test/metadata/timestamp.json";
const publicAddress = Object.freeze({ address: "93.184.216.34", family: 4 as const });

describe("strict capability repository fetcher", () => {
  it("pins one public address and reads within the caller's exact byte bound", async () => {
    const fixture = fetcherFixture({ chunks: [Buffer.from("abc"), Buffer.from("def")] });

    await expect(fixture.fetcher.read(source, 6, new AbortController().signal)).resolves.toEqual({
      statusCode: 200,
      bytes: Buffer.from("abcdef"),
    });
    expect(fixture.resolveHostname).toHaveBeenCalledWith(
      "packages.example.test",
      expect.any(AbortSignal),
    );
    expect(fixture.openPinnedResponse).toHaveBeenCalledWith({
      url: source,
      hostname: "packages.example.test",
      address: publicAddress,
      headers: {
        accept: "application/json, application/octet-stream",
        "user-agent": "flow-harness",
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(fixture.openPinnedResponse.mock.calls)).not.toContain("authorization");
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it.each([
    "http://packages.example.test/metadata/root.json",
    "https://user:PRIVATE@packages.example.test/metadata/root.json",
    "https://packages.example.test/metadata/root.json?PRIVATE_QUERY",
    "https://PACKAGES.example.test/metadata/root.json",
    `https://packages.example.test/${"a".repeat(4_096)}`,
  ])("rejects unsafe URL %s before DNS", async (url) => {
    const fixture = fetcherFixture();

    await expectClosed(fixture.fetcher.read(url, 64, new AbortController().signal), "validate URL");
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it.each([
    [{ address: "127.0.0.1", family: 4 as const }],
    [publicAddress, { address: "10.0.0.1", family: 4 as const }],
    [] as ResolvedNetworkAddress[],
  ])("rejects non-public DNS set before transport", async (...addresses) => {
    const fixture = fetcherFixture({ addresses });

    await expectClosed(
      fixture.fetcher.read(source, 64, new AbortController().signal),
      "resolve hostname",
    );
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it("rejects redirects and does not consume their body", async () => {
    const body = vi.fn(() => chunks([Buffer.from("PRIVATE_REDIRECT")]));
    const fixture = fetcherFixture({
      response: {
        statusCode: 302,
        headers: { location: "https://PRIVATE.example.test/" },
        get body() {
          return body();
        },
        close: vi.fn(),
      },
    });

    await expectClosed(
      fixture.fetcher.read(source, 64, new AbortController().signal),
      "validate response",
    );
    expect(body).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])(
    "returns status %i without retaining its private body",
    async (statusCode) => {
      const body = vi.fn(() => chunks([Buffer.from("PRIVATE_RESPONSE")]));
      const fixture = fetcherFixture({
        response: {
          statusCode,
          headers: {},
          get body() {
            return body();
          },
          close: fixtureClose(),
        },
      });

      await expect(fixture.fetcher.read(source, 64, new AbortController().signal)).resolves.toEqual(
        { statusCode, bytes: Buffer.alloc(0) },
      );
      expect(body).not.toHaveBeenCalled();
    },
  );

  it("enforces the cumulative caller bound across response frames", async () => {
    const exact = fetcherFixture({ chunks: [Buffer.alloc(3), Buffer.alloc(3)] });
    await expect(
      exact.fetcher.read(source, 6, new AbortController().signal),
    ).resolves.toMatchObject({
      bytes: expect.objectContaining({ length: 6 }),
    });

    const overflow = fetcherFixture({ chunks: [Buffer.alloc(3), Buffer.alloc(4)] });
    await expectClosed(
      overflow.fetcher.read(source, 6, new AbortController().signal),
      "bound response",
    );
  });

  it.each(["07", "PRIVATE_LENGTH", "9007199254740992"])(
    "rejects invalid declared length %s without disclosure",
    async (contentLength) => {
      const fixture = fetcherFixture({ contentLength });
      await expectClosed(
        fixture.fetcher.read(source, 64, new AbortController().signal),
        "validate response",
      );
    },
  );

  it("preserves exact in-flight cancellation and closes the response", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled TUF body");
    const close = vi.fn();
    const fixture = fetcherFixture({
      response: {
        statusCode: 200,
        headers: {},
        body: {
          [Symbol.asyncIterator]: async function* () {
            controller.abort(reason);
            await new Promise(() => undefined);
          },
        },
        close,
      },
    });

    await expect(fixture.fetcher.read(source, 64, controller.signal)).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves pre-existing cancellation before URL and byte-bound validation", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled repository request");
    controller.abort(reason);
    const fixture = fetcherFixture();

    await expect(fixture.fetcher.read("PRIVATE_INVALID_URL", 0, controller.signal)).rejects.toBe(
      reason,
    );
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it("applies one deadline to a stalled body and suppresses hostile close", async () => {
    const close = vi.fn(() => {
      throw new Error("PRIVATE_CLOSE");
    });
    const fixture = fetcherFixture({
      timeoutMs: 2,
      response: {
        statusCode: 200,
        headers: {},
        body: {
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => undefined);
          },
        },
        close,
      },
    });

    await expectClosed(
      fixture.fetcher.read(source, 64, new AbortController().signal),
      "read response",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

function fetcherFixture(
  options: {
    readonly chunks?: readonly Buffer[];
    readonly contentLength?: string;
    readonly addresses?: readonly ResolvedNetworkAddress[];
    readonly response?: PinnedHttpsResponse;
    readonly timeoutMs?: number;
  } = {},
) {
  const responseChunks = options.chunks ?? [Buffer.from("content")];
  const close = vi.fn();
  const resolveHostname = vi.fn(async () => options.addresses ?? [publicAddress]);
  const response = options.response ?? {
    statusCode: 200,
    headers: { "content-length": options.contentLength ?? String(totalBytes(responseChunks)) },
    body: chunks(responseChunks),
    close,
  };
  const openPinnedResponse = vi.fn(async (_request: PinnedHttpsRequest) => response);
  return {
    close,
    resolveHostname,
    openPinnedResponse,
    fetcher: createStrictCapabilityRepositoryFetcher({
      resolveHostname,
      openPinnedResponse,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  };
}

function fixtureClose(): () => void {
  return vi.fn();
}

async function* chunks(values: readonly Buffer[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

function totalBytes(values: readonly Buffer[]): number {
  return values.reduce((total, value) => total + value.byteLength, 0);
}

async function expectClosed(
  operation: Promise<unknown>,
  stage: ConstructorParameters<typeof CapabilityRepositoryFetchError>[0],
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new CapabilityRepositoryFetchError(stage));
  expect(caught).not.toHaveProperty("cause");
  expect((caught as Error).message).not.toContain("PRIVATE");
}
