export function projectPublicRunOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => projectPublicRunOutput(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "capabilitySnapshot" && isRecord(item)
        ? projectCapabilitySnapshot(item)
        : projectPublicRunOutput(item),
    ]),
  );
}

function projectCapabilitySnapshot(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "packages") {
        return [key, projectPackages(item)];
      }
      if (key === "activations") {
        return [key, projectActivations(item)];
      }
      return [key, item];
    }),
  );
}

function projectPackages(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((item) =>
        isRecord(item) && item.kind === "agent-skill" ? projectAgentSkillPackage(item) : item,
      )
    : value;
}

function projectActivations(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((item) =>
        isRecord(item) &&
        (item.kind === "agent-skill-activation" || item.kind === "agent-skill-package-activation")
          ? projectAgentSkillActivation(item)
          : item,
      )
    : value;
}

function projectAgentSkillPackage(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "files" && Array.isArray(item) ? item.map((file) => omitContentBase64(file)) : item,
    ]),
  );
}

function projectAgentSkillActivation(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === "workflow") {
        return [key, omitContentBase64(item)];
      }
      if (key === "skill" && isRecord(item)) {
        return [key, projectAgentSkillPackage(item)];
      }
      return [key, item];
    }),
  );
}

function omitContentBase64(value: unknown): unknown {
  return isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "contentBase64"))
    : value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
