import {
  createLsToolDefinition,
  createReadToolDefinition,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";

import type { AgentToolName } from "../../domain/workflow/types.js";
import type { PolicyBroker } from "../../domain/policy/broker.js";
import { createWorkspacePolicyBroker } from "../policy/workspace-policy-broker.js";

export interface FlowAgentTools {
  readonly names: readonly string[];
  readonly definitions: readonly ToolDefinition[];
}

/** Build Flow-owned Pi tools whose filesystem view cannot escape the run cwd. */
export async function createWorkspaceReadTools(
  cwd: string,
  tools: readonly AgentToolName[],
  policy: PolicyBroker,
): Promise<FlowAgentTools> {
  const root = await realpath(cwd);
  const broker = await createWorkspacePolicyBroker(root, policy);
  const readOperations: ReadOperations = {
    access: async (path) => broker.execute("filesystem.read", path, access),
    readFile: async (path) => broker.execute("filesystem.read", path, (target) => readFile(target)),
  };
  const lsOperations: LsOperations = {
    exists: async (path) => {
      try {
        await broker.execute("filesystem.list", path, access);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    stat: async (path) => broker.execute("filesystem.list", path, stat),
    readdir: async (path) => broker.execute("filesystem.list", path, (target) => readdir(target)),
  };

  const definitions: ToolDefinition[] = [];
  const names: string[] = [];
  for (const tool of tools) {
    const runtimeName = `flow_${tool}`;
    const definition =
      tool === "read"
        ? createReadToolDefinition(root, { autoResizeImages: false, operations: readOperations })
        : createLsToolDefinition(root, { operations: lsOperations });
    definition.name = runtimeName;
    definition.label = tool;
    definition.description =
      tool === "read"
        ? "Read a UTF-8 text file inside the Flow execution workspace. Binary and image decoding is not supported."
        : "List files and directories inside the Flow execution workspace.";
    definition.promptSnippet =
      tool === "read" ? "Read workspace text files" : "List workspace directories";
    definition.promptGuidelines = [
      `Use ${runtimeName} only for paths inside the Flow execution workspace.`,
    ];
    definitions.push(definition as unknown as ToolDefinition);
    names.push(runtimeName);
  }

  return {
    names: Object.freeze(names),
    definitions: Object.freeze(definitions),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
