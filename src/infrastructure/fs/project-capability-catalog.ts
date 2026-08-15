import { MAX_AGENT_SKILL_PACKAGES } from "../../domain/capability/agent-skills.js";
import {
  AgentSkillCatalogError,
  createInstalledDiscoveredAgentSkill,
  type DiscoveredAgentSkill,
  discoverProjectAgentSkills,
  type ProjectAgentSkillCatalog,
} from "./local-agent-skill-catalog.js";
import { LocalCapabilityPackageStore } from "./local-capability-package-store.js";
import {
  assertPolicyPackageCatalog,
  createInstalledDiscoveredPolicyPackage,
  discoverProjectPolicyPackages,
  type ProjectPolicyPackageCatalog,
} from "./local-policy-package-catalog.js";
import {
  createInstalledDiscoveredToolPackage,
  type DiscoveredToolPackage,
  discoverProjectToolPackages,
  MAX_TOOL_PACKAGES,
  type ProjectToolPackageCatalog,
  ToolPackageCatalogError,
} from "./local-tool-package-catalog.js";
import {
  createInstalledDiscoveredVerifierPackage,
  type DiscoveredVerifierPackage,
  discoverProjectVerifierPackages,
  MAX_VERIFIER_PACKAGES,
  type ProjectVerifierPackageCatalog,
  VerifierPackageCatalogError,
} from "./local-verifier-package-catalog.js";
import {
  assertWorkflowPackageCatalog,
  createInstalledDiscoveredWorkflowPackage,
  discoverProjectWorkflowPackages,
  type ProjectWorkflowPackageCatalog,
} from "./local-workflow-package-catalog.js";

export interface ProjectCapabilityCatalogs {
  readonly agentSkills: ProjectAgentSkillCatalog;
  readonly verifiers: ProjectVerifierPackageCatalog;
  readonly tools: ProjectToolPackageCatalog;
  readonly workflows: ProjectWorkflowPackageCatalog;
  readonly policies: ProjectPolicyPackageCatalog;
}

export interface ProjectCapabilityCatalogOptions {
  readonly signal?: AbortSignal;
}

export async function discoverProjectCapabilityCatalogs(
  projectRoot: string,
  options: ProjectCapabilityCatalogOptions = {},
): Promise<ProjectCapabilityCatalogs> {
  options.signal?.throwIfAborted();
  const [
    localAgentSkills,
    localVerifiers,
    localTools,
    localWorkflows,
    localPolicies,
    installedBundles,
  ] = await Promise.all([
    discoverProjectAgentSkills(projectRoot),
    discoverProjectVerifierPackages(projectRoot),
    discoverProjectToolPackages(projectRoot),
    discoverProjectWorkflowPackages(projectRoot),
    discoverProjectPolicyPackages(projectRoot, options),
    new LocalCapabilityPackageStore(projectRoot).verify(),
  ]);
  options.signal?.throwIfAborted();
  const agentSkills = [...localAgentSkills.skills];
  const verifiers = [...localVerifiers.packages];
  const tools = [...localTools.packages];
  const workflows = [...localWorkflows.packages];
  const policies = [...localPolicies.packages];
  for (const installed of installedBundles) {
    options.signal?.throwIfAborted();
    for (const item of installed.bundle.packages) {
      if (item.kind === "agent-skill") {
        agentSkills.push(
          createInstalledDiscoveredAgentSkill({
            projectRoot: localAgentSkills.projectRoot,
            bundleDigest: installed.entry.digest,
            skill: item,
          }),
        );
      } else if (item.kind === "verifier-package") {
        verifiers.push(
          createInstalledDiscoveredVerifierPackage({
            projectRoot: localVerifiers.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else if (item.kind === "tool-package") {
        tools.push(
          createInstalledDiscoveredToolPackage({
            projectRoot: localTools.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else if (item.kind === "workflow-package") {
        workflows.push(
          createInstalledDiscoveredWorkflowPackage({
            projectRoot: localWorkflows.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else {
        policies.push(
          createInstalledDiscoveredPolicyPackage({
            projectRoot: localPolicies.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      }
    }
  }
  agentSkills.sort(compareByName);
  verifiers.sort(compareByName);
  tools.sort(compareByName);
  workflows.sort(compareByName);
  policies.sort(compareByName);
  assertAgentSkillCatalog(agentSkills);
  assertVerifierCatalog(verifiers);
  assertToolCatalog(tools);
  assertWorkflowPackageCatalog(workflows);
  assertPolicyPackageCatalog(policies);
  options.signal?.throwIfAborted();
  return deepFreeze({
    agentSkills: {
      ...localAgentSkills,
      skills: agentSkills,
    },
    verifiers: {
      ...localVerifiers,
      packages: verifiers,
    },
    tools: {
      ...localTools,
      packages: tools,
    },
    workflows: {
      ...localWorkflows,
      packages: workflows,
    },
    policies: {
      ...localPolicies,
      packages: policies,
    },
  });
}

function assertAgentSkillCatalog(skills: readonly DiscoveredAgentSkill[]): void {
  if (skills.length > MAX_AGENT_SKILL_PACKAGES) {
    throw new AgentSkillCatalogError(
      "limit_exceeded",
      `combined Agent Skills catalog exceeds ${MAX_AGENT_SKILL_PACKAGES} packages`,
    );
  }
  for (let index = 1; index < skills.length; index += 1) {
    const current = skills[index];
    const previous = skills[index - 1];
    if (current !== undefined && previous !== undefined && current.name === previous.name) {
      throw new AgentSkillCatalogError(
        "duplicate_skill",
        `duplicate Agent Skill name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
  }
}

function assertVerifierCatalog(packages: readonly DiscoveredVerifierPackage[]): void {
  if (packages.length > MAX_VERIFIER_PACKAGES) {
    throw new VerifierPackageCatalogError(
      "limit_exceeded",
      `combined verifier package catalog exceeds ${MAX_VERIFIER_PACKAGES} packages`,
    );
  }
  for (let index = 1; index < packages.length; index += 1) {
    const current = packages[index];
    const previous = packages[index - 1];
    if (current !== undefined && previous !== undefined && current.name === previous.name) {
      throw new VerifierPackageCatalogError(
        "duplicate_package",
        `duplicate verifier package name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
  }
}

function assertToolCatalog(packages: readonly DiscoveredToolPackage[]): void {
  if (packages.length > MAX_TOOL_PACKAGES) {
    throw new ToolPackageCatalogError(
      "limit_exceeded",
      `combined tool package catalog exceeds ${MAX_TOOL_PACKAGES} packages`,
    );
  }
  const toolNames = new Map<string, DiscoveredToolPackage>();
  for (let index = 0; index < packages.length; index += 1) {
    const current = packages[index];
    const previous = packages[index - 1];
    if (current === undefined) {
      continue;
    }
    if (previous !== undefined && current.name === previous.name) {
      throw new ToolPackageCatalogError(
        "duplicate_package",
        `duplicate tool package name "${current.name}" at "${previous.provenance}" and "${current.provenance}"`,
      );
    }
    const providerCollision = toolNames.get(current.toolName);
    if (providerCollision !== undefined) {
      throw new ToolPackageCatalogError(
        "duplicate_package",
        `provider-facing tool name "${current.toolName}" is duplicated by "${providerCollision.provenance}" and "${current.provenance}"`,
      );
    }
    toolNames.set(current.toolName, current);
  }
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}
