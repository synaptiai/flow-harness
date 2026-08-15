import { describe, expect, it, vi } from "vitest";

import { CapabilityMetadataChannelError } from "../../../../src/application/capability-metadata-channel.js";
import { MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES } from "../../../../src/domain/capability/signed-capability-metadata-envelope.js";
import type {
  PinnedHttpsRequest,
  PinnedHttpsResponse,
  ResolvedNetworkAddress,
} from "../../../../src/infrastructure/http/strict-capability-bundle-fetcher.js";
import { createStrictCapabilityMetadataChannel } from "../../../../src/infrastructure/http/strict-capability-metadata-channel.js";

const channelUrl = "https://metadata.example.test/flow/capability-metadata.json";
const publicAddress = Object.freeze({ address: "93.184.216.34", family: 4 as const });
const mediaType = "application/vnd.synapti.flow-capability-metadata-envelope+json";

describe("strict capability metadata channel", () => {
  it("pins an all-public DNS result and reads one exact bounded response", async () => {
    const content = Buffer.from("canonical envelope bytes");
    const fixture = channelFixture({ content });

    await expect(fixture.channel.read(channelUrl)).resolves.toEqual(content);

    expect(fixture.resolveHostname).toHaveBeenCalledWith(
      "metadata.example.test",
      expect.any(AbortSignal),
    );
    expect(fixture.openPinnedResponse).toHaveBeenCalledWith({
      url: channelUrl,
      hostname: "metadata.example.test",
      address: publicAddress,
      headers: {
        accept: mediaType,
        "user-agent": "flow-harness",
      },
      signal: expect.any(AbortSignal),
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("accepts a canonical channel URL at exactly 4,096 UTF-8 bytes", async () => {
    const prefix = "https://metadata.example.test/";
    const exactUrl = `${prefix}${"a".repeat(4_096 - Buffer.byteLength(prefix))}`;
    const fixture = channelFixture();

    await expect(fixture.channel.read(exactUrl)).resolves.toEqual(
      Buffer.from("canonical envelope bytes"),
    );
    expect(fixture.openPinnedResponse).toHaveBeenCalledWith(
      expect.objectContaining({ url: exactUrl }),
    );
    await expectClosedFailure(
      fixture.channel.read(`${exactUrl}a`),
      "validate metadata channel URL",
    );
  });

  it.each([
    "http://metadata.example.test/channel",
    "https://user:PRIVATE@metadata.example.test/channel",
    "https://metadata.example.test/channel?PRIVATE_QUERY",
    "https://metadata.example.test/channel#PRIVATE_FRAGMENT",
    "https://METADATA.example.test/channel",
    `https://metadata.example.test/${"a".repeat(4_096)}`,
  ])("rejects invalid channel URL %s before DNS", async (source) => {
    const fixture = channelFixture();

    await expectClosedFailure(fixture.channel.read(source), "validate metadata channel URL");
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it.each([
    [[{ address: "127.0.0.1", family: 4 as const }]],
    [[publicAddress, { address: "10.0.0.1", family: 4 as const }]],
    [[{ address: "2001:db8::1", family: 6 as const }]],
    [[]],
  ])("rejects a non-public or empty DNS result before opening HTTPS", async (addresses) => {
    const fixture = channelFixture({ addresses });

    await expectClosedFailure(fixture.channel.read(channelUrl), "resolve metadata channel");
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it.each([
    ["redirect", 302, mediaType],
    ["non-success", 503, mediaType],
    ["missing media type", 200, null],
    ["wrong media type", 200, "application/json"],
    ["media type parameter", 200, `${mediaType}; charset=utf-8`],
  ])(
    "rejects %s with a fixed response-validation stage",
    async (_label, statusCode, contentType) => {
      const fixture = channelFixture({ statusCode, contentType });

      await expectClosedFailure(
        fixture.channel.read(channelUrl),
        "validate metadata channel response",
      );
      expect(fixture.close).toHaveBeenCalledOnce();
    },
  );

  it("accepts a cumulative exact response bound across frames", async () => {
    const first = Buffer.alloc(1_000_000, 0x61);
    const second = Buffer.alloc(
      MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES - first.byteLength,
      0x62,
    );
    const fixture = channelFixture({ chunks: [first, second] });

    await expect(fixture.channel.read(channelUrl)).resolves.toHaveLength(
      MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES,
    );
  });

  it.each([
    [
      "declared overflow",
      { contentLength: String(MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES + 1) },
    ],
    [
      "cumulative overflow",
      {
        chunks: [
          Buffer.alloc(1_000_000, 0x61),
          Buffer.alloc(MAX_SIGNED_CAPABILITY_METADATA_ENVELOPE_BYTES - 1_000_000 + 1, 0x62),
        ],
      },
    ],
  ])("rejects %s at the fixed response-bound stage", async (_label, options) => {
    const fixture = channelFixture(options);

    await expectClosedFailure(fixture.channel.read(channelUrl), "bound metadata channel response");
  });

  it.each([
    ["invalid Content-Length", "PRIVATE_LENGTH"],
    ["leading-zero Content-Length", "01"],
    ["mismatched Content-Length", "999"],
  ])("rejects %s without exposing the header", async (_label, contentLength) => {
    const fixture = channelFixture({ contentLength });

    await expectClosedFailure(
      fixture.channel.read(channelUrl),
      "validate metadata channel response",
    );
  });

  it("preserves exact operator cancellation and opens no request", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled metadata check");
    controller.abort(reason);
    const fixture = channelFixture();

    await expect(fixture.channel.read(channelUrl, controller.signal)).rejects.toBe(reason);
    expect(fixture.resolveHostname).not.toHaveBeenCalled();
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it("settles an ignored DNS operation under one total deadline", async () => {
    const fixture = channelFixture({
      timeoutMs: 1,
      resolveHostname: vi.fn(
        async () => await new Promise<readonly ResolvedNetworkAddress[]>(() => {}),
      ),
    });

    await expectClosedFailure(fixture.channel.read(channelUrl), "resolve metadata channel");
    expect(fixture.openPinnedResponse).not.toHaveBeenCalled();
  });

  it("settles a stalled response body under the same total deadline and closes once", async () => {
    const close = vi.fn();
    const fixture = channelFixture({
      timeoutMs: 5,
      response: {
        statusCode: 200,
        headers: Object.freeze({ "content-type": mediaType }),
        body: {
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => undefined);
          },
        },
        close,
      },
    });

    await expectClosedFailure(fixture.channel.read(channelUrl), "read metadata channel response");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "open", "body"] as const)(
    "preserves exact in-flight operator cancellation during %s",
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error(`operator cancelled during ${stage}`);
      const close = vi.fn();
      const fixture = channelFixture({
        ...(stage === "resolve"
          ? {
              resolveHostname: vi.fn(async () => {
                controller.abort(reason);
                return await new Promise<readonly ResolvedNetworkAddress[]>(() => undefined);
              }),
            }
          : {}),
        ...(stage === "open"
          ? {
              openPinnedResponse: vi.fn(async () => {
                controller.abort(reason);
                return await new Promise<PinnedHttpsResponse>(() => undefined);
              }),
            }
          : {}),
        ...(stage === "body"
          ? {
              response: {
                statusCode: 200,
                headers: Object.freeze({ "content-type": mediaType }),
                body: {
                  [Symbol.asyncIterator]: async function* () {
                    controller.abort(reason);
                    await new Promise(() => undefined);
                  },
                },
                close,
              },
            }
          : {}),
      });

      await expect(fixture.channel.read(channelUrl, controller.signal)).rejects.toBe(reason);
      expect(close).toHaveBeenCalledTimes(stage === "body" ? 1 : 0);
    },
  );

  it("closes a response that arrives after operator cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled before response open settled");
    const close = vi.fn();
    let resolveResponse: ((response: PinnedHttpsResponse) => void) | undefined;
    const openPinnedResponse = vi.fn(
      async () =>
        await new Promise<PinnedHttpsResponse>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const fixture = channelFixture({ openPinnedResponse });
    const pending = fixture.channel.read(channelUrl, controller.signal);
    await vi.waitFor(() => expect(openPinnedResponse).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    resolveResponse?.({
      statusCode: 200,
      headers: Object.freeze({ "content-type": mediaType }),
      body: asyncChunks([Buffer.from("PRIVATE_LATE_RESPONSE")]),
      close,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("maps a synchronous response-open failure to the fixed open stage", async () => {
    const fixture = channelFixture({
      openPinnedResponse: () => {
        throw new Error("PRIVATE_SYNCHRONOUS_OPEN_FAILURE");
      },
    });

    await expectClosedFailure(fixture.channel.read(channelUrl), "open metadata channel");
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it("suppresses a hostile close failure without changing a successful read", async () => {
    const content = Buffer.from("canonical envelope bytes");
    const fixture = channelFixture({
      content,
      close: vi.fn(() => {
        throw new Error("PRIVATE_CLOSE_FAILURE");
      }),
    });

    await expect(fixture.channel.read(channelUrl)).resolves.toEqual(content);
    expect(fixture.close).toHaveBeenCalledOnce();
  });
});

type ChannelStage = ConstructorParameters<typeof CapabilityMetadataChannelError>[0];

interface ChannelFixtureOptions {
  readonly content?: Buffer;
  readonly chunks?: readonly Buffer[];
  readonly addresses?: readonly ResolvedNetworkAddress[];
  readonly statusCode?: number;
  readonly contentType?: string | null;
  readonly contentLength?: string;
  readonly timeoutMs?: number;
  readonly resolveHostname?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly ResolvedNetworkAddress[]>;
  readonly openPinnedResponse?: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;
  readonly response?: PinnedHttpsResponse;
  readonly close?: () => void;
}

function channelFixture(options: ChannelFixtureOptions = {}) {
  const content = options.content ?? Buffer.from("canonical envelope bytes");
  const chunks = options.chunks ?? [content];
  const close = options.close ?? vi.fn();
  const resolveHostname = vi.fn(
    options.resolveHostname ?? (async () => options.addresses ?? [publicAddress]),
  );
  const responseHeaders = {
    ...(options.contentType === null ? {} : { "content-type": options.contentType ?? mediaType }),
    "content-length": options.contentLength ?? String(totalBytes(chunks)),
  };
  const openPinnedResponse = vi.fn(
    options.openPinnedResponse ??
      (async (_request: PinnedHttpsRequest): Promise<PinnedHttpsResponse> =>
        options.response ?? {
          statusCode: options.statusCode ?? 200,
          headers: Object.freeze(responseHeaders),
          body: asyncChunks(chunks),
          close,
        }),
  );
  return {
    close,
    resolveHostname,
    openPinnedResponse,
    channel: createStrictCapabilityMetadataChannel({
      resolveHostname,
      openPinnedResponse,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  };
}

async function* asyncChunks(chunks: readonly Buffer[]): AsyncIterable<Buffer> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function totalBytes(chunks: readonly Buffer[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

async function expectClosedFailure(promise: Promise<unknown>, stage: ChannelStage): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toEqual(new CapabilityMetadataChannelError(stage));
  expect(caught).not.toHaveProperty("cause");
  expect((caught as Error).message).not.toContain("PRIVATE");
}
