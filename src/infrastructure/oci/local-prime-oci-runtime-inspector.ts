import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { parsePrimeOciRuntimeIdentity } from "../../domain/evaluation/external-harness.js";
import type { PrimeOciLocalRuntimeAttestation } from "./local-prime-oci-attestation.js";
import {
  primeDockerRuntimeMapSchema,
  selectedPrimeDockerRuntime,
} from "./prime-docker-runtime-metadata.js";
import { createPrimeOciRuntimePolicy, PRIME_OCI_RUNTIME_NAME } from "./prime-oci-policy.js";
import {
  type PrimeOciRuntimeInspection,
  settlePrimeOciInspectionStages,
  withPrimeOciInspectionStage,
} from "./prime-oci-preparation.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PRIME_DOCKER_API_VERSION = "1.51" as const;
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_095)
  .refine((value) => value.startsWith("/"), "must be an absolute path")
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "must be a normalized path",
  );
const executableSchema = z.object({ path: absolutePathSchema, sha256: sha256Schema }).strict();
const componentSchema = z
  .object({
    Name: z.string().min(1).max(64),
    Version: z.string().min(1).max(64),
    Details: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const versionSchema = z
  .object({
    Client: z
      .object({
        Version: z.string().min(1).max(64),
        ApiVersion: z.string().regex(/^\d+\.\d+$/),
        Os: z.literal("linux"),
        Arch: z.enum(["amd64", "x86_64"]),
      })
      .passthrough(),
    Server: z
      .object({
        Version: z.string().min(1).max(64),
        GitCommit: z.string().min(1).max(128),
        ApiVersion: z.string().regex(/^\d+\.\d+$/),
        Os: z.literal("linux"),
        Arch: z.enum(["amd64", "x86_64"]),
        KernelVersion: z.string().min(1).max(128),
        Components: z.array(componentSchema).max(32),
      })
      .passthrough(),
  })
  .strict();
const infoSchema = z
  .object({
    ID: z.string().min(1).max(256),
    Driver: z.string().min(1).max(64),
    CgroupDriver: z.string().min(1).max(64),
    CgroupVersion: z.union([z.literal(2), z.literal("2")]),
    KernelVersion: z.string().min(1).max(128),
    OSType: z.literal("linux"),
    Architecture: z.enum(["amd64", "x86_64"]),
    SecurityOptions: z.array(z.string().min(1).max(256)).max(64),
    ContainerdCommit: z.object({ ID: z.string().min(1).max(128) }).passthrough(),
    RuncCommit: z.object({ ID: z.string().min(1).max(128) }).passthrough(),
    DefaultRuntime: z.literal(PRIME_OCI_RUNTIME_NAME),
    Runtimes: primeDockerRuntimeMapSchema,
    Rootless: z.boolean().optional(),
  })
  .passthrough();

export interface LocalPrimeOciRuntimeInspectorOptions {
  readonly run: (args: readonly string[]) => Promise<string>;
  readonly local: () => Promise<PrimeOciLocalRuntimeAttestation>;
  readonly expectedExecutables: PrimeOciLocalRuntimeAttestation["executables"];
  readonly signal?: AbortSignal;
}

export class LocalPrimeOciRuntimeInspector {
  readonly #expectedExecutables: PrimeOciLocalRuntimeAttestation["executables"];
  readonly #local: () => Promise<PrimeOciLocalRuntimeAttestation>;
  readonly #run: (args: readonly string[]) => Promise<string>;
  readonly #signal: AbortSignal | undefined;

  constructor(options: LocalPrimeOciRuntimeInspectorOptions) {
    this.#expectedExecutables = normalizeExpectedExecutables(options.expectedExecutables);
    this.#local = options.local;
    this.#run = options.run;
    this.#signal = options.signal;
  }

  async inspect(): Promise<PrimeOciRuntimeInspection> {
    const [versionSource, infoSource, local] = await settlePrimeOciInspectionStages(
      [
        withPrimeOciInspectionStage(
          "read Docker version",
          () => this.#run(["version", "--format", "{{json .}}"]),
          this.#signal,
        ),
        withPrimeOciInspectionStage(
          "read Docker information",
          () => this.#run(["info", "--format", "{{json .}}"]),
          this.#signal,
        ),
        withPrimeOciInspectionStage(
          "validate Docker runtime identity",
          () => this.#local(),
          this.#signal,
        ),
      ],
      this.#signal,
    );
    const version = await withPrimeOciInspectionStage(
      "read Docker version",
      async () => parseJson(versionSchema, versionSource, "Docker version"),
      this.#signal,
    );
    const info = await withPrimeOciInspectionStage(
      "read Docker information",
      async () => parseJson(infoSchema, infoSource, "Docker information"),
      this.#signal,
    );
    await withPrimeOciInspectionStage(
      "validate Docker API identity",
      async () => {
        if (
          version.Client.ApiVersion !== version.Server.ApiVersion ||
          version.Server.ApiVersion !== local.apiVersion
        ) {
          throw new Error("Prime OCI Docker API versions do not match");
        }
        if (version.Server.ApiVersion !== PRIME_DOCKER_API_VERSION) {
          throw new Error(`Prime OCI Docker API version must be ${PRIME_DOCKER_API_VERSION}`);
        }
      },
      this.#signal,
    );
    await withPrimeOciInspectionStage(
      "validate Docker kernel identity",
      async () => {
        if (version.Server.KernelVersion !== info.KernelVersion) {
          throw new Error("Prime OCI Docker kernel identities do not match");
        }
      },
      this.#signal,
    );
    await withPrimeOciInspectionStage(
      "validate Docker daemon identity",
      async () => {
        if (info.ID !== local.daemonId) {
          throw new Error("Prime OCI Docker daemon identity changed during inspection");
        }
      },
      this.#signal,
    );
    await withPrimeOciInspectionStage(
      "validate Docker cgroup policy",
      async () => {
        if (info.CgroupDriver !== "systemd") {
          throw new Error("Prime OCI Docker cgroup driver must be systemd");
        }
      },
      this.#signal,
    );
    await withPrimeOciInspectionStage(
      "validate selected Docker runtime",
      async () => {
        if (selectedPrimeDockerRuntime(info.Runtimes).path !== local.executables.runc.path) {
          throw new Error("Prime OCI selected runc path does not match the observed executable");
        }
      },
      this.#signal,
    );
    await withPrimeOciInspectionStage(
      "validate runtime executable identity",
      async () => {
        if (!isDeepStrictEqual(local.executables, this.#expectedExecutables)) {
          throw new Error("Prime OCI runtime executable identity changed during inspection");
        }
      },
      this.#signal,
    );
    const { containerd, runc } = await withPrimeOciInspectionStage(
      "validate low-level runtime identity",
      async () => {
        const containerd = requiredComponent(version.Server.Components, "containerd");
        const runc = requiredComponent(version.Server.Components, PRIME_OCI_RUNTIME_NAME);
        const containerdCommit = requiredCommit(containerd, "containerd");
        const runcCommit = requiredCommit(runc, "runc");
        if (containerdCommit !== info.ContainerdCommit.ID || runcCommit !== info.RuncCommit.ID) {
          throw new Error("Prime OCI low-level runtime commits do not match");
        }
        return { containerd, runc };
      },
      this.#signal,
    );
    return withPrimeOciInspectionStage(
      "construct Docker runtime identity",
      async () => {
        const securityOptions = [...new Set(info.SecurityOptions)].sort();
        const rootless =
          info.Rootless ?? securityOptions.some((value) => value.includes("rootless"));
        const policy = createPrimeOciRuntimePolicy(sha256(canonicalize(local.seccompProfile)));
        const runtime = parsePrimeOciRuntimeIdentity({
          id: "docker-oci-v1",
          platform: "linux",
          architecture: "x64",
          client: {
            version: normalizeVersion(version.Client.Version, "Docker client"),
            executableSha256: this.#expectedExecutables.docker.sha256,
          },
          engine: {
            serverVersion: normalizeVersion(version.Server.Version, "Docker server"),
            serverCommit: version.Server.GitCommit,
            dockerdSha256: this.#expectedExecutables.dockerd.sha256,
            apiVersion: version.Server.ApiVersion,
            kernelRelease: version.Server.KernelVersion,
            kernelSecurityConfigSha256: sha256(
              canonicalize({ kernelRelease: version.Server.KernelVersion, securityOptions }),
            ),
            containerdVersion: normalizeVersion(containerd.Version, "containerd"),
            containerdSha256: this.#expectedExecutables.containerd.sha256,
            runcVersion: normalizeVersion(runc.Version, "runc"),
            runcSha256: this.#expectedExecutables.runc.sha256,
            cgroupVersion: 2,
            cgroupDriver: "systemd",
            storageDriver: info.Driver,
            rootless,
            securityOptionsSha256: sha256(canonicalize(securityOptions)),
          },
          policy,
        });
        const { daemonId, ...privateLocal } = local;
        return Object.freeze({ runtime, daemonId, local: Object.freeze(privateLocal) });
      },
      this.#signal,
    );
  }
}

function parseJson<Schema extends z.ZodType>(
  schema: Schema,
  source: string,
  label: string,
): z.output<Schema> {
  if (Buffer.byteLength(source, "utf8") > 1_048_576) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not JSON`, { cause: error });
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`${label} violates the closed schema`, { cause: parsed.error });
  }
  return parsed.data;
}

function normalizeExpectedExecutables(
  input: PrimeOciLocalRuntimeAttestation["executables"],
): PrimeOciLocalRuntimeAttestation["executables"] {
  return z
    .object({
      docker: executableSchema,
      dockerd: executableSchema,
      containerd: executableSchema,
      runc: executableSchema,
    })
    .strict()
    .parse(input);
}

function requiredComponent(
  components: readonly z.infer<typeof componentSchema>[],
  name: "containerd" | typeof PRIME_OCI_RUNTIME_NAME,
) {
  const matches = components.filter((component) => component.Name === name);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`Prime OCI Docker version has no unique ${name} component`);
  }
  return matches[0];
}

function requiredCommit(component: z.infer<typeof componentSchema>, label: string): string {
  const commit = component.Details?.GitCommit;
  if (commit === undefined || commit.length < 1 || commit.length > 128) {
    throw new Error(`Prime OCI ${label} component omits its commit`);
  }
  return commit;
}

function normalizeVersion(value: string, label: string): string {
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`Prime OCI ${label} version is invalid`);
  }
  return normalized;
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
    throw new Error("Prime OCI runtime identity contains a non-JSON value");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
