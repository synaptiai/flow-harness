import { readFile } from "node:fs/promises";

/**
 * A fixed control creates its notice before writing it. Only that empty window
 * and ENOENT are retryable; nonempty partial/wrong notices are not readiness.
 * The absolute deadline gates acceptance, not a guarantee of cancellable OS I/O.
 */
export async function waitForReady(
  path: string,
  signal: AbortSignal,
  expectedNotice: "ready\n" | "ready-session-zero\n" | "term-received\n" = "ready\n",
): Promise<void> {
  const deadline = performance.now() + 1000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    signal.throwIfAborted();
    if (performance.now() >= deadline) break;
    if (bytes !== undefined && bytes.length !== 0) {
      if (!bytes.equals(Buffer.from(expectedNotice, "utf8")))
        throw new Error("Unexpected readiness notice");
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  signal.throwIfAborted();
  throw new Error("Held child did not publish bounded readiness");
}
