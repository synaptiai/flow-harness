import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const manifestUrl = new URL("./source-manifest.json", import.meta.url);
const failure = (reason) => new Error(`relay source integrity: ${reason}`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Captures exact reviewed source inputs, not executable or lifetime custody.
 * The installed checker and adjacent manifest are the trusted build inputs.
 * No manifest, URL, key, or replacement digest is accepted from the source root.
 * This reads local files only; it neither downloads nor executes their contents.
 */
export async function captureRelaySources(root) {
  const manifestBytes = await readFile(manifestUrl);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.version !== 1 ||
    manifest.purpose !== "observer-host-relay-source-selection" ||
    manifest.profile !== "host-bridge-ipv4-loopback-v1" ||
    manifest.qualification !== "not-performed" ||
    !Array.isArray(manifest.inputs) ||
    manifest.inputs.length === 0 ||
    manifest.inputs.some(
      (entry) =>
        typeof entry.path !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.path) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes <= 0 ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256),
    ) ||
    new Set(manifest.inputs.map((entry) => entry.path)).size !== manifest.inputs.length
  )
    throw failure("invalid trusted manifest");

  try {
    const canonical = await realpath(root);
    if (canonical !== resolve(root)) throw failure("indirect root");
    const entries = await readdir(canonical, { withFileTypes: true });
    const expected = new Set(manifest.inputs.map((entry) => entry.path));
    if (
      entries.length !== expected.size ||
      entries.some((entry) => !entry.isFile() || !expected.has(entry.name))
    )
      throw failure("inventory mismatch");
    const inputs = new Map();
    for (const entry of manifest.inputs) {
      const path = join(canonical, entry.path);
      // Nonblocking open prevents a substituted FIFO from hanging before fstat.
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size !== BigInt(entry.bytes))
          throw failure("size or file type mismatch");
        const bytes = Buffer.alloc(entry.bytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (
          length !== entry.bytes ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          !named.isFile() ||
          before.dev !== named.dev ||
          before.ino !== named.ino
        )
          throw failure("unstable file");
        const captured = bytes.subarray(0, length);
        if (digest(captured) !== entry.sha256) throw failure("digest mismatch");
        inputs.set(entry.path, captured);
      } finally {
        await handle.close();
      }
    }
    return { sourceManifestSha256: digest(manifestBytes), inputs };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("relay source integrity:")) throw error;
    throw failure("unreadable source bundle");
  }
}
