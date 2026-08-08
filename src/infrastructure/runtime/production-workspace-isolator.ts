import { join, resolve } from "node:path";

import type { WorkspaceIsolator } from "../../application/ports.js";
import { ReflinkCopyWorkspaceIsolator } from "../fs/reflink-copy-workspace-isolator.js";

export function createProductionWorkspaceIsolator(runsDirectory: string): WorkspaceIsolator {
  return new ReflinkCopyWorkspaceIsolator(join(resolve(runsDirectory), ".workspaces"));
}
