import {
  definePublicCapabilityCatalog,
  PUBLIC_CAPABILITY_CATALOG_VERSION,
  PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT,
  type PublicCapabilityCatalog,
} from "../../domain/capability/public-capability-reference.js";
import { CAPABILITY_PACKAGE_FAMILY_REFERENCES } from "../../domain/capability/capability-bundles.js";
import { EVALUATION_ADAPTER_REFERENCES } from "../../domain/evaluation/plan.js";
import {
  WORKSPACE_AGENT_PUBLIC_LIMITS,
  WORKSPACE_AGENT_TOOL_REFERENCES,
} from "../pi/workspace-agent-tools.js";
import {
  PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR,
  PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR,
} from "./production-node-executor.js";

export function createProductionPublicCapabilityCatalog(): PublicCapabilityCatalog {
  return definePublicCapabilityCatalog({
    version: PUBLIC_CAPABILITY_CATALOG_VERSION,
    jsonSchemaDialect: PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT,
    tools: WORKSPACE_AGENT_TOOL_REFERENCES.map((tool) =>
      tool.selector === "exec"
        ? {
            ...tool,
            availability: [
              ...tool.availability,
              ...PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR.availability,
            ],
          }
        : tool,
    ),
    limits: WORKSPACE_AGENT_PUBLIC_LIMITS,
    capabilityFamilies: CAPABILITY_PACKAGE_FAMILY_REFERENCES,
    executionSeams: [PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR.reference],
    evaluationAdapters: EVALUATION_ADAPTER_REFERENCES,
  });
}
