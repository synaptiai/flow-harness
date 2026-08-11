import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { parsePrimeOciImageIdentity } from "../../domain/evaluation/external-harness.js";
import { inspectPrimeImageArchive } from "./prime-image-archive.js";
import type { PrimeOciPreparedBuild } from "./prime-oci-preparation.js";

const executeFile = promisify(execFile);
const MAX_CONTEXT_ENTRIES = 131_072;
const MAX_CONTEXT_BYTES = 2_147_483_648;
const MAX_DOCKER_OUTPUT_BYTES = 16_777_216;
const MAX_DOCKER_COMMAND_MS = 1_800_000;
const MAX_PRIME_ARCHIVE_BYTES = 67_108_864;
const MAX_PRIME_ARCHIVE_DOWNLOAD_MS = 60_000;
const FIXED_BUILD_TIME = new Date(1_786_127_940_000);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const buildMetadataSchema = z
  .object({
    "containerimage.config.digest": imageDigestSchema,
    "containerimage.digest": imageDigestSchema,
  })
  .passthrough();
const buildInputsSchema = z
  .object({
    version: z.literal(1),
    platform: z.literal("linux/amd64"),
    sourceDateEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    baseImages: z.object({ golang: z.string(), node: z.string(), python: z.string() }).strict(),
    primeAgent: z
      .object({
        version: z.literal("0.7.1"),
        url: z.string().url(),
        sha256: z.literal("d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb"),
        integrity: z.literal(
          "sha512-BOT+mqCYeDpKYabk3HVP5T7HomlBUWiQOXZGnX/DYZwT4xvdQSeF7itt/tCU8nv82/30N7VJw5YdXssEyD3qGQ==",
        ),
      })
      .strict(),
    locks: z.object({ nodeSha256: sha256Schema, pythonSha256: sha256Schema }).strict(),
    seccomp: z.object({ base: z.string().min(1).max(256), sha256: sha256Schema }).strict(),
  })
  .strict();
const inspectionSchema = z
  .array(
    z
      .object({
        Id: imageDigestSchema,
        Architecture: z.literal("amd64"),
        Os: z.literal("linux"),
        Config: z.record(z.string(), z.unknown()),
        RootFS: z
          .object({ Type: z.literal("layers"), Layers: z.array(imageDigestSchema).max(512) })
          .strict(),
      })
      .passthrough(),
  )
  .length(1);
const packageSchema = z
  .object({ name: z.string().min(1).max(256), version: z.string().min(1).max(256) })
  .strict();
const probeSchema = z
  .object({
    nodeVersion: z.string().regex(/^22\.\d+\.\d+$/),
    pythonVersion: z.string().regex(/^3\.11\.\d+$/),
    nodeClosureSha256: sha256Schema,
    primePackageContentSha256: sha256Schema,
    pythonClosureSha256: sha256Schema,
    artifacts: z
      .object({
        driverSha256: sha256Schema,
        flowDistSha256: sha256Schema,
        kernelProxySha256: sha256Schema,
        noIoResourceLoaderSha256: sha256Schema,
        pythonLauncherSha256: sha256Schema,
        supervisorSha256: sha256Schema,
      })
      .strict(),
    sbom: z
      .object({
        node: z.array(packageSchema).max(8_192),
        python: z.array(packageSchema).max(8_192),
      })
      .strict(),
    sbomSha256: sha256Schema,
  })
  .strict();

const CONTEXT_FILES = Object.freeze([
  "Dockerfile",
  "build-inputs.json",
  "go.mod",
  "image-probe.mjs",
  "package.json",
  "package-lock.json",
  "python-requirements.in",
  "python-requirements.lock",
  "seccomp.json",
]);
const CONTEXT_DIRECTORIES = Object.freeze(["cmd", "internal"]);

export interface PrimeDockerCommandOptions {
  readonly environmentRoot: string;
}

export interface LocalPrimeImageBuilderOptions {
  readonly packageRoot: string;
  readonly dockerExecutable: string;
  readonly dockerBuildxExecutable: string;
  readonly temporaryRoot?: string;
  readonly run?: (args: readonly string[], options: PrimeDockerCommandOptions) => Promise<string>;
  readonly nonce?: () => string;
  readonly verifyPrimeArchive?: (input: {
    readonly url: string;
    readonly sha256: string;
    readonly integrity: string;
  }) => Promise<void>;
  readonly inspectImageArchive?: typeof inspectPrimeImageArchive;
}

export class LocalPrimeImageBuilder {
  readonly #dockerBuildxExecutable: string;
  readonly #dockerExecutable: string;
  readonly #nonce: () => string;
  readonly #packageRoot: string;
  readonly #inspectImageArchive: typeof inspectPrimeImageArchive;
  readonly #run: NonNullable<LocalPrimeImageBuilderOptions["run"]>;
  readonly #temporaryRoot: string;
  readonly #verifyPrimeArchive: NonNullable<LocalPrimeImageBuilderOptions["verifyPrimeArchive"]>;

  constructor(options: LocalPrimeImageBuilderOptions) {
    this.#packageRoot = resolve(options.packageRoot);
    this.#dockerExecutable = resolve(options.dockerExecutable);
    this.#dockerBuildxExecutable = resolve(options.dockerBuildxExecutable);
    this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
    this.#run =
      options.run ??
      ((args, commandOptions) =>
        runLocalDockerCommand(this.#dockerExecutable, args, commandOptions.environmentRoot));
    this.#nonce = options.nonce ?? (() => randomUUID().replaceAll("-", ""));
    this.#verifyPrimeArchive = options.verifyPrimeArchive ?? downloadAndVerifyPrimeAgentArchive;
    this.#inspectImageArchive = options.inspectImageArchive ?? inspectPrimeImageArchive;
  }

  async build(buildNumber: 1 | 2): Promise<PrimeOciPreparedBuild> {
    const operationRoot = await realpath(
      await mkdtemp(join(this.#temporaryRoot, `flow-prime-image-${buildNumber}-`)),
    );
    try {
      const contextRoot = join(operationRoot, "context");
      const environmentRoot = join(operationRoot, "docker-environment");
      await mkdir(contextRoot, { mode: 0o700 });
      await mkdir(environmentRoot, { mode: 0o700 });
      await stageDockerBuildxPlugin(this.#dockerBuildxExecutable, environmentRoot);
      const inputs = await stageBuildContext(this.#packageRoot, contextRoot);
      await this.#verifyPrimeArchive(inputs.primeAgent);
      const buildInputSha256 = await hashTree(contextRoot);
      const metadataFile = join(operationRoot, "build-metadata.json");
      const ociArchivePath = join(operationRoot, "prime-image.oci.tar");
      const tag = `flow-prime-runtime:preparation-${buildNumber}-${this.#nonce()}`;
      await this.#run(
        [
          "buildx",
          "build",
          "--pull=false",
          "--no-cache",
          `--output=type=oci,dest=${ociArchivePath},tar=true,compression=uncompressed,force-compression=true,rewrite-timestamp=true`,
          "--provenance=false",
          "--sbom=false",
          "--platform",
          inputs.platform,
          "--build-arg",
          "BUILDKIT_MULTI_PLATFORM=1",
          "--build-arg",
          `SOURCE_DATE_EPOCH=${inputs.sourceDateEpoch}`,
          "--metadata-file",
          metadataFile,
          "--tag",
          tag,
          contextRoot,
        ],
        { environmentRoot },
      );
      const buildMetadata = parseBuildMetadata(await readFile(metadataFile, "utf8"));
      const imageId = buildMetadata["containerimage.config.digest"];
      if (!imageDigestSchema.safeParse(imageId).success) {
        throw new Error("Prime image build returned an invalid image ID");
      }
      await this.#run(["image", "load", "--input", ociArchivePath], { environmentRoot });
      parseImageInspection(
        await this.#run(["image", "inspect", imageId], { environmentRoot }),
        imageId,
      );
      const imageArchivePath = join(operationRoot, "prime-image.tar");
      await this.#run(["image", "save", "--output", imageArchivePath, imageId], {
        environmentRoot,
      });
      const externalInventory = await this.#inspectImageArchive({
        archivePath: imageArchivePath,
        imageId,
      });
      const probe = parseProbe(
        await this.#run(
          [
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--log-driver=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=536870912",
            "--entrypoint=/usr/local/bin/node",
            imageId,
            "/opt/flow/bin/flow-prime-image-probe.mjs",
          ],
          { environmentRoot },
        ),
      );
      if (externalInventory.sbomSha256 !== probe.sbomSha256) {
        throw new Error("Prime external and in-image package inventories do not match");
      }
      const baseImageDigest = digestFromReference(inputs.baseImages.node, "Prime Node base image");
      const image = parsePrimeOciImageIdentity({
        id: imageId,
        ociManifestSha256: buildMetadata["containerimage.digest"].slice("sha256:".length),
        platformConfigSha256: buildMetadata["containerimage.config.digest"].slice("sha256:".length),
        buildInputSha256,
        sbomSha256: externalInventory.sbomSha256,
        baseImageDigest,
        nodeVersion: probe.nodeVersion,
        nodeClosureSha256: probe.nodeClosureSha256,
        pythonVersion: probe.pythonVersion,
        pythonClosureSha256: probe.pythonClosureSha256,
      });
      return Object.freeze({
        image,
        artifacts: probe.artifacts,
        harnessPackageContentSha256: probe.primePackageContentSha256,
        harnessDependencyClosureSha256: probe.nodeClosureSha256,
      });
    } finally {
      await rm(operationRoot, { recursive: true, force: true });
    }
  }
}

async function downloadAndVerifyPrimeAgentArchive(input: {
  readonly url: string;
  readonly sha256: string;
  readonly integrity: string;
}): Promise<void> {
  const response = await fetch(input.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(MAX_PRIME_ARCHIVE_DOWNLOAD_MS),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Prime release archive download returned status ${response.status}`);
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_PRIME_ARCHIVE_BYTES)
  ) {
    throw new Error("Prime release archive exceeds its byte limit");
  }
  const sha256Hash = createHash("sha256");
  const sha512Hash = createHash("sha512");
  let totalBytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_PRIME_ARCHIVE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Prime release archive exceeds its byte limit");
    }
    sha256Hash.update(next.value);
    sha512Hash.update(next.value);
  }
  assertPrimeAgentArchiveDigests(
    sha256Hash.digest("hex"),
    `sha512-${sha512Hash.digest("base64")}`,
    input,
  );
}

export function verifyPrimeAgentArchiveBytes(
  bytes: Uint8Array,
  expected: { readonly sha256: string; readonly integrity: string },
): void {
  assertPrimeAgentArchiveDigests(
    createHash("sha256").update(bytes).digest("hex"),
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    expected,
  );
}

function assertPrimeAgentArchiveDigests(
  actualSha256: string,
  actualIntegrity: string,
  expected: { readonly sha256: string; readonly integrity: string },
): void {
  if (actualSha256 !== expected.sha256) {
    throw new Error("Prime release archive SHA-256 does not match the fixed identity");
  }
  if (actualIntegrity !== expected.integrity) {
    throw new Error("Prime release archive integrity does not match the Node lock");
  }
}

async function stageDockerBuildxPlugin(source: string, environmentRoot: string): Promise<void> {
  const canonicalSource = await realpath(source);
  if (canonicalSource !== source) {
    throw new Error("Docker Buildx executable is not canonical");
  }
  await access(canonicalSource, constants.X_OK);
  const target = join(environmentRoot, "cli-plugins", "docker-buildx");
  await copyRegularFile(canonicalSource, target);
  await access(target, constants.X_OK);
}

async function stageBuildContext(packageRoot: string, contextRoot: string) {
  const canonicalPackageRoot = await realpath(packageRoot);
  if (canonicalPackageRoot !== packageRoot) {
    throw new Error("Prime package root is not canonical");
  }
  const containerRoot = join(packageRoot, "prime-container");
  for (const path of CONTEXT_FILES) {
    await copyRegularFile(join(containerRoot, path), join(contextRoot, path));
  }
  for (const path of CONTEXT_DIRECTORIES) {
    await copyTree(join(containerRoot, path), join(contextRoot, path));
  }
  await copyTree(join(packageRoot, "dist"), join(contextRoot, "flow-dist"));
  const inputs = buildInputsSchema.parse(
    JSON.parse(await readFile(join(contextRoot, "build-inputs.json"), "utf8")),
  );
  assertPrimeAgentLock(
    JSON.parse(await readFile(join(contextRoot, "package-lock.json"), "utf8")),
    inputs.primeAgent,
  );
  await assertFileDigest(
    join(contextRoot, "package-lock.json"),
    inputs.locks.nodeSha256,
    "Prime Node lock",
  );
  await assertFileDigest(
    join(contextRoot, "python-requirements.lock"),
    inputs.locks.pythonSha256,
    "Prime Python lock",
  );
  await assertFileDigest(
    join(contextRoot, "seccomp.json"),
    inputs.seccomp.sha256,
    "Prime seccomp profile",
  );
  await utimes(contextRoot, FIXED_BUILD_TIME, FIXED_BUILD_TIME);
  return inputs;
}

function assertPrimeAgentLock(
  input: unknown,
  expected: z.infer<typeof buildInputsSchema>["primeAgent"],
): void {
  const parsed = z
    .object({
      packages: z
        .object({
          "node_modules/prime-agent": z
            .object({
              version: z.literal("0.7.1"),
              resolved: z.string().url(),
              integrity: z.string().min(1).max(256),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(input);
  if (
    !parsed.success ||
    parsed.data.packages["node_modules/prime-agent"].resolved !== expected.url ||
    parsed.data.packages["node_modules/prime-agent"].integrity !== expected.integrity
  ) {
    throw new Error("Prime Node lock contradicts the fixed release archive identity", {
      cause: parsed.success ? undefined : parsed.error,
    });
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Prime build context source is not one direct directory");
  }
  await mkdir(target, { mode: metadata.mode & 0o777 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyRegularFile(sourcePath, targetPath);
    } else {
      throw new Error("Prime build context contains a link or special file");
    }
  }
  await utimes(target, FIXED_BUILD_TIME, FIXED_BUILD_TIME);
}

async function copyRegularFile(source: string, target: string): Promise<void> {
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Prime build context source is not one direct regular file");
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await chmod(target, Number(before.mode & 0o777n));
  await utimes(target, FIXED_BUILD_TIME, FIXED_BUILD_TIME);
  const after = await lstat(source, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.ctimeNs !== after.ctimeNs ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error("Prime build context source changed while copied");
  }
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  let entries = 0;
  let logicalBytes = 0;
  async function walk(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_CONTEXT_ENTRIES) {
        throw new Error("Prime build context exceeds its entry limit");
      }
      const path = join(directory, child.name);
      const fromRoot = relative(root, path).split("\\").join("/");
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isDirectory()) {
        hash.update(`d\0${fromRoot}\0${Number(metadata.mode & 0o777n).toString(8)}\n`);
        await walk(path);
      } else if (metadata.isFile()) {
        const bytes = await readStableFile(path, metadata);
        logicalBytes += bytes.byteLength;
        if (logicalBytes > MAX_CONTEXT_BYTES) {
          throw new Error("Prime build context exceeds its logical-byte limit");
        }
        hash.update(
          `f\0${fromRoot}\0${Number(metadata.mode & 0o777n).toString(8)}\0${bytes.byteLength}\0${sha256(bytes)}\n`,
        );
      } else {
        throw new Error("Prime build context contains a link or special file");
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function readStableFile(path: string, before: BigIntStats) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error("Prime build context file changed while hashed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertFileDigest(path: string, expected: string, label: string): Promise<void> {
  const actual = sha256(await readFile(path));
  if (actual !== expected) {
    throw new Error(`${label} digest does not match the fixed build inputs`);
  }
}

function parseImageInspection(source: string, imageId: string) {
  const parsed = inspectionSchema.safeParse(JSON.parse(source));
  if (!parsed.success || parsed.data[0]?.Id !== imageId) {
    throw new Error("Prime image inspection violates the closed schema", {
      cause: parsed.success ? undefined : parsed.error,
    });
  }
  return parsed.data[0];
}

function parseBuildMetadata(source: string) {
  const parsed = buildMetadataSchema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error("Prime image build metadata violates the closed schema", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseProbe(source: string) {
  const parsed = probeSchema.safeParse(JSON.parse(source));
  if (!parsed.success) {
    throw new Error("Prime image inventory violates the closed schema", { cause: parsed.error });
  }
  if (sha256(canonicalize(parsed.data.sbom)) !== parsed.data.sbomSha256) {
    throw new Error("Prime image inventory SBOM digest is invalid");
  }
  return parsed.data;
}

function digestFromReference(reference: string, label: string): string {
  const match = /@(?<digest>sha256:[a-f0-9]{64})$/.exec(reference);
  if (match?.groups?.digest === undefined) {
    throw new Error(`${label} is not pinned by a SHA-256 digest`);
  }
  return match.groups.digest;
}

export async function runLocalDockerCommand(
  dockerExecutable: string,
  args: readonly string[],
  environmentRoot: string,
  signal?: AbortSignal,
  timeoutMs = MAX_DOCKER_COMMAND_MS,
): Promise<string> {
  const result = await executeFile(dockerExecutable, [...args], {
    encoding: "utf8",
    maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
    env: {
      HOME: environmentRoot,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      DOCKER_CONFIG: environmentRoot,
      DOCKER_BUILDKIT: "1",
      SOURCE_DATE_EPOCH: "1786127940",
    },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    ...(signal === undefined ? {} : { signal }),
  });
  return result.stdout;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Prime image identity contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
