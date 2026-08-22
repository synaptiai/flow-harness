import type {
  ArtifactDescriptor,
  ArtifactProducer,
  ArtifactReference,
} from "../domain/artifact/reference.js";

export type ArtifactRetention = "retained" | "released";
export type ArtifactAvailability = "available" | "missing" | "changed" | "pruned";

export interface ArtifactInspection {
  readonly reference: ArtifactReference;
  readonly retention: ArtifactRetention;
  readonly availability: ArtifactAvailability;
}

export interface ArtifactCatalogEntry {
  readonly reference: ArtifactReference;
  readonly retention: ArtifactRetention;
}

export interface ArtifactReadWindow {
  readonly reference: ArtifactReference;
  readonly offset: number;
  readonly bytes: Buffer;
  readonly nextOffset: number;
  readonly complete: boolean;
}

export interface ArtifactPrunePlan {
  readonly version: 1;
  readonly catalogGeneration: number;
  readonly items: readonly ArtifactDescriptor[];
  readonly planDigest: string;
}

export interface ArtifactPruneResult {
  readonly planDigest: string;
  readonly pruned: readonly ArtifactDescriptor[];
}

export interface ArtifactStore {
  retain(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly producer: ArtifactProducer;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactReference>;
  read(input: {
    readonly reference: string;
    readonly runId: string;
    readonly offset: number;
    readonly maxBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactReadWindow>;
  inspect(reference: string, signal?: AbortSignal): Promise<ArtifactInspection>;
  list(signal?: AbortSignal): Promise<readonly ArtifactCatalogEntry[]>;
  setRetention(input: {
    readonly reference: string;
    readonly retention: ArtifactRetention;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactInspection>;
  planPrune(signal?: AbortSignal): Promise<ArtifactPrunePlan>;
  applyPrune(input: {
    readonly expectedPlanDigest: string;
    readonly signal?: AbortSignal;
  }): Promise<ArtifactPruneResult>;
}
