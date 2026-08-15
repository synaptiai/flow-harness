import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedSecretInputError,
  MAX_REGISTRY_SECRET_BYTES,
  readBoundedSecretInput,
} from "../../../src/cli/bounded-secret-input.js";

describe("bounded secret input", () => {
  it.each([
    [
      "exact boundary",
      Buffer.alloc(MAX_REGISTRY_SECRET_BYTES, 0x61),
      Buffer.alloc(MAX_REGISTRY_SECRET_BYTES, 0x61),
    ],
    [
      "exact boundary with one terminal LF",
      Buffer.concat([Buffer.alloc(MAX_REGISTRY_SECRET_BYTES, 0x61), Buffer.from("\n")]),
      Buffer.alloc(MAX_REGISTRY_SECRET_BYTES, 0x61),
    ],
    [
      "fragmented UTF-8",
      [Buffer.from([0xe2]), Buffer.from([0x82, 0xac])],
      Buffer.from([0xe2, 0x82, 0xac]),
    ],
  ])("reads %s as exact mutable secret bytes", async (_label, source, expected) => {
    const secret = await readBoundedSecretInput(
      chunks(...(Array.isArray(source) ? source : [source])),
    );

    expect(Buffer.isBuffer(secret)).toBe(true);
    expect(secret).toEqual(expected);
    secret.fill(0);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["terminal LF only", Buffer.from("\n")],
    ["one byte over", Buffer.alloc(MAX_REGISTRY_SECRET_BYTES + 1, 0x61)],
    [
      "one byte over before terminal LF",
      Buffer.concat([Buffer.alloc(MAX_REGISTRY_SECRET_BYTES + 1, 0x61), Buffer.from("\n")]),
    ],
    ["embedded LF", Buffer.from("PRIVATE\nSECRET")],
    ["two terminal LFs", Buffer.from("PRIVATE\n\n")],
    ["carriage return", Buffer.from("PRIVATE\rSECRET")],
    ["NUL", Buffer.from("PRIVATE\0SECRET")],
    ["fatal UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s without retaining private input", async (_label, source) => {
    const pending = readBoundedSecretInput(chunks(source));

    await expect(pending).rejects.toEqual(new BoundedSecretInputError());
    await expect(pending).rejects.not.toHaveProperty("cause");
    await expect(pending).rejects.not.toThrow("PRIVATE");
  });

  it("preserves exact cancellation while the source is stalled", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled registry credential input");
    const pending = readBoundedSecretInput(stalledChunks(), controller.signal);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("returns and destroys a stalled source after exact cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled held-open registry input");
    const iteratorReturn = vi.fn(() => {
      throw new Error("PRIVATE_ITERATOR_RETURN_FAILURE");
    });
    const source = stalledSource(iteratorReturn);
    const pending = readBoundedSecretInput(source, controller.signal);

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(iteratorReturn).toHaveBeenCalledOnce();
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it("destroys a held-open Node stream after an early byte-limit rejection", async () => {
    const source = new PassThrough();
    source.write(Buffer.alloc(MAX_REGISTRY_SECRET_BYTES + 2, 0x61));

    await expect(readBoundedSecretInput(source)).rejects.toEqual(new BoundedSecretInputError());
    expect(source.destroyed).toBe(true);
  });

  it("normalizes a private source failure without attaching it", async () => {
    const pending = readBoundedSecretInput(failingChunks());

    await expect(pending).rejects.toEqual(new BoundedSecretInputError());
    await expect(pending).rejects.not.toHaveProperty("cause");
    await expect(pending).rejects.not.toThrow("PRIVATE_SOURCE_FAILURE");
  });
});

async function* chunks(...values: readonly Buffer[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

async function* stalledChunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from("partial");
  await new Promise(() => undefined);
}

async function* failingChunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from("partial");
  throw new Error("PRIVATE_SOURCE_FAILURE");
}

function stalledSource(iteratorReturn: () => never): AsyncIterable<Uint8Array> & {
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn(() => {
    throw new Error("PRIVATE_SOURCE_DESTROY_FAILURE");
  });
  return {
    destroy,
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> => await new Promise(() => undefined),
        return: iteratorReturn,
      };
    },
  };
}
