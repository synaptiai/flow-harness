const OPENROUTER_DYNAMIC_MODEL_VARIANTS = new Set(["exacto", "floor", "nitro"]);

/** Resolve the catalog model behind one documented OpenRouter dynamic route. */
export function openRouterDynamicBaseModelId(provider: string, model: string): string | undefined {
  if (provider !== "openrouter") return undefined;
  const separator = model.lastIndexOf(":");
  if (separator < 1 || separator === model.length - 1) return undefined;
  const variant = model.slice(separator + 1);
  if (!OPENROUTER_DYNAMIC_MODEL_VARIANTS.has(variant)) return undefined;
  return model.slice(0, separator);
}
