import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import {
  type AcpAgentArtifactIdentity,
  type AcpAgentManifest,
  type AcpAgentRuntimeSnapshot,
  createAcpAgentRuntimeSnapshot,
  MAX_ACP_AGENT_EXECUTABLE_BYTES,
  MAX_ACP_AGENT_MANIFEST_BYTES,
  MAX_ACP_AGENT_PACKAGE_BYTES,
  MAX_ACP_AGENT_PACKAGE_FILES,
  parseAcpAgentManifest,
  validateAcpAgentRuntimeSnapshot,
} from "../../domain/capability/acp-agent.js";
import {
  ArtifactObservations,
  readTrustedPackageClosure,
} from "../pi/native-pi-harness-registry.js";

export interface LocalAcpAgentRuntimeAdmission {
  readonly snapshot: AcpAgentRuntimeSnapshot;
  readonly assertCurrent: () => Promise<void>;
}

export interface LocalAcpAgentRuntimeAdmissionInput {
  readonly manifestPath: string;
  readonly provenance: string;
}

export class LocalAcpAgentAdmissionError extends Error {
  override readonly name = "LocalAcpAgentAdmissionError";
  readonly code = "local_acp_agent_admission_failed" as const;

  constructor() {
    super("local ACP agent admission failed");
  }
}

export class LocalAcpAgentIdentityChangedError extends Error {
  override readonly name = "LocalAcpAgentIdentityChangedError";
  readonly code = "local_acp_agent_identity_changed" as const;

  constructor() {
    super("local ACP agent identity changed after admission");
  }
}

export async function admitLocalAcpAgentRuntime(
  input: LocalAcpAgentRuntimeAdmissionInput,
): Promise<LocalAcpAgentRuntimeAdmission> {
  try {
    const observations = new ArtifactObservations();
    const manifestArtifact = await readObservedFile(
      input.manifestPath,
      MAX_ACP_AGENT_MANIFEST_BYTES,
      false,
      true,
      observations,
    );
    if (manifestArtifact.content === undefined) {
      throw new Error("manifest content");
    }
    const manifest = parseAcpAgentManifest(manifestArtifact.content);
    const launch =
      manifest.spec.launch.kind === "binary"
        ? await admitBinaryLaunch(manifest, observations)
        : await admitNodePackageLaunch(manifest, observations);
    const snapshot = createAcpAgentRuntimeSnapshot({
      provenance: input.provenance,
      manifest: manifestArtifact.content,
      launch,
    });
    if (!(await observations.isCurrent())) {
      throw new Error("identity drift");
    }
    return Object.freeze({
      snapshot,
      assertCurrent: async () => {
        try {
          if (!(await observations.isCurrent())) {
            throw new Error("identity drift");
          }
        } catch {
          throw new LocalAcpAgentIdentityChangedError();
        }
      },
    });
  } catch (error) {
    if (error instanceof LocalAcpAgentAdmissionError) {
      throw error;
    }
    throw new LocalAcpAgentAdmissionError();
  }
}

export async function assertLocalAcpAgentRuntimeCurrent(
  projectRoot: string,
  durableSnapshot: AcpAgentRuntimeSnapshot,
): Promise<void> {
  try {
    const snapshot = validateAcpAgentRuntimeSnapshot(durableSnapshot);
    const current = await admitLocalAcpAgentRuntime({
      manifestPath: join(projectRoot, snapshot.manifest.provenance),
      provenance: snapshot.manifest.provenance,
    });
    if (
      current.snapshot.digest !== snapshot.digest ||
      JSON.stringify(current.snapshot) !== JSON.stringify(snapshot)
    ) {
      throw new Error("identity drift");
    }
  } catch {
    throw new LocalAcpAgentIdentityChangedError();
  }
}

async function admitBinaryLaunch(manifest: AcpAgentManifest, observations: ArtifactObservations) {
  const launch = manifest.spec.launch;
  if (launch.kind !== "binary") {
    throw new Error("binary launch");
  }
  const artifact = await readObservedFile(
    launch.executable,
    MAX_ACP_AGENT_EXECUTABLE_BYTES,
    true,
    false,
    observations,
  );
  return Object.freeze({
    kind: "binary" as const,
    executable: artifact.identity,
  });
}

async function admitNodePackageLaunch(
  manifest: AcpAgentManifest,
  observations: ArtifactObservations,
) {
  const launch = manifest.spec.launch;
  if (launch.kind !== "node-package") {
    throw new Error("Node package launch");
  }
  const [nodeArtifact, rootBefore, resolutionRootBefore] = await Promise.all([
    readObservedFile(
      launch.nodeExecutable,
      MAX_ACP_AGENT_EXECUTABLE_BYTES,
      true,
      false,
      observations,
    ),
    readCanonicalDirectory(launch.packageRoot, observations),
    readCanonicalDirectory(launch.packageResolutionRoot, observations),
  ]);
  const closure = await readTrustedPackageClosure(
    launch.packageRoot,
    launch.packageName,
    launch.packageVersion,
    "local ACP agent package closure",
    observations,
    {
      bindResolutionGraph: true,
      includeMarkdown: true,
      includePeerDependencies: true,
      maxTotalBytes: MAX_ACP_AGENT_PACKAGE_BYTES,
      maxTotalFiles: MAX_ACP_AGENT_PACKAGE_FILES,
      rejectLinkedPackageRoots: true,
      rejectUnselectedNestedPackages: true,
      resolutionRoot: launch.packageResolutionRoot,
    },
  );
  const entrypoint = await readObservedFile(
    join(launch.packageRoot, launch.packageEntrypoint),
    MAX_ACP_AGENT_PACKAGE_BYTES,
    false,
    false,
    observations,
  );
  const [rootAfter, resolutionRootAfter] = await Promise.all([
    lstat(launch.packageRoot, { bigint: true }),
    lstat(launch.packageResolutionRoot, { bigint: true }),
  ]);
  if (
    !sameBigintFileIdentity(rootBefore, rootAfter) ||
    !sameBigintFileIdentity(resolutionRootBefore, resolutionRootAfter)
  ) {
    throw new Error("package closure changed");
  }
  observations.addObserved(launch.packageRoot, rootAfter);
  observations.addObserved(launch.packageResolutionRoot, resolutionRootAfter);
  return Object.freeze({
    kind: "node-package" as const,
    nodeExecutable: nodeArtifact.identity,
    nodeVersion: launch.nodeVersion,
    package: Object.freeze({
      root: launch.packageRoot,
      resolutionRoot: launch.packageResolutionRoot,
      name: launch.packageName,
      version: launch.packageVersion,
      sha256: closure.sha256,
      bytes: closure.bytes,
      files: closure.files,
      device: rootAfter.dev.toString(),
      inode: rootAfter.ino.toString(),
      entrypoint: Object.freeze({
        path: launch.packageEntrypoint,
        sha256: entrypoint.identity.sha256,
        bytes: entrypoint.identity.bytes,
        device: entrypoint.identity.device,
        inode: entrypoint.identity.inode,
      }),
    }),
  });
}

async function readCanonicalDirectory(
  path: string,
  observations: ArtifactObservations,
): Promise<BigIntStats> {
  if (!isCanonicalAbsolutePath(path)) {
    throw new Error("directory path");
  }
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || (await realpath(path)) !== path) {
    throw new Error("directory identity");
  }
  observations.addObserved(path, before);
  return before;
}

async function readObservedFile(
  path: string,
  maxBytes: number,
  requireExecutable: boolean,
  retainContent: boolean,
  observations: ArtifactObservations,
): Promise<{
  readonly identity: AcpAgentArtifactIdentity;
  readonly content?: Buffer | undefined;
}> {
  if (!isCanonicalAbsolutePath(path)) {
    throw new Error("file path");
  }
  const pathStat = await lstat(path, { bigint: true });
  if (!pathStat.isFile() || (await realpath(path)) !== path) {
    throw new Error("file identity");
  }
  observations.addObserved(path, pathStat);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("file open");
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameBigintFileIdentity(pathStat, before)) {
      throw new Error("file replacement");
    }
    if (requireExecutable && (Number(before.mode) & 0o111) === 0) {
      throw new Error("file executable mode");
    }
    if (before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error("file size");
    }
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw new Error("file size");
      }
      const content = chunk.subarray(0, bytesRead);
      hash.update(content);
      if (retainContent) {
        chunks.push(content);
      }
    }
    const after = await handle.stat({ bigint: true });
    if (BigInt(total) !== before.size || !sameBigintFileIdentity(before, after)) {
      throw new Error("file changed");
    }
    observations.addObserved(path, after);
    return Object.freeze({
      identity: Object.freeze({
        path,
        sha256: hash.digest("hex"),
        bytes: total,
        device: after.dev.toString(),
        inode: after.ino.toString(),
      }),
      ...(retainContent ? { content: Buffer.concat(chunks, total) } : {}),
    });
  } finally {
    await handle.close();
  }
}

function isCanonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && !value.includes("\0");
}

function sameBigintFileIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
