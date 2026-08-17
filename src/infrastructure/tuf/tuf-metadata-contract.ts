import { parseStrictJson } from "../../domain/strict-json.js";

const MAX_TUF_METADATA_DEPTH = 64;
const MAX_TUF_METADATA_NODES = 200_000;

export function assertUnambiguousTufMetadata(content: Uint8Array): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const document = parseStrictJson(text, {
    maxDepth: MAX_TUF_METADATA_DEPTH,
    maxNodes: MAX_TUF_METADATA_NODES,
    valueLabel: "TUF metadata",
  });
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.signed === null ||
    typeof document.signed !== "object" ||
    Array.isArray(document.signed)
  ) {
    throw new Error("TUF metadata shape violates its contract");
  }
  if (document.signed._type !== "targets") {
    return;
  }
  const delegations = document.signed.delegations;
  if (delegations === undefined) {
    return;
  }
  if (delegations === null || typeof delegations !== "object" || Array.isArray(delegations)) {
    throw new Error("TUF delegations shape violates its contract");
  }
  const roles = delegations.roles;
  if (roles === undefined) {
    return;
  }
  if (!Array.isArray(roles)) {
    throw new Error("TUF delegated roles shape violates its contract");
  }
  const names = new Set<string>();
  for (const role of roles) {
    if (
      role === null ||
      typeof role !== "object" ||
      Array.isArray(role) ||
      typeof role.name !== "string" ||
      names.has(role.name)
    ) {
      throw new Error("TUF delegated role authority is ambiguous");
    }
    names.add(role.name);
  }
}
