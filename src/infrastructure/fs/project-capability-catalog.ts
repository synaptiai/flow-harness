import { join } from "node:path";

import { MAX_AGENT_SKILL_PACKAGES } from "../../domain/capability/agent-skills.js";
import {
  AgentSkillCatalogError,
  createInstalledDiscoveredAgentSkill,
  type DiscoveredAgentSkill,
  discoverProjectAgentSkills,
  type ProjectAgentSkillCatalog,
} from "./local-agent-skill-catalog.js";
import {
  type CapabilityPackageStoreHooks,
  LocalCapabilityPackageStore,
} from "./local-capability-package-store.js";
import {
  assertPolicyPackageCatalog,
  createInstalledDiscoveredPolicyPackage,
  discoverProjectPolicyPackages,
  type ProjectPolicyPackageCatalog,
} from "./local-policy-package-catalog.js";
import {
  assertPresentationPackageCatalog,
  createInstalledDiscoveredPresentationPackage,
  type DiscoveredPresentationPackage,
  discoverProjectPresentationPackages,
  type ProjectPresentationPackageCatalog,
} from "./local-presentation-package-catalog.js";
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
  readonly presentations: ProjectPresentationPackageCatalog;
}

export interface ProjectCapabilityCatalogOptions {
  /** @internal Test seam for cancellation at installed-bundle verification boundaries. */
  readonly capabilityPackageStoreHooks?: CapabilityPackageStoreHooks;
  readonly includeNonPolicies?: boolean;
  readonly includePolicies?: boolean;
  readonly includePresentations?: boolean;
  readonly signal?: AbortSignal;
}

export async function discoverProjectCapabilityCatalogs(
  projectRoot: string,
  options: ProjectCapabilityCatalogOptions = {},
): Promise<ProjectCapabilityCatalogs> {
  options.signal?.throwIfAborted();
  const includeNonPolicies = options.includeNonPolicies !== false;
  const includePolicies = options.includePolicies !== false;
  const includePresentations = options.includePresentations === true;
  const [
    localAgentSkills,
    localVerifiers,
    localTools,
    localWorkflows,
    localPolicies,
    localPresentations,
    installedBundles,
  ] = await Promise.all([
    includeNonPolicies ? discoverProjectAgentSkills(projectRoot) : Promise.resolve(undefined),
    includeNonPolicies ? discoverProjectVerifierPackages(projectRoot) : Promise.resolve(undefined),
    includeNonPolicies ? discoverProjectToolPackages(projectRoot) : Promise.resolve(undefined),
    includeNonPolicies ? discoverProjectWorkflowPackages(projectRoot) : Promise.resolve(undefined),
    includePolicies
      ? discoverProjectPolicyPackages(projectRoot, options)
      : Promise.resolve(undefined),
    includePresentations
      ? discoverProjectPresentationPackages(projectRoot, options)
      : Promise.resolve(undefined),
    new LocalCapabilityPackageStore(projectRoot, options.capabilityPackageStoreHooks).verify(
      options.signal === undefined ? {} : { signal: options.signal },
    ),
  ]);
  options.signal?.throwIfAborted();
  const catalogProjectRoot =
    localAgentSkills?.projectRoot ?? localPolicies?.projectRoot ?? localPresentations?.projectRoot;
  if (catalogProjectRoot === undefined) {
    throw new Error("capability catalog discovery must include at least one capability family");
  }
  const resolvedLocalAgentSkills: ProjectAgentSkillCatalog =
    localAgentSkills ??
    deepFreeze({
      projectRoot: catalogProjectRoot,
      root: join(catalogProjectRoot, ".flow", "skills"),
      skills: [],
    });
  const resolvedLocalVerifiers: ProjectVerifierPackageCatalog =
    localVerifiers ??
    deepFreeze({
      projectRoot: catalogProjectRoot,
      root: join(catalogProjectRoot, ".flow", "verifiers"),
      packages: [],
    });
  const resolvedLocalTools: ProjectToolPackageCatalog =
    localTools ??
    deepFreeze({
      projectRoot: catalogProjectRoot,
      root: join(catalogProjectRoot, ".flow", "tools"),
      packages: [],
    });
  const resolvedLocalWorkflows: ProjectWorkflowPackageCatalog =
    localWorkflows ??
    deepFreeze({
      projectRoot: catalogProjectRoot,
      root: join(catalogProjectRoot, ".flow", "workflows"),
      packages: [],
    });
  const resolvedLocalPolicies: ProjectPolicyPackageCatalog =
    localPolicies ??
    deepFreeze({
      projectRoot: catalogProjectRoot,
      root: join(catalogProjectRoot, ".flow", "policies"),
      packages: [],
    });
  const resolvedLocalPresentations: ProjectPresentationPackageCatalog =
    localPresentations ??
    deepFreeze({
      projectRoot: catalogProjectRoot,
      root: join(catalogProjectRoot, ".flow", "presentations"),
      packages: [],
    });
  const agentSkills = [...resolvedLocalAgentSkills.skills];
  const verifiers = [...resolvedLocalVerifiers.packages];
  const tools = [...resolvedLocalTools.packages];
  const workflows = [...resolvedLocalWorkflows.packages];
  const policies = [...resolvedLocalPolicies.packages];
  const presentations: DiscoveredPresentationPackage[] = [...resolvedLocalPresentations.packages];
  for (const installed of installedBundles) {
    options.signal?.throwIfAborted();
    for (const item of installed.bundle.packages) {
      if (includeNonPolicies && item.kind === "agent-skill") {
        agentSkills.push(
          createInstalledDiscoveredAgentSkill({
            projectRoot: resolvedLocalAgentSkills.projectRoot,
            bundleDigest: installed.entry.digest,
            skill: item,
          }),
        );
      } else if (includeNonPolicies && item.kind === "verifier-package") {
        verifiers.push(
          createInstalledDiscoveredVerifierPackage({
            projectRoot: resolvedLocalVerifiers.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else if (includeNonPolicies && item.kind === "tool-package") {
        tools.push(
          createInstalledDiscoveredToolPackage({
            projectRoot: resolvedLocalTools.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else if (includeNonPolicies && item.kind === "workflow-package") {
        workflows.push(
          createInstalledDiscoveredWorkflowPackage({
            projectRoot: resolvedLocalWorkflows.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else if (includePolicies && item.kind === "policy-package") {
        policies.push(
          createInstalledDiscoveredPolicyPackage({
            projectRoot: resolvedLocalPolicies.projectRoot,
            bundleDigest: installed.entry.digest,
            package: item,
          }),
        );
      } else if (includePresentations && item.kind === "presentation-package") {
        presentations.push(
          createInstalledDiscoveredPresentationPackage({
            projectRoot: resolvedLocalPresentations.projectRoot,
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
  presentations.sort(compareByName);
  if (includeNonPolicies) {
    assertAgentSkillCatalog(agentSkills);
    assertVerifierCatalog(verifiers);
    assertToolCatalog(tools);
    assertWorkflowPackageCatalog(workflows);
  }
  if (includePolicies) {
    assertPolicyPackageCatalog(policies);
  }
  if (includePresentations) {
    assertPresentationPackageCatalog(presentations);
  }
  options.signal?.throwIfAborted();
  return deepFreeze({
    agentSkills: {
      ...resolvedLocalAgentSkills,
      skills: agentSkills,
    },
    verifiers: {
      ...resolvedLocalVerifiers,
      packages: verifiers,
    },
    tools: {
      ...resolvedLocalTools,
      packages: tools,
    },
    workflows: {
      ...resolvedLocalWorkflows,
      packages: workflows,
    },
    policies: {
      ...resolvedLocalPolicies,
      packages: policies,
    },
    presentations: {
      ...resolvedLocalPresentations,
      packages: presentations,
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
