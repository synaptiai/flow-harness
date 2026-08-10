export interface PrimeRuntimeInventoryInput {
  readonly nodeRoot: string;
  readonly primeRoot: string;
  readonly pythonRoot: string;
}

export interface PrimeRuntimeInventory {
  readonly nodeVersion: string;
  readonly pythonVersion: string;
  readonly nodeClosureSha256: string;
  readonly primePackageContentSha256: string;
  readonly pythonClosureSha256: string;
  readonly sbom: {
    readonly node: readonly { readonly name: string; readonly version: string }[];
    readonly python: readonly { readonly name: string; readonly version: string }[];
  };
  readonly sbomSha256: string;
}

export function createRuntimeInventory(
  input: PrimeRuntimeInventoryInput,
): Promise<PrimeRuntimeInventory>;
