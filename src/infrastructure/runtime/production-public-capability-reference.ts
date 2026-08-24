import {
  definePublicCapabilityCatalog,
  PUBLIC_CAPABILITY_CATALOG_VERSION,
  PUBLIC_CAPABILITY_JSON_SCHEMA_DIALECT,
  type PublicCapabilityCatalog,
  type PublicCapabilityLimitInput,
} from "../../domain/capability/public-capability-reference.js";
import { MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES } from "../../domain/evaluation/lean-proof-qualification.js";
import { CAPABILITY_PACKAGE_FAMILY_REFERENCES } from "../../domain/capability/capability-bundles.js";
import { EVALUATION_ADAPTER_REFERENCES } from "../../domain/evaluation/plan.js";
import {
  MAX_LEAN_PROOF_BYTES,
  MAX_LEAN_PROOF_SPECIFICATION_BYTES,
  MAX_LEAN_PROOF_STATEMENT_BYTES,
} from "../../domain/proof/lean-proof-verification.js";
import {
  WORKSPACE_AGENT_PUBLIC_LIMITS,
  WORKSPACE_AGENT_TOOL_REFERENCES,
} from "../pi/workspace-agent-tools.js";
import {
  PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR,
  PRODUCTION_COMMAND_EXECUTOR_DESCRIPTOR,
  PRODUCTION_LEAN_PROOF_VERIFIER_DESCRIPTOR,
} from "./production-node-executor.js";

const LEAN_PROOF_PUBLIC_LIMITS = Object.freeze<readonly PublicCapabilityLimitInput[]>([
  {
    id: "proof-specification-bytes",
    value: MAX_LEAN_PROOF_SPECIFICATION_BYTES,
    unit: "bytes",
    scope: "Maximum UTF-8 bytes in one private Lean proof source specification.",
  },
  {
    id: "proof-statement-bytes",
    value: MAX_LEAN_PROOF_STATEMENT_BYTES,
    unit: "bytes",
    scope: "Maximum UTF-8 bytes in one exact Lean theorem or lemma header.",
  },
  {
    id: "proof-term-bytes",
    value: MAX_LEAN_PROOF_BYTES,
    unit: "bytes",
    scope: "Maximum UTF-8 bytes in one separate Lean proof term.",
  },
  {
    id: "proof-qualification-input-bytes",
    value: MAX_LEAN_PROOF_QUALIFICATION_INPUT_BYTES,
    unit: "bytes",
    scope: "Maximum UTF-8 bytes in one Lean proof qualification input document.",
  },
]);

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
    limits: [...WORKSPACE_AGENT_PUBLIC_LIMITS, ...LEAN_PROOF_PUBLIC_LIMITS],
    capabilityFamilies: CAPABILITY_PACKAGE_FAMILY_REFERENCES,
    executionSeams: [
      PRODUCTION_AGENT_EXECUTOR_DESCRIPTOR.reference,
      PRODUCTION_LEAN_PROOF_VERIFIER_DESCRIPTOR.reference,
    ],
    evaluationAdapters: EVALUATION_ADAPTER_REFERENCES,
  });
}
