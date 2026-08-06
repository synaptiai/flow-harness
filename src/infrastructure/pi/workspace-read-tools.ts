import {
  createLsToolDefinition,
  createReadToolDefinition,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentToolName } from "../../domain/workflow/types.js";

export interface FlowAgentTools {
  readonly names: readonly string[];
  readonly definitions: readonly ToolDefinition[];
}

/** Build Flow-owned Pi tools whose filesystem view cannot escape the run cwd. */
export async function createWorkspaceReadTools(
  cwd: string,
  tools: readonly AgentToolName[],
): Promise<FlowAgentTools> {
  const root = await realpath(cwd);
  const guard = createWorkspacePathGuard(root);
  const readOperations: ReadOperations = {
    access: async (path) => access(await guard(path)),
    readFile: async (path) => readFile(await guard(path)),
  };
  const lsOperations: LsOperations = {
    exists: async (path) => {
      try {
        await access(await guard(path));
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    stat: async (path) => stat(await guard(path)),
    readdir: async (path) => readdir(await guard(path)),
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

export function createWorkspacePathGuard(
  canonicalRoot: string,
): (inputPath: string) => Promise<string> {
  const root = resolve(canonicalRoot);
  return async (inputPath) => {
    const lexicalPath = resolve(root, inputPath);
    if (!isAbsolute(inputPath)) {
      assertWithinRoot(root, lexicalPath);
    }
    const canonicalPath = await realpath(lexicalPath);
    assertWithinRoot(root, canonicalPath);
    return canonicalPath;
  };
}

function assertWithinRoot(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  ) {
    return;
  }
  throw new Error(`Path is outside the Flow execution workspace: ${candidate}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
