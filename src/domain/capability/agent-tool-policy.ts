import type { PolicyAction } from "../policy/types.js";
import type { AgentToolName } from "../workflow/types.js";

const BUILT_IN_AGENT_TOOL_POLICY_ACTION_BY_SELECTOR = Object.freeze({
  read: "filesystem.read",
  ls: "filesystem.list",
  edit: "filesystem.write",
  replace: "filesystem.write",
  create: "filesystem.write",
  mkdir: "filesystem.write",
  exec: "process.execute",
  semantic: "filesystem.read",
  artifact: "artifact.read",
} as const satisfies Readonly<Record<AgentToolName, PolicyAction>>);

export function builtInAgentToolPolicyAction<TSelector extends AgentToolName>(
  selector: TSelector,
): (typeof BUILT_IN_AGENT_TOOL_POLICY_ACTION_BY_SELECTOR)[TSelector] {
  return BUILT_IN_AGENT_TOOL_POLICY_ACTION_BY_SELECTOR[selector];
}
