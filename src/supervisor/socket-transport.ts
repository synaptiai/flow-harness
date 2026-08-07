import { createConnection, type Server, type Socket } from "node:net";

import { MAX_SUPERVISOR_FRAME_BYTES } from "./protocol.js";

export async function exchangeFrame(
  socketPath: string,
  request: string,
  timeoutMs: number,
): Promise<Uint8Array> {
  const socket = createConnection(socketPath);
  socket.setTimeout(timeoutMs);
  return await new Promise<Uint8Array>((resolvePromise, reject) => {
    socket.once("connect", () => socket.write(request));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`socket request timed out after ${timeoutMs}ms`));
    });
    readFrame(socket).then(resolvePromise, reject);
  }).finally(() => socket.destroy());
}

export async function readFrame(socket: Socket): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onEnd = () => fail(new Error("socket ended before one complete frame"));
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_SUPERVISOR_FRAME_BYTES) {
        fail(new Error(`socket frame exceeds ${MAX_SUPERVISOR_FRAME_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      if (newline !== chunk.length - 1) {
        fail(new Error("socket received more than one frame"));
        return;
      }
      cleanup();
      resolvePromise(Buffer.concat(chunks, bytes));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

export async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}
