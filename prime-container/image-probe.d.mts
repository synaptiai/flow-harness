export interface PrimeRuntimeInventoryInput {
  readonly nodeRoot: string;
  readonly primeRoot: string;
  readonly pythonRoot: string;
  readonly flowDistRoot: string;
  readonly artifacts: {
    readonly driver: string;
    readonly kernelProxy: string;
    readonly noIoResourceLoader: string;
    readonly pythonLauncher: string;
    readonly supervisor: string;
  };
}

export interface PrimeRuntimeInventory {
  readonly nodeVersion: string;
  readonly pythonVersion: string;
  readonly nodeClosureSha256: string;
  readonly primePackageContentSha256: string;
  readonly pythonClosureSha256: string;
  readonly artifacts: {
    readonly driverSha256: string;
    readonly flowDistSha256: string;
    readonly kernelProxySha256: string;
    readonly noIoResourceLoaderSha256: string;
    readonly pythonLauncherSha256: string;
    readonly supervisorSha256: string;
  };
  readonly sbom: {
    readonly node: readonly { readonly name: string; readonly version: string }[];
    readonly python: readonly { readonly name: string; readonly version: string }[];
  };
  readonly sbomSha256: string;
}

export interface NativePrimeSdkBindingLoaders {
  readonly loadSdk: () => Promise<Readonly<Record<string, unknown>>>;
}

export function createRuntimeInventory(
  input: PrimeRuntimeInventoryInput,
): Promise<PrimeRuntimeInventory>;

export function verifyNativePrimeSdkBindings(loaders?: NativePrimeSdkBindingLoaders): Promise<void>;
