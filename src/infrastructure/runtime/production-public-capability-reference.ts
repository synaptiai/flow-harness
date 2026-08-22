import {
  definePublicCapabilityCatalog,
  PUBLIC_CAPABILITY_CATALOG_VERSION,
  PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT,
  type PublicCapabilityCatalog,
} from "../../domain/capability/public-capability-reference.js";
import {
  WORKSPACE_AGENT_PUBLIC_LIMITS,
  WORKSPACE_AGENT_TOOL_REFERENCES,
} from "../pi/workspace-agent-tools.js";

export function createProductionPublicCapabilityCatalog(): PublicCapabilityCatalog {
  return definePublicCapabilityCatalog({
    version: PUBLIC_CAPABILITY_CATALOG_VERSION,
    jsonSchemaDialect: PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT,
    tools: WORKSPACE_AGENT_TOOL_REFERENCES,
    limits: WORKSPACE_AGENT_PUBLIC_LIMITS,
    capabilityFamilies: [
      {
        kind: "agent-skill",
        title: "Agent Skills",
        summary: "Inert instructions and resources selected by exact package identity.",
        extension: "dynamic",
      },
      {
        kind: "verifier-package",
        title: "Verifier packages",
        summary: "Inert command or model verification definitions admitted by exact identity.",
        extension: "dynamic",
      },
      {
        kind: "tool-package",
        title: "Command tool packages",
        summary: "Declarative scalar inputs rendered through closed argv-only command profiles.",
        extension: "dynamic",
      },
      {
        kind: "workflow-package",
        title: "Workflow packages",
        summary: "Inert workflow sources compiled through the ordinary Flow workflow contract.",
        extension: "dynamic",
      },
      {
        kind: "policy-package",
        title: "Policy packages",
        summary: "Inert policy narrowing that cannot grant authority beyond operator policy.",
        extension: "dynamic",
      },
      {
        kind: "presentation-package",
        title: "Presentation packages",
        summary: "Inert A2UI-profile presentation metadata for supported Flow hosts.",
        extension: "dynamic",
      },
    ],
    executionSeams: [
      {
        id: "model-provider",
        title: "Model provider",
        summary:
          "Provider and model identifiers resolve through the embedded Pi adapter at runtime.",
        openness: "open",
        implementation: "pi",
      },
    ],
    evaluationAdapters: [
      {
        id: "flow-workflow-v1",
        title: "Flow workflow",
        summary: "Execute an admitted workflow through the ordinary Flow runtime.",
        isolation: "flow-runtime",
      },
      {
        id: "pi-native-v1",
        title: "Native Pi",
        summary: "Execute the pinned native Pi harness through a local process adapter.",
        isolation: "local-process",
      },
      {
        id: "omp-native-v1",
        title: "Native OMP",
        summary: "Execute the pinned native OMP harness through a local process adapter.",
        isolation: "local-process",
      },
      {
        id: "prime-agent-native-v1",
        title: "Prime Agent",
        summary: "Execute the admitted Prime Agent harness through its OCI runtime contract.",
        isolation: "oci-container",
      },
    ],
  });
}
