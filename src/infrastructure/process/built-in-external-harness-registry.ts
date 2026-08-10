import type { ExternalHarnessIdentity } from "../../domain/evaluation/external-harness.js";
import type { EvaluationProfileSource } from "../../domain/evaluation/plan.js";
import { NativeOmpHarnessRegistry } from "../omp/native-omp-harness-registry.js";
import { NativePiHarnessRegistry } from "../pi/native-pi-harness-registry.js";
import type { ExternalHarnessDescriptor } from "./external-harness-descriptor.js";

export type ExternalProfileSource = Exclude<
  EvaluationProfileSource,
  { readonly adapter: "flow-workflow-v1" }
>;

type PiProfileSource = Extract<ExternalProfileSource, { readonly adapter: "pi-native-v1" }>;
type OmpProfileSource = Extract<ExternalProfileSource, { readonly adapter: "omp-native-v1" }>;
type PiIdentity = Extract<ExternalHarnessIdentity, { readonly adapter: "pi-native-v1" }>;
type OmpIdentity = Extract<ExternalHarnessIdentity, { readonly adapter: "omp-native-v1" }>;

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

export interface BuiltInExternalHarnessRegistryOptions {
  readonly pi?: PiHarnessRegistry;
  readonly createOmp?: () => OmpHarnessRegistry;
}

export class BuiltInExternalHarnessRegistry implements ExternalHarnessRegistry {
  readonly #createOmp: () => OmpHarnessRegistry;
  #omp: OmpHarnessRegistry | undefined;
  readonly #pi: PiHarnessRegistry;

  constructor(options: BuiltInExternalHarnessRegistryOptions = {}) {
    this.#pi = options.pi ?? new NativePiHarnessRegistry();
    this.#createOmp = options.createOmp ?? (() => new NativeOmpHarnessRegistry());
  }

  async resolveIdentity(profile: ExternalProfileSource): Promise<ExternalHarnessIdentity> {
    if (profile.adapter === "pi-native-v1") {
      return this.#pi.resolveIdentity(profile);
    }
    return this.#ompRegistry().resolveIdentity(profile);
  }

  async resolveAdmitted(identity: ExternalHarnessIdentity): Promise<ExternalHarnessDescriptor> {
    if (identity.adapter === "pi-native-v1") {
      return this.#pi.resolveAdmitted(identity);
    }
    return this.#ompRegistry().resolveAdmitted(identity);
  }

  #ompRegistry(): OmpHarnessRegistry {
    this.#omp ??= this.#createOmp();
    return this.#omp;
  }
}
