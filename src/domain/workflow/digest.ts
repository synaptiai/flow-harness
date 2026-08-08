import { createHash } from "node:crypto";

import type { CompiledWorkflow } from "./types.js";

export function calculateWorkflowDigest(workflow: CompiledWorkflow): string {
  return createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
}
