import { spawn } from "node:child_process";
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
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import { parsePrimeOciImageIdentity } from "../../domain/evaluation/external-harness.js";
import {
  inspectPrimeImageArchive,
  PrimeImageArchiveInspectionError,
  type PrimeImageArchiveInspectionStage,
} from "./prime-image-archive.js";
import type { PrimeOciPreparedBuild } from "./prime-oci-preparation.js";

const MAX_CONTEXT_ENTRIES = 131_072;
const MAX_CONTEXT_BYTES = 2_147_483_648;
const MAX_DOCKER_OUTPUT_BYTES = 16_777_216;
const MAX_DOCKER_COMMAND_MS = 1_800_000;
const MAX_PRIME_ARCHIVE_BYTES = 67_108_864;
const MAX_PRIME_ARCHIVE_DOWNLOAD_MS = 60_000;
const MAX_RECOVERY_OPERATIONS = 16;
const MAX_RECOVERY_JOURNAL_BYTES = 8_192;
const RECOVERY_JOURNAL = "recovery.json";
const FIXED_BUILD_TIME = new Date(1_786_127_940_000);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const buildkitImageReferenceSchema = z
  .string()
  .regex(/^moby\/buildkit:[a-z0-9.-]+@sha256:[a-f0-9]{64}$/);
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
    buildkit: z.object({ image: buildkitImageReferenceSchema }).strict(),
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
const builderContainerInspectionSchema = z
  .array(
    z
      .object({
        Image: imageDigestSchema,
        Config: z.object({ Image: buildkitImageReferenceSchema }).passthrough(),
      })
      .passthrough(),
  )
  .length(1);
const recoveryJournalSchema = z
  .object({
    version: z.literal(1),
    hostname: z.string().min(1).max(255),
    pid: z.number().int().positive().max(2_147_483_647),
    bootId: z.string().min(1).max(255),
    processStartTicks: z.string().regex(/^\d+$/),
    builderName: z.string().regex(/^flow-prime-builder-[12]-[a-f0-9]{32}$/),
    builderContainerName: z
      .string()
      .regex(/^buildx_buildkit_flow-prime-builder-[12]-[a-f0-9]{32}0$/),
    buildkitImageReference: buildkitImageReferenceSchema,
    temporaryTag: z.string().regex(/^flow-prime-runtime:preparation-[12]-[a-f0-9]{32}$/),
    probeContainerName: z.string().regex(/^flow-prime-probe-[12]-[a-f0-9]{32}$/),
    imageId: imageDigestSchema.optional(),
    canonicalReference: z
      .string()
      .regex(/^flow-prime-runtime:sha256-[a-f0-9]{64}$/)
      .optional(),
    canonicalReferenceExisted: z.boolean().optional(),
  })
  .strict();
type RecoveryJournal = z.infer<typeof recoveryJournalSchema>;
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
const CONTEXT_DIRECTORIES = Object.freeze(["cmd", "internal", "native"]);

export interface PrimeDockerCommandOptions {
  readonly environmentRoot: string;
  readonly signal?: AbortSignal;
}

export type PrimeImageBuildStage =
  | PrimeImageArchiveInspectionStage
  | "recover interrupted builds"
  | "stage build context"
  | "create BuildKit builder"
  | "bootstrap BuildKit builder"
  | "inspect BuildKit builder"
  | "verify Prime archive"
  | "hash build inputs"
  | "build OCI image"
  | "read build metadata"
  | "inspect image references"
  | "load OCI image"
  | "inspect loaded image"
  | "inspect image archive"
  | "probe built image"
  | "finalize image identity"
  | "tag canonical image"
  | "clean build resources";

export class PrimeImageBuildStageError extends Error {
  override readonly name = "PrimeImageBuildStageError";

  constructor(
    readonly stage: PrimeImageBuildStage,
    cause: unknown,
  ) {
    super(`Prime image build failed during ${stage}`, { cause });
  }
}

export function primeImageBuildStageForDockerCommand(
  args: readonly string[],
): PrimeImageBuildStage {
  const [resource, operation] = args;
  if (resource === "buildx" && operation === "create") {
    return "create BuildKit builder";
  }
  if (resource === "buildx" && operation === "inspect") {
    return "bootstrap BuildKit builder";
  }
  if (resource === "container" && operation === "inspect") {
    return "inspect BuildKit builder";
  }
  if (resource === "buildx" && operation === "build") {
    return "build OCI image";
  }
  if (resource === "image" && operation === "ls") {
    return "inspect image references";
  }
  if (resource === "image" && operation === "load") {
    return "load OCI image";
  }
  if (resource === "image" && operation === "inspect") {
    return "inspect loaded image";
  }
  if (resource === "run") {
    return "probe built image";
  }
  if (resource === "image" && operation === "tag") {
    return "tag canonical image";
  }
  throw new Error("Prime image build used an unclassified Docker command");
}

interface PrimeImageBuildOperation {
  readonly operationRoot: string;
  readonly builderName: string;
  readonly builderContainerName: string;
  readonly temporaryTag: string;
  readonly probeContainerName: string;
}

async function createPrimeImageBuildOperation(
  temporaryRoot: string,
  buildNumber: 1 | 2,
  nonce: () => string,
): Promise<PrimeImageBuildOperation> {
  let createdRoot: string | undefined;
  try {
    createdRoot = await mkdtemp(join(temporaryRoot, `flow-prime-image-${buildNumber}-`));
    const operationRoot = await realpath(createdRoot);
    const operationNonce = nonce();
    const builderName = `flow-prime-builder-${buildNumber}-${operationNonce}`;
    return Object.freeze({
      operationRoot,
      builderName,
      builderContainerName: `buildx_buildkit_${builderName}0`,
      temporaryTag: `flow-prime-runtime:preparation-${buildNumber}-${operationNonce}`,
      probeContainerName: `flow-prime-probe-${buildNumber}-${operationNonce}`,
    });
  } catch (error) {
    const primary = new PrimeImageBuildStageError("stage build context", error);
    if (createdRoot === undefined) {
      throw primary;
    }
    try {
      await rm(createdRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new PrimeImageBuildStageError(
        "clean build resources",
        new AggregateError([primary, cleanupError], "Prime image build setup cleanup failed"),
      );
    }
    throw primary;
  }
}

export interface LocalPrimeImageBuilderOptions {
  readonly packageRoot: string;
  readonly dockerExecutable: string;
  readonly dockerBuildxExecutable: string;
  readonly temporaryRoot?: string;
  readonly run?: (args: readonly string[], options: PrimeDockerCommandOptions) => Promise<string>;
  readonly cleanupRun?: (
    args: readonly string[],
    options: PrimeDockerCommandOptions,
  ) => Promise<string>;
  readonly nonce?: () => string;
  readonly verifyPrimeArchive?: (input: {
    readonly url: string;
    readonly sha256: string;
    readonly integrity: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly inspectImageArchive?: typeof inspectPrimeImageArchive;
  readonly retainedImageId?: string;
  readonly removePath?: typeof rm;
  readonly recoveryRealpath?: (path: string) => Promise<string>;
}

interface CompletedPrimeImageBuildOperation {
  readonly reference: string;
  readonly imageId: string;
  readonly operationRoot: string;
  readonly ownsReference: boolean;
}

export class LocalPrimeImageBuilder {
  readonly #completedOperations: CompletedPrimeImageBuildOperation[] = [];
  readonly #dockerBuildxExecutable: string;
  readonly #dockerExecutable: string;
  readonly #nonce: () => string;
  readonly #packageRoot: string;
  readonly #inspectImageArchive: typeof inspectPrimeImageArchive;
  readonly #run: NonNullable<LocalPrimeImageBuilderOptions["run"]>;
  readonly #cleanupRun: NonNullable<LocalPrimeImageBuilderOptions["cleanupRun"]>;
  readonly #temporaryRoot: string;
  readonly #retainedImageId: string | undefined;
  readonly #removePath: typeof rm;
  readonly #recoveryRealpath: NonNullable<LocalPrimeImageBuilderOptions["recoveryRealpath"]>;
  readonly #verifyPrimeArchive: NonNullable<LocalPrimeImageBuilderOptions["verifyPrimeArchive"]>;

  constructor(options: LocalPrimeImageBuilderOptions) {
    this.#packageRoot = resolve(options.packageRoot);
    this.#dockerExecutable = resolve(options.dockerExecutable);
    this.#dockerBuildxExecutable = resolve(options.dockerBuildxExecutable);
    this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
    this.#retainedImageId = options.retainedImageId;
    this.#removePath = options.removePath ?? rm;
    this.#recoveryRealpath = options.recoveryRealpath ?? realpath;
    this.#run =
      options.run ??
      ((args, commandOptions) =>
        runLocalDockerCommand(
          this.#dockerExecutable,
          args,
          commandOptions.environmentRoot,
          commandOptions.signal,
        ));
    this.#cleanupRun = options.cleanupRun ?? this.#run;
    this.#nonce = options.nonce ?? (() => randomUUID().replaceAll("-", ""));
    this.#verifyPrimeArchive = options.verifyPrimeArchive ?? downloadAndVerifyPrimeAgentArchive;
    this.#inspectImageArchive = options.inspectImageArchive ?? inspectPrimeImageArchive;
  }

  async build(buildNumber: 1 | 2, signal?: AbortSignal): Promise<PrimeOciPreparedBuild> {
    throwIfAborted(signal);
    try {
      await this.recoverInterruptedBuilds();
    } catch (error) {
      throw new PrimeImageBuildStageError("recover interrupted builds", error);
    }
    throwIfAborted(signal);
    const operation = await createPrimeImageBuildOperation(
      this.#temporaryRoot,
      buildNumber,
      this.#nonce,
    );
    const { operationRoot, builderName, builderContainerName, temporaryTag, probeContainerName } =
      operation;
    const environmentRoot = join(operationRoot, "docker-environment");
    const operationOptions: PrimeDockerCommandOptions = {
      environmentRoot,
      ...(signal === undefined ? {} : { signal }),
    };
    let buildResult: PrimeOciPreparedBuild | undefined;
    let buildError: unknown;
    let journal: RecoveryJournal | undefined;
    let completedOperation: CompletedPrimeImageBuildOperation | undefined;
    let stage: PrimeImageBuildStage = "stage build context";
    const runBuildCommand = async (args: readonly string[]): Promise<string> => {
      stage = primeImageBuildStageForDockerCommand(args);
      return this.#run(args, operationOptions);
    };
    try {
      const contextRoot = join(operationRoot, "context");
      await mkdir(contextRoot, { mode: 0o700 });
      await mkdir(environmentRoot, { mode: 0o700 });
      const buildx = await stageDockerBuildxPlugin(
        this.#dockerBuildxExecutable,
        environmentRoot,
        signal,
      );
      const inputs = await stageBuildContext(this.#packageRoot, contextRoot, signal);
      const processOwner = await observeProcessOwner(process.pid);
      journal = recoveryJournalSchema.parse({
        version: 1,
        hostname: hostname(),
        pid: process.pid,
        bootId: processOwner.bootId,
        processStartTicks: processOwner.startTicks,
        builderName,
        builderContainerName,
        buildkitImageReference: inputs.buildkit.image,
        temporaryTag,
        probeContainerName,
      });
      await writeRecoveryJournal(operationRoot, journal, true);
      await runBuildCommand([
        "buildx",
        "create",
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${inputs.buildkit.image}`,
        "--name",
        builderName,
      ]);
      await runBuildCommand(["buildx", "inspect", "--bootstrap", builderName]);
      const builder = parseBuilderContainerInspection(
        await runBuildCommand(["container", "inspect", builderContainerName]),
        inputs.buildkit.image,
      );
      stage = "verify Prime archive";
      await this.#verifyPrimeArchive({
        ...inputs.primeAgent,
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      stage = "hash build inputs";
      const buildInputSha256 = sha256(
        canonicalize({
          contextSha256: await hashTree(contextRoot, signal),
          builder: {
            clientSha256: buildx.sha256,
            imageId: builder.Image,
            imageReference: builder.Config.Image,
          },
        }),
      );
      const metadataFile = join(operationRoot, "build-metadata.json");
      const loadArchivePath = join(operationRoot, "prime-image.docker.tar");
      await runBuildCommand([
        "buildx",
        "build",
        "--builder",
        builderName,
        "--pull=false",
        "--no-cache",
        `--output=type=docker,dest=${loadArchivePath},tar=true,compression=uncompressed,force-compression=true,rewrite-timestamp=true,oci-mediatypes=true`,
        "--provenance=false",
        "--sbom=false",
        "--platform",
        inputs.platform,
        "--build-arg",
        `SOURCE_DATE_EPOCH=${inputs.sourceDateEpoch}`,
        "--metadata-file",
        metadataFile,
        "--tag",
        temporaryTag,
        contextRoot,
      ]);
      stage = "read build metadata";
      const buildMetadata = parseBuildMetadata(await readFile(metadataFile, "utf8"));
      const imageId = buildMetadata["containerimage.config.digest"];
      if (!imageDigestSchema.safeParse(imageId).success) {
        throw new Error("Prime image build returned an invalid image ID");
      }
      throwIfAborted(signal);
      stage = "inspect image archive";
      const externalInventory = await this.#inspectImageArchive({
        archivePath: loadArchivePath,
        imageId,
      });
      throwIfAborted(signal);
      const canonicalReference = canonicalPrimeImageReference(imageId);
      const existingReferences = parseImageReferenceList(
        await runBuildCommand(["image", "ls", "--quiet", "--no-trunc", canonicalReference]),
      );
      if (existingReferences.some((reference) => reference !== imageId)) {
        throw new Error("Prime content-addressed image tag resolves to another image");
      }
      const canonicalReferenceExisted = existingReferences.includes(imageId);
      journal = recoveryJournalSchema.parse({
        ...journal,
        imageId,
        canonicalReference,
        canonicalReferenceExisted,
      });
      await writeRecoveryJournal(operationRoot, journal, false);
      await runBuildCommand(["image", "load", "--input", loadArchivePath]);
      parseImageInspection(await runBuildCommand(["image", "inspect", imageId]), imageId);
      const probe = parseProbe(
        await runBuildCommand([
          "run",
          "--rm",
          "--name",
          probeContainerName,
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
        ]),
      );
      if (externalInventory.sbomSha256 !== probe.sbomSha256) {
        throw new Error("Prime external and in-image package inventories do not match");
      }
      stage = "finalize image identity";
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
      await runBuildCommand(["image", "tag", imageId, canonicalReference]);
      buildResult = Object.freeze({
        image,
        builder: Object.freeze({
          clientPath: buildx.path,
          clientSha256: buildx.sha256,
          imageId: builder.Image,
          imageReference: builder.Config.Image,
        }),
        artifacts: probe.artifacts,
        harnessPackageContentSha256: probe.primePackageContentSha256,
        harnessDependencyClosureSha256: probe.nodeClosureSha256,
      });
      completedOperation = {
        reference: canonicalReference,
        imageId,
        operationRoot,
        ownsReference: !canonicalReferenceExisted,
      };
    } catch (error) {
      if (error instanceof PrimeImageArchiveInspectionError) {
        stage = error.stage;
      }
      buildError = isPrimeImageBuildCancellation(error, signal)
        ? signal?.reason instanceof Error
          ? signal.reason
          : new Error("Prime image build was cancelled")
        : new PrimeImageBuildStageError(stage, error);
    }

    const cleanupErrors: unknown[] = [];
    if (journal !== undefined) {
      try {
        await this.#cleanupOperation(journal, environmentRoot, buildResult !== undefined);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 0 && buildResult === undefined) {
      try {
        await this.#removePath(operationRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new PrimeImageBuildStageError(
        "clean build resources",
        new AggregateError(
          buildError === undefined ? cleanupErrors : [buildError, ...cleanupErrors],
          "Prime image build cleanup failed",
        ),
      );
    }
    if (buildError !== undefined) {
      throw buildError;
    }
    if (buildResult === undefined) {
      throw new Error("Prime image build produced no result");
    }
    if (completedOperation === undefined) {
      throw new Error("Prime image build produced no completed operation");
    }
    this.#completedOperations.push(completedOperation);
    return buildResult;
  }

  async recoverInterruptedBuilds(): Promise<void> {
    const canonicalTemporaryRoot = await this.#recoveryRealpath(this.#temporaryRoot);
    const entries = (await readdir(this.#temporaryRoot, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && /^flow-prime-image-[12]-[A-Za-z0-9_-]{6,64}$/.test(entry.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    if (entries.length > MAX_RECOVERY_OPERATIONS) {
      throw new Error("Prime image recovery operation count exceeds its limit");
    }
    for (const entry of entries) {
      const requestedOperationRoot = join(this.#temporaryRoot, entry.name);
      await assertPrivateRecoveryDirectory(requestedOperationRoot);
      const operationRoot = await this.#recoveryRealpath(requestedOperationRoot);
      if (dirname(operationRoot) !== canonicalTemporaryRoot) {
        throw new Error("Prime image recovery directory escapes its temporary root");
      }
      if (this.#completedOperations.some((created) => created.operationRoot === operationRoot)) {
        continue;
      }
      const journalPath = join(operationRoot, RECOVERY_JOURNAL);
      let journal: RecoveryJournal | undefined;
      try {
        journal = await readRecoveryJournal(journalPath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      if (journal === undefined) {
        await this.#removePath(operationRoot, { recursive: true, force: true });
        continue;
      }
      if (journal.hostname !== hostname()) {
        throw new Error("Prime image recovery journal belongs to another host");
      }
      if (await isRecoveryOwnerActive(journal)) {
        throw new Error("Prime image preparation is already active");
      }
      const environmentRoot = join(operationRoot, "docker-environment");
      await this.#cleanupOperation(
        journal,
        environmentRoot,
        journal.imageId === this.#retainedImageId,
      );
      await this.#removePath(operationRoot, { recursive: true, force: true });
    }
  }

  async #cleanupOperation(
    journal: RecoveryJournal,
    environmentRoot: string,
    retainCanonicalReference: boolean,
  ): Promise<void> {
    await this.#removeNamedContainer(journal.probeContainerName, environmentRoot);
    const builderIds = parseDockerIdList(
      await this.#cleanupRun(
        [
          "container",
          "ls",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `name=^/${journal.builderContainerName}$`,
        ],
        { environmentRoot },
      ),
    );
    if (builderIds.length > 0) {
      parseBuilderContainerInspection(
        await this.#cleanupRun(["container", "inspect", journal.builderContainerName], {
          environmentRoot,
        }),
        journal.buildkitImageReference,
      );
      await this.#cleanupRun(["buildx", "rm", "--force", journal.builderName], {
        environmentRoot,
      });
      const remaining = parseDockerIdList(
        await this.#cleanupRun(
          [
            "container",
            "ls",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            `name=^/${journal.builderContainerName}$`,
          ],
          { environmentRoot },
        ),
      );
      if (remaining.length > 0) {
        throw new Error("Prime BuildKit container remains after cleanup");
      }
    }
    await this.#removeImageReference(journal.temporaryTag, undefined, environmentRoot);
    if (
      !retainCanonicalReference &&
      journal.canonicalReferenceExisted === false &&
      journal.canonicalReference !== undefined &&
      journal.imageId !== undefined
    ) {
      await this.#removeImageReference(
        journal.canonicalReference,
        journal.imageId,
        environmentRoot,
      );
    }
  }

  async #removeNamedContainer(name: string, environmentRoot: string): Promise<void> {
    const ids = parseDockerIdList(
      await this.#cleanupRun(
        ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`],
        { environmentRoot },
      ),
    );
    if (ids.length === 0) {
      return;
    }
    await this.#cleanupRun(["container", "rm", "--force", name], { environmentRoot });
  }

  async #removeImageReference(
    reference: string,
    expectedImageId: string | undefined,
    environmentRoot: string,
  ): Promise<void> {
    const imageIds = parseImageReferenceList(
      await this.#cleanupRun(["image", "ls", "--quiet", "--no-trunc", reference], {
        environmentRoot,
      }),
    );
    if (imageIds.length === 0) {
      return;
    }
    if (expectedImageId !== undefined && imageIds[0] !== expectedImageId) {
      throw new Error("Prime image cleanup reference resolves to another image");
    }
    await this.#cleanupRun(["image", "rm", "--force", reference], { environmentRoot });
  }

  async retireCreatedImagesExcept(retainedImageId?: string): Promise<void> {
    const operationRoot = await realpath(
      await mkdtemp(join(this.#temporaryRoot, "flow-prime-image-retirement-")),
    );
    let retirementError: unknown;
    try {
      for (const completed of this.#completedOperations) {
        if (completed.ownsReference && completed.imageId !== retainedImageId) {
          await this.#cleanupRun(["image", "rm", "--force", completed.reference], {
            environmentRoot: operationRoot,
          });
        }
        await this.#removePath(completed.operationRoot, { recursive: true, force: true });
      }
      this.#completedOperations.splice(0);
    } catch (error) {
      retirementError = error;
    }
    let environmentCleanupError: unknown;
    try {
      await this.#removePath(operationRoot, { recursive: true, force: true });
    } catch (error) {
      environmentCleanupError = error;
    }
    if (retirementError !== undefined || environmentCleanupError !== undefined) {
      throw new PrimeImageBuildStageError(
        "clean build resources",
        new AggregateError(
          retirementError === undefined
            ? [environmentCleanupError]
            : environmentCleanupError === undefined
              ? [retirementError]
              : [retirementError, environmentCleanupError],
          "Prime image retirement cleanup failed",
        ),
      );
    }
  }
}

function canonicalPrimeImageReference(imageId: string): string {
  return `flow-prime-runtime:sha256-${imageId.slice("sha256:".length)}`;
}

function parseImageReferenceList(source: string): readonly string[] {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
    throw new Error("Prime image reference list exceeds its byte limit");
  }
  const references = source.trim() === "" ? [] : source.trim().split("\n");
  if (
    references.length > 1 ||
    references.some((value) => !imageDigestSchema.safeParse(value).success)
  ) {
    throw new Error("Prime image reference list is invalid");
  }
  return Object.freeze(references);
}

function parseDockerIdList(source: string): readonly string[] {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCKER_OUTPUT_BYTES) {
    throw new Error("Prime Docker object list exceeds its byte limit");
  }
  const ids = source.trim() === "" ? [] : source.trim().split("\n");
  if (ids.length > 1 || ids.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Prime Docker object list is invalid");
  }
  return Object.freeze(ids);
}

async function writeRecoveryJournal(
  operationRoot: string,
  journal: RecoveryJournal,
  exclusive: boolean,
): Promise<void> {
  const journalPath = join(operationRoot, RECOVERY_JOURNAL);
  const bytes = Buffer.from(`${JSON.stringify(recoveryJournalSchema.parse(journal))}\n`, "utf8");
  if (bytes.byteLength > MAX_RECOVERY_JOURNAL_BYTES) {
    throw new Error("Prime image recovery journal exceeds its byte limit");
  }
  if (exclusive) {
    const handle = await open(
      journalPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    const temporaryPath = `${journalPath}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, journalPath);
  }
  await syncDirectory(operationRoot);
}

async function readRecoveryJournal(path: string): Promise<RecoveryJournal> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_RECOVERY_JOURNAL_BYTES) {
      throw new Error("Prime image recovery journal is invalid");
    }
    return recoveryJournalSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

async function assertPrivateRecoveryDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Prime image recovery directory is not private");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function isRecoveryOwnerActive(journal: RecoveryJournal): Promise<boolean> {
  try {
    const owner = await observeProcessOwner(journal.pid);
    return owner.bootId === journal.bootId && owner.startTicks === journal.processStartTicks;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function observeProcessOwner(
  pid: number,
): Promise<{ readonly bootId: string; readonly startTicks: string }> {
  if (process.platform !== "linux") {
    if (pid !== process.pid) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          throw Object.assign(new Error("process is absent"), { code: "ENOENT" });
        }
        throw error;
      }
    }
    return Object.freeze({
      bootId: `${hostname()}:non-linux`,
      startTicks: String(Math.trunc(performance.timeOrigin)),
    });
  }
  const [bootIdSource, statSource] = await Promise.all([
    readBoundedTextFile("/proc/sys/kernel/random/boot_id", 255),
    readBoundedTextFile(`/proc/${pid}/stat`, 8_192),
  ]);
  const closingParenthesis = statSource.lastIndexOf(")");
  const fields = statSource
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  if (closingParenthesis < 1 || startTicks === undefined || !/^\d+$/.test(startTicks)) {
    throw new Error("Prime image recovery process identity is invalid");
  }
  return Object.freeze({ bootId: bootIdSource.trim(), startTicks });
}

async function readBoundedTextFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    const result = await handle.read(bytes, 0, bytes.byteLength, null);
    if (result.bytesRead < 1 || result.bytesRead > maxBytes) {
      throw new Error("Prime image recovery identity exceeds its byte limit");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
  } finally {
    await handle.close();
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function downloadAndVerifyPrimeAgentArchive(input: {
  readonly url: string;
  readonly sha256: string;
  readonly integrity: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  throwIfAborted(input.signal);
  const timeoutSignal = AbortSignal.timeout(MAX_PRIME_ARCHIVE_DOWNLOAD_MS);
  const signal =
    input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
  const response = await fetch(input.url, {
    redirect: "follow",
    signal,
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
    throwIfAborted(signal);
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

async function stageDockerBuildxPlugin(
  source: string,
  environmentRoot: string,
  signal?: AbortSignal,
): Promise<{ readonly path: string; readonly sha256: string }> {
  throwIfAborted(signal);
  const canonicalSource = await realpath(source);
  if (canonicalSource !== source) {
    throw new Error("Docker Buildx executable is not canonical");
  }
  await access(canonicalSource, constants.X_OK);
  const target = join(environmentRoot, "cli-plugins", "docker-buildx");
  await copyRegularFile(canonicalSource, target, signal);
  await access(target, constants.X_OK);
  const sourceMetadata = await lstat(canonicalSource, { bigint: true });
  const targetMetadata = await lstat(target, { bigint: true });
  const sourceSha256 = sha256(await readStableFile(canonicalSource, sourceMetadata));
  const targetSha256 = sha256(await readStableFile(target, targetMetadata));
  if (sourceSha256 !== targetSha256) {
    throw new Error("Docker Buildx staging changed the verified client bytes");
  }
  return Object.freeze({ path: canonicalSource, sha256: sourceSha256 });
}

async function stageBuildContext(packageRoot: string, contextRoot: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const canonicalPackageRoot = await realpath(packageRoot);
  if (canonicalPackageRoot !== packageRoot) {
    throw new Error("Prime package root is not canonical");
  }
  const containerRoot = join(packageRoot, "prime-container");
  for (const path of CONTEXT_FILES) {
    throwIfAborted(signal);
    await copyRegularFile(join(containerRoot, path), join(contextRoot, path), signal);
  }
  for (const path of CONTEXT_DIRECTORIES) {
    throwIfAborted(signal);
    await copyTree(join(containerRoot, path), join(contextRoot, path), signal);
  }
  await copyTree(join(packageRoot, "dist"), join(contextRoot, "flow-dist"), signal);
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

async function copyTree(source: string, target: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Prime build context source is not one direct directory");
  }
  await mkdir(target, { mode: metadata.mode & 0o777 });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    throwIfAborted(signal);
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath, signal);
    } else if (entry.isFile()) {
      await copyRegularFile(sourcePath, targetPath, signal);
    } else {
      throw new Error("Prime build context contains a link or special file");
    }
  }
  await utimes(target, FIXED_BUILD_TIME, FIXED_BUILD_TIME);
}

async function copyRegularFile(
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Prime build context source is not one direct regular file");
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  throwIfAborted(signal);
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

async function hashTree(root: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let entries = 0;
  let logicalBytes = 0;
  async function walk(directory: string): Promise<void> {
    throwIfAborted(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      throwIfAborted(signal);
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

function parseBuilderContainerInspection(source: string, expectedReference: string) {
  const parsed = builderContainerInspectionSchema.safeParse(JSON.parse(source));
  if (!parsed.success || parsed.data[0]?.Config.Image !== expectedReference) {
    throw new Error("Prime BuildKit container does not use the fixed image", {
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
  signal?.throwIfAborted();
  return await new Promise((resolveCommand, rejectCommand) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let terminationStarted = false;
    const child = spawn(dockerExecutable, [...args], {
      detached: process.platform === "linux",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: environmentRoot,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        DOCKER_CONFIG: environmentRoot,
        DOCKER_BUILDKIT: "1",
        SOURCE_DATE_EPOCH: "1786127940",
      },
    });

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const requestTermination = (reason: "abort" | "failure" | "timeout", failure?: Error): void => {
      if (terminationStarted || settled) {
        return;
      }
      terminationStarted = true;
      cleanup();
      terminateDockerCommandGroup(child.pid);
      void waitForDockerCommandGroupExit(child.pid).then(
        () => {
          if (settled) {
            return;
          }
          settled = true;
          if (reason === "abort") {
            rejectCommand(abortError(signal?.reason));
          } else if (reason === "timeout") {
            rejectCommand(terminatedCommandError("Docker command timed out"));
          } else {
            rejectCommand(failure ?? new Error("Docker command failed"));
          }
        },
        (settlementError: unknown) => {
          if (!settled) {
            settled = true;
            rejectCommand(settlementError);
          }
        },
      );
    };
    const onAbort = (): void => requestTermination("abort");
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => requestTermination("timeout"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_DOCKER_OUTPUT_BYTES) {
        requestTermination("failure", new Error("Docker command stdout exceeds its byte limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_DOCKER_OUTPUT_BYTES) {
        requestTermination("failure", new Error("Docker command stderr exceeds its byte limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => requestTermination("failure", error));
    child.once("exit", (code, childSignal) => {
      if (code === 0 || terminationStarted || settled) {
        return;
      }
      const diagnostic = Buffer.concat(stderr).toString("utf8").slice(0, 4_096);
      requestTermination(
        "failure",
        new Error(
          `Docker command failed with ${childSignal ?? String(code)}${
            diagnostic.length === 0 ? "" : `: ${diagnostic}`
          }`,
        ),
      );
    });
    child.once("close", (code, childSignal) => {
      if (terminationStarted || settled) {
        return;
      }
      if (code === 0) {
        settled = true;
        cleanup();
        resolveCommand(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const diagnostic = Buffer.concat(stderr).toString("utf8").slice(0, 4_096);
      requestTermination(
        "failure",
        new Error(
          `Docker command failed with ${childSignal ?? String(code)}${
            diagnostic.length === 0 ? "" : `: ${diagnostic}`
          }`,
        ),
      );
    });
  });
}

function terminateDockerCommandGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(process.platform === "linux" ? -pid : pid, "SIGKILL");
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ESRCH")) {
      throw error;
    }
  }
}

async function waitForDockerCommandGroupExit(pid: number | undefined): Promise<void> {
  if (pid === undefined || process.platform !== "linux") {
    return;
  }
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await delay(10);
  }
  throw new Error("Docker command process group did not terminate within the cleanup bound");
}

function terminatedCommandError(message: string): Error {
  return Object.assign(new Error(message), { killed: true, signal: "SIGKILL" });
}

class PrimeDockerCommandAbortError extends Error {
  override readonly name = "AbortError";
  readonly code = "ABORT_ERR";
  readonly killed = true;
  readonly signal = "SIGKILL";

  constructor(reason: unknown) {
    super("The Docker command was aborted", { cause: reason });
  }
}

function abortError(reason: unknown): Error {
  return new PrimeDockerCommandAbortError(reason);
}

function isPrimeImageBuildCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted !== true) {
    return false;
  }
  return (
    error === signal.reason ||
    (error instanceof PrimeDockerCommandAbortError && error.cause === signal.reason)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
