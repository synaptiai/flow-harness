import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function hasConfiguredLivePiModel(provider: string, model: string): Promise<boolean> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  if (!runtime.hasConfiguredAuth(provider)) {
    return false;
  }
  const available = await runtime.getAvailable(provider);
  if (!available.some((item) => item.id === model)) {
    throw new Error(`configured live Pi model "${provider}/${model}" is not available`);
  }
  return true;
}
