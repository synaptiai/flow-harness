import { createHash } from "node:crypto";

import { z } from "zod";

import { MAX_RUN_EVENT_BYTES, parseRunEvent, reduceRunEvents } from "../run/events.js";
import { parseStrictJson } from "../strict-json.js";
import { compileWorkflowText } from "../workflow/compiler.js";
import { calculateWorkflowDigest } from "../workflow/digest.js";

export const COMPATIBILITY_CORPUS_VERSION = "flow.compatibility-corpus/v1" as const;
export const COMPATIBILITY_REPORT_VERSION = "flow.compatibility-report/v1" as const;
export const MAX_COMPATIBILITY_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_COMPATIBILITY_ARTIFACTS = 64;
const MAX_COMPATIBILITY_LEDGER_EVENTS = 4_096;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/);
const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/);
const packageVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const artifactPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9._/-]+$/)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    "artifact path must be a contained relative path",
  );

const producerSchema = z
  .object({
    package: packageNameSchema,
    version: packageVersionSchema,
    archiveSha256: sha256Schema,
  })
  .strict();

const artifactBaseShape = {
  id: boundedIdentifierSchema,
  path: artifactPathSchema,
  sha256: sha256Schema,
  producer: producerSchema,
};

const authoredWorkflowArtifactSchema = z
  .object({
    ...artifactBaseShape,
    kind: z.literal("authored_workflow"),
    expected: z
      .object({
        apiVersion: z.literal("flow.synapti.ai/v1alpha1"),
        workflowId: boundedIdentifierSchema,
        workflowDigest: sha256Schema,
        nodeCount: z.number().int().nonnegative().safe(),
        criterionCount: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();

const terminalRunArtifactSchema = z
  .object({
    ...artifactBaseShape,
    kind: z.literal("terminal_run_ledger"),
    expected: z
      .object({
        runId: boundedIdentifierSchema,
        workflowId: boundedIdentifierSchema,
        workflowDigest: sha256Schema,
        terminalStatus: z.enum(["succeeded", "failed", "cancelled", "resource_exhausted"]),
        lastSequence: z.number().int().positive().safe(),
        evidenceNodeId: boundedIdentifierSchema,
        stdoutHash: sha256Schema,
        stderrHash: sha256Schema,
      })
      .strict(),
  })
  .strict();

const compatibilityArtifactSchema = z.discriminatedUnion("kind", [
  authoredWorkflowArtifactSchema,
  terminalRunArtifactSchema,
]);

const compatibilityCorpusManifestSchema = z
  .object({
    version: z.literal(COMPATIBILITY_CORPUS_VERSION),
    id: boundedIdentifierSchema,
    artifacts: z.array(compatibilityArtifactSchema).min(1).max(MAX_COMPATIBILITY_ARTIFACTS),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (ids.has(artifact.id)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "id"],
          message: "artifact identifiers must be unique",
        });
      }
      if (paths.has(artifact.path)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "path"],
          message: "artifact paths must be unique",
        });
      }
      ids.add(artifact.id);
      paths.add(artifact.path);
    }
  });

export type CompatibilityCorpusManifest = z.infer<typeof compatibilityCorpusManifestSchema>;
type CompatibilityArtifact = CompatibilityCorpusManifest["artifacts"][number];

export type CompatibilityCorpusErrorCode = "corpus_malformed" | "unsupported_corpus";

export class CompatibilityCorpusError extends Error {
  override readonly name = "CompatibilityCorpusError";

  constructor(
    readonly code: CompatibilityCorpusErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CompatibilityArtifactCategory =
  | "artifact_identity_mismatch"
  | "artifact_malformed"
  | "compatible"
  | "resource_limit"
  | "semantic_mismatch"
  | "source_missing";

export interface CompatibilityWorkflowObservations {
  readonly apiVersion: "flow.synapti.ai/v1alpha1";
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly nodeCount: number;
  readonly criterionCount: number;
}

export interface CompatibilityRunObservations {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowDigest: string;
  readonly terminalStatus: "succeeded" | "failed" | "cancelled" | "resource_exhausted";
  readonly lastSequence: number;
  readonly evidenceNodeId: string;
  readonly stdoutHash: string;
  readonly stderrHash: string;
}

export interface CompatibilityArtifactResult {
  readonly id: string;
  readonly kind: "authored_workflow" | "terminal_run_ledger";
  readonly producer: { readonly package: string; readonly version: string };
  readonly sourceSha256: string;
  readonly state: "compatible" | "incompatible";
  readonly category: CompatibilityArtifactCategory;
  readonly observations?: CompatibilityWorkflowObservations | CompatibilityRunObservations;
}

export interface CompatibilityReport {
  readonly version: typeof COMPATIBILITY_REPORT_VERSION;
  readonly flow: { readonly package: "@synapti/flow-harness"; readonly version: string };
  readonly corpus: {
    readonly version: typeof COMPATIBILITY_CORPUS_VERSION;
    readonly id: string;
    readonly sha256: string;
  };
  readonly overall: "compatible" | "incompatible";
  readonly artifacts: readonly CompatibilityArtifactResult[];
}

export function parseCompatibilityCorpusManifest(input: unknown): CompatibilityCorpusManifest {
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "version" in input &&
    input.version !== COMPATIBILITY_CORPUS_VERSION
  ) {
    throw new CompatibilityCorpusError(
      "unsupported_corpus",
      "compatibility corpus version is unsupported",
    );
  }
  const parsed = compatibilityCorpusManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new CompatibilityCorpusError("corpus_malformed", "compatibility corpus is malformed");
  }
  return parsed.data;
}

export function checkCompatibilityCorpus(input: {
  readonly flowVersion: string;
  readonly corpusSha256: string;
  readonly manifest: CompatibilityCorpusManifest;
  readonly sources: ReadonlyMap<string, Uint8Array>;
}): CompatibilityReport {
  if (
    !packageVersionSchema.safeParse(input.flowVersion).success ||
    !sha256Schema.safeParse(input.corpusSha256).success
  ) {
    throw new CompatibilityCorpusError(
      "corpus_malformed",
      "compatibility check identity is malformed",
    );
  }
  const artifacts = input.manifest.artifacts.map((artifact) =>
    checkArtifact(artifact, input.sources.get(artifact.path)),
  );
  return {
    version: COMPATIBILITY_REPORT_VERSION,
    flow: { package: "@synapti/flow-harness", version: input.flowVersion },
    corpus: {
      version: input.manifest.version,
      id: input.manifest.id,
      sha256: input.corpusSha256,
    },
    overall: artifacts.every((artifact) => artifact.state === "compatible")
      ? "compatible"
      : "incompatible",
    artifacts,
  };
}

function checkArtifact(
  artifact: CompatibilityArtifact,
  source: Uint8Array | undefined,
): CompatibilityArtifactResult {
  const base = {
    id: artifact.id,
    kind: artifact.kind,
    producer: { package: artifact.producer.package, version: artifact.producer.version },
    sourceSha256: artifact.sha256,
  } as const;
  if (source === undefined) {
    return { ...base, state: "incompatible", category: "source_missing" };
  }
  if (source.byteLength < 1 || source.byteLength > MAX_COMPATIBILITY_ARTIFACT_BYTES) {
    return { ...base, state: "incompatible", category: "resource_limit" };
  }
  if (sha256(source) !== artifact.sha256) {
    return { ...base, state: "incompatible", category: "artifact_identity_mismatch" };
  }

  try {
    const observations =
      artifact.kind === "authored_workflow"
        ? observeWorkflow(source)
        : observeTerminalRun(source, artifact.expected.evidenceNodeId);
    const compatible = expectedObservationsEqual(artifact.expected, observations);
    return {
      ...base,
      state: compatible ? "compatible" : "incompatible",
      category: compatible ? "compatible" : "semantic_mismatch",
      observations,
    };
  } catch {
    return { ...base, state: "incompatible", category: "artifact_malformed" };
  }
}

function observeWorkflow(source: Uint8Array): CompatibilityWorkflowObservations {
  const text = decodeUtf8(source);
  const workflow = compileWorkflowText(text, "compatibility corpus workflow");
  return {
    apiVersion: workflow.apiVersion,
    workflowId: workflow.id,
    workflowDigest: calculateWorkflowDigest(workflow),
    nodeCount: workflow.nodes.length,
    criterionCount: workflow.goal?.criteria.length ?? 0,
  };
}

function observeTerminalRun(
  source: Uint8Array,
  evidenceNodeId: string,
): CompatibilityRunObservations {
  const text = decodeUtf8(source);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length < 1 || lines.length > MAX_COMPATIBILITY_LEDGER_EVENTS) {
    throw new Error("compatibility ledger event count is outside its bound");
  }
  const events = lines.map((line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_RUN_EVENT_BYTES) {
      throw new Error("compatibility ledger event exceeds its bound");
    }
    return parseRunEvent(
      parseStrictJson(line, {
        maxDepth: 64,
        maxNodes: 262_144,
        valueLabel: "compatibility ledger event",
      }),
    );
  });
  const state = reduceRunEvents(events);
  if (
    state.status !== "succeeded" &&
    state.status !== "failed" &&
    state.status !== "cancelled" &&
    state.status !== "resource_exhausted"
  ) {
    throw new Error("compatibility ledger is not terminal");
  }
  const evidence = state.nodes[evidenceNodeId]?.evidence;
  if (evidence?.kind !== "command") {
    throw new Error("compatibility ledger command evidence is missing");
  }
  return {
    runId: state.runId,
    workflowId: state.workflowId,
    workflowDigest: state.workflowDigest,
    terminalStatus: state.status,
    lastSequence: state.lastSequence,
    evidenceNodeId,
    stdoutHash: evidence.stdoutHash,
    stderrHash: evidence.stderrHash,
  };
}

function expectedObservationsEqual(
  expected: CompatibilityArtifact["expected"],
  observations: CompatibilityWorkflowObservations | CompatibilityRunObservations,
): boolean {
  const keys = Object.keys(expected) as (keyof typeof expected)[];
  return keys.every((key) => expected[key] === observations[key as keyof typeof observations]);
}

function decodeUtf8(source: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(source);
}

function sha256(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}
