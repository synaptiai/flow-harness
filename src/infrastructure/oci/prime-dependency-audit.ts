import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const MAX_LOCK_BYTES = 4_194_304;
const MAX_PACKAGES = 512;
const MAX_RESPONSE_BYTES = 8_388_608;
const MAX_OSV_PAGES = 8;
const OSV_TIMEOUT_MS = 30_000;

export interface PrimeLockedPythonPackage {
  readonly name: string;
  readonly version: string;
}

export type PrimeOsvQuery = (
  packages: readonly PrimeLockedPythonPackage[],
) => Promise<readonly (readonly string[])[]>;

export async function auditPrimePythonLock(input: {
  readonly lockPath: string;
  readonly query?: PrimeOsvQuery;
}): Promise<{ readonly packages: number; readonly vulnerabilities: number }> {
  const source = await readStableLock(input.lockPath);
  const packages = parsePrimePythonRequirements(source);
  const results = await (input.query ?? queryOsv)(packages);
  if (results.length !== packages.length) {
    throw new Error("Prime Python audit returned the wrong result count");
  }
  const vulnerabilities = results.flatMap((ids, index) =>
    ids.map(
      (id) =>
        `${packages[index]?.name ?? "unknown"}@${packages[index]?.version ?? "unknown"}:${id}`,
    ),
  );
  if (vulnerabilities.length > 0) {
    throw new Error(
      `Prime Python audit found known vulnerabilities: ${vulnerabilities.join(", ")}`,
    );
  }
  return Object.freeze({ packages: packages.length, vulnerabilities: 0 });
}

export function parsePrimePythonRequirements(source: string): readonly PrimeLockedPythonPackage[] {
  const packages: PrimeLockedPythonPackage[] = [];
  const names = new Set<string>();
  let activeHasHash = true;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const requirement = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})==([^\s\\]{1,128})\s*\\$/.exec(line);
    if (requirement !== null) {
      if (!activeHasHash) {
        throw new Error("Prime Python lock requirement omits its artifact hash");
      }
      const name = requirement[1] as string;
      const version = requirement[2] as string;
      const normalizedName = name.toLowerCase().replaceAll(/[-_.]+/g, "-");
      if (names.has(normalizedName)) {
        throw new Error("Prime Python lock contains a duplicate package");
      }
      names.add(normalizedName);
      packages.push(Object.freeze({ name, version }));
      if (packages.length > MAX_PACKAGES) {
        throw new Error("Prime Python lock exceeds its package limit");
      }
      activeHasHash = false;
      continue;
    }
    if (/^--hash=sha256:[a-f0-9]{64}(?:\s*\\)?$/.test(line) && packages.length > 0) {
      activeHasHash = true;
      continue;
    }
    throw new Error("Prime Python lock contains unsupported syntax");
  }
  if (packages.length === 0 || !activeHasHash) {
    throw new Error("Prime Python lock is empty or incomplete");
  }
  return Object.freeze(packages);
}

async function queryOsv(
  packages: readonly PrimeLockedPythonPackage[],
): Promise<readonly (readonly string[])[]> {
  const vulnerabilities = packages.map(() => new Set<string>());
  let active = packages.map((item, index) => ({
    index,
    item,
    pageToken: undefined as string | undefined,
  }));
  const deadline = AbortSignal.timeout(OSV_TIMEOUT_MS);
  for (let page = 0; active.length > 0; page += 1) {
    if (page >= MAX_OSV_PAGES) {
      throw new Error("Prime Python audit exceeds its page limit");
    }
    const response = await fetch(OSV_QUERY_BATCH_URL, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: active.map(({ item, pageToken }) => ({
          package: { ecosystem: "PyPI", name: item.name },
          version: item.version,
          ...(pageToken === undefined ? {} : { page_token: pageToken }),
        })),
      }),
      signal: deadline,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Prime Python audit request returned status ${response.status}`);
    }
    const result = parseOsvBatchResponse(await readBoundedResponse(response), active.length);
    const next: typeof active = [];
    for (const [position, item] of active.entries()) {
      const pageResult = result[position];
      if (pageResult === undefined) {
        throw new Error("Prime Python audit response order is invalid");
      }
      for (const id of pageResult.ids) {
        vulnerabilities[item.index]?.add(id);
      }
      if (pageResult.nextPageToken !== undefined) {
        next.push({ ...item, pageToken: pageResult.nextPageToken });
      }
    }
    active = next;
  }
  return Object.freeze(vulnerabilities.map((ids) => Object.freeze([...ids].sort())));
}

function parseOsvBatchResponse(
  source: string,
  expectedResults: number,
): readonly { readonly ids: readonly string[]; readonly nextPageToken?: string }[] {
  const value = JSON.parse(source) as unknown;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Prime Python audit response is not an object");
  }
  const results = (value as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length !== expectedResults) {
    throw new Error("Prime Python audit response has the wrong result count");
  }
  return Object.freeze(
    results.map((result) => {
      if (result === null || Array.isArray(result) || typeof result !== "object") {
        throw new Error("Prime Python audit result is not an object");
      }
      const record = result as Record<string, unknown>;
      const listed = record.vulns ?? [];
      if (!Array.isArray(listed) || listed.length > 4_096) {
        throw new Error("Prime Python audit vulnerability list violates its bound");
      }
      const ids = listed.map((item) => {
        if (item === null || Array.isArray(item) || typeof item !== "object") {
          throw new Error("Prime Python audit vulnerability is not an object");
        }
        const id = (item as Record<string, unknown>).id;
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
          throw new Error("Prime Python audit vulnerability ID is invalid");
        }
        return id;
      });
      const nextPageToken = record.next_page_token;
      if (
        nextPageToken !== undefined &&
        (typeof nextPageToken !== "string" ||
          nextPageToken.length < 1 ||
          nextPageToken.length > 4_096)
      ) {
        throw new Error("Prime Python audit page token is invalid");
      }
      return Object.freeze({
        ids: Object.freeze(ids),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
    }),
  );
}

async function readStableLock(path: string): Promise<string> {
  const requestedPath = resolve(path);
  if ((await realpath(requestedPath)) !== requestedPath) {
    throw new Error("Prime Python lock path is not canonical");
  }
  const handle = await open(requestedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_LOCK_BYTES)) {
      throw new Error("Prime Python lock is not one bounded regular file");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("Prime Python lock ended while read");
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("Prime Python lock changed while read");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) {
    throw new Error("Prime Python audit response has no body");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Prime Python audit response exceeds its byte limit");
    }
    chunks.push(next.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
}
