export const MAX_REGISTRY_SECRET_BYTES = 16_384;

const MAX_REGISTRY_SECRET_INPUT_BYTES = MAX_REGISTRY_SECRET_BYTES + 1;
const MAX_REGISTRY_SECRET_CHUNKS = MAX_REGISTRY_SECRET_INPUT_BYTES;

export class BoundedSecretInputError extends Error {
  override readonly name = "BoundedSecretInputError";

  constructor() {
    super("registry credential input is invalid");
  }
}

export async function readBoundedSecretInput(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const retained: Buffer[] = [];
  let combined: Buffer | undefined;
  let totalBytes = 0;
  let chunkCount = 0;
  let iteratorCompleted = false;
  const iterator = source[Symbol.asyncIterator]();
  try {
    throwIfAborted(signal);
    while (true) {
      const next = await awaitWithSignal(iterator.next(), signal);
      if (next.done === true) {
        iteratorCompleted = true;
        break;
      }
      chunkCount += 1;
      if (chunkCount > MAX_REGISTRY_SECRET_CHUNKS) {
        throw new BoundedSecretInputError();
      }
      const content = Buffer.from(next.value);
      totalBytes += content.byteLength;
      if (totalBytes > MAX_REGISTRY_SECRET_INPUT_BYTES) {
        content.fill(0);
        throw new BoundedSecretInputError();
      }
      if (content.byteLength > 0) {
        retained.push(content);
      }
    }
    throwIfAborted(signal);
    combined = Buffer.concat(retained, totalBytes);
    const secretBytes = combined.at(-1) === 0x0a ? combined.byteLength - 1 : combined.byteLength;
    if (
      secretBytes < 1 ||
      secretBytes > MAX_REGISTRY_SECRET_BYTES ||
      combined.subarray(0, secretBytes).includes(0x00) ||
      combined.subarray(0, secretBytes).includes(0x0a) ||
      combined.subarray(0, secretBytes).includes(0x0d)
    ) {
      throw new BoundedSecretInputError();
    }
    const secret = combined.subarray(0, secretBytes);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(secret);
    } catch {
      throw new BoundedSecretInputError();
    }
    return Buffer.from(secret);
  } catch (error) {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    if (error instanceof BoundedSecretInputError) {
      throw error;
    }
    throw new BoundedSecretInputError();
  } finally {
    if (!iteratorCompleted) {
      destroySource(source);
      returnIterator(iterator);
    }
    combined?.fill(0);
    for (const content of retained) {
      content.fill(0);
    }
  }
}

function destroySource(source: AsyncIterable<Uint8Array>): void {
  const destroy = (source as { readonly destroy?: unknown }).destroy;
  if (typeof destroy !== "function") {
    return;
  }
  try {
    destroy.call(source);
  } catch {
    // Source cleanup cannot replace the fixed input or cancellation result.
  }
}

function returnIterator(iterator: AsyncIterator<Uint8Array>): void {
  if (iterator.return === undefined) {
    return;
  }
  try {
    Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Iterator cleanup cannot replace the fixed input or cancellation result.
  }
}

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) {
    return await promise;
  }
  return await new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
