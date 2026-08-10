import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import { NativeOmpHarnessRegistry } from "../omp/native-omp-harness-registry.js";
import { NativePiHarnessRegistry } from "../pi/native-pi-harness-registry.js";
import type {
  NativePrimeHarnessDescriptor,
  NativePrimeHarnessRegistry,
} from "../prime/native-prime-harness-registry.js";
import type { ExternalHarnessDescriptor } from "./external-harness-descriptor.js";

export type ExternalProfileSource = Exclude<
  EvaluationProfileSource,
  { readonly adapter: "flow-workflow-v1" }
>;

type PiProfileSource = Extract<ExternalProfileSource, { readonly adapter: "pi-native-v1" }>;
type OmpProfileSource = Extract<ExternalProfileSource, { readonly adapter: "omp-native-v1" }>;
type PrimeProfileSource = Extract<
  ExternalProfileSource,
  { readonly adapter: "prime-agent-native-v1" }
>;
type PiIdentity = Extract<ExternalHarnessIdentity, { readonly adapter: "pi-native-v1" }>;
type OmpIdentity = Extract<ExternalHarnessIdentity, { readonly adapter: "omp-native-v1" }>;
type PrimeIdentity = Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "prime-agent-native-v1" }
>;

export interface ExternalHarnessRegistry {
  resolveIdentity(profile: ExternalProfileSource): Promise<ExternalHarnessIdentity>;
  resolveAdmitted(identity: ExternalHarnessIdentity): Promise<ExternalHarnessDescriptor>;
}

export interface PiHarnessRegistry {
  resolveIdentity(profile: PiProfileSource): Promise<PiIdentity>;
  resolveAdmitted(identity: ExternalHarnessIdentity): Promise<ExternalHarnessDescriptor>;
}

export interface OmpHarnessRegistry {
  resolveIdentity(profile: OmpProfileSource): Promise<OmpIdentity>;
  resolveAdmitted(identity: ExternalHarnessIdentity): Promise<ExternalHarnessDescriptor>;
}

export interface PrimeHarnessRegistry {
  resolveIdentity(profile: PrimeProfileSource): Promise<PrimeIdentity>;
  resolveAdmitted(identity: ExternalHarnessIdentity): Promise<NativePrimeHarnessDescriptor>;
}

export interface BuiltInExternalHarnessRegistryOptions {
  readonly pi?: PiHarnessRegistry;
  readonly createOmp?: () => OmpHarnessRegistry;
  readonly createPrime?: () => PrimeHarnessRegistry;
}

export class BuiltInExternalHarnessRegistry implements ExternalHarnessRegistry {
  readonly #createOmp: () => OmpHarnessRegistry;
  readonly #createPrime: () => PrimeHarnessRegistry;
  #omp: OmpHarnessRegistry | undefined;
  #prime: PrimeHarnessRegistry | undefined;
  readonly #pi: PiHarnessRegistry;

  constructor(options: BuiltInExternalHarnessRegistryOptions = {}) {
    this.#pi = options.pi ?? new NativePiHarnessRegistry();
    this.#createOmp = options.createOmp ?? (() => new NativeOmpHarnessRegistry());
    this.#createPrime = options.createPrime ?? (() => new LazyNativePrimeHarnessRegistry());
  }

  async resolveIdentity(profile: ExternalProfileSource): Promise<ExternalHarnessIdentity> {
    if (profile.adapter === "pi-native-v1") {
      return this.#pi.resolveIdentity(profile);
    }
    if (profile.adapter === "omp-native-v1") {
      return this.#ompRegistry().resolveIdentity(profile);
    }
    return this.#primeRegistry().resolveIdentity(profile);
  }

  async resolveAdmitted(identity: ExternalHarnessIdentity): Promise<ExternalHarnessDescriptor> {
    if (identity.adapter === "pi-native-v1") {
      return this.#pi.resolveAdmitted(identity);
    }
    if (identity.adapter === "omp-native-v1") {
      return this.#ompRegistry().resolveAdmitted(identity);
    }
    throw new Error("Prime Agent does not use the local process descriptor registry");
  }

  async resolvePrimeAdmitted(
    identity: ExternalHarnessIdentity,
  ): Promise<NativePrimeHarnessDescriptor> {
    if (identity.adapter !== "prime-agent-native-v1") {
      throw new Error("only Prime Agent can use the OCI descriptor registry");
    }
    return this.#primeRegistry().resolveAdmitted(identity);
  }

  #ompRegistry(): OmpHarnessRegistry {
    this.#omp ??= this.#createOmp();
    return this.#omp;
  }

  #primeRegistry(): PrimeHarnessRegistry {
    this.#prime ??= this.#createPrime();
    return this.#prime;
  }
}

class LazyNativePrimeHarnessRegistry implements PrimeHarnessRegistry {
  #registry: Promise<NativePrimeHarnessRegistry> | undefined;

  async resolveIdentity(profile: PrimeProfileSource): Promise<PrimeIdentity> {
    return (await this.#get()).resolveIdentity(profile);
  }

  async resolveAdmitted(identity: ExternalHarnessIdentity): Promise<NativePrimeHarnessDescriptor> {
    return (await this.#get()).resolveAdmitted(identity);
  }

  #get(): Promise<NativePrimeHarnessRegistry> {
    this.#registry ??= import("../prime/native-prime-harness-registry.js").then(
      ({ NativePrimeHarnessRegistry }) => new NativePrimeHarnessRegistry(),
    );
    return this.#registry;
  }
}
