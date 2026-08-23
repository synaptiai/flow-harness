import type {
  PublicCapabilityCatalog,
  PublicCapabilityToolInput,
} from "../domain/capability/public-capability-reference.js";

export interface RenderedPublicCapabilityReference {
  readonly json: string;
  readonly markdown: string;
}

export function renderPublicCapabilityReference(
  catalog: PublicCapabilityCatalog,
): RenderedPublicCapabilityReference {
  return Object.freeze({
    json: `${JSON.stringify(catalog, null, 2)}\n`,
    markdown: renderMarkdown(catalog),
  });
}

function renderMarkdown(catalog: PublicCapabilityCatalog): string {
  const lines = [
    "<!-- Generated file. Do not edit directly. -->",
    "",
    "# Tools and capabilities",
    "",
    "This reference describes the public tools and capability seams registered by Flow production",
    "composition. Regenerate it after you change a registered tool, schema, public limit, capability",
    "family, or provider seam.",
    "",
    "For behavior and security boundaries, read [Architecture](../architecture.md) and",
    "[Use capability packages](../guides/capability-packages.md). For the exact machine-readable",
    "contract, see",
    "[Flow public capability catalog](../specs/flow-public-capability-catalog-v1.json).",
    "",
    `Catalog version: \`${catalog.version}\``,
    "",
    `JSON Schema dialect: \`${catalog.jsonSchemaDialect}\``,
    "",
    "## Built-in model tools",
    "",
    "| Workflow selector | Model-facing name | Authority | Availability |",
    "| --- | --- | --- | --- |",
    ...catalog.tools.map(
      (tool) =>
        `| \`${tool.selector}\` | \`${tool.name}\` | ${tool.authority.join(", ")} | ${tool.availability.length === 0 ? "Always" : tool.availability.join(", ")} |`,
    ),
    "",
  ];

  for (const tool of catalog.tools) {
    lines.push(...renderTool(tool));
  }

  lines.push(
    "## Public limits",
    "",
    "A default is runtime behavior only when the corresponding implementation applies it. JSON",
    "Schema `default` annotations alone don't insert a value.",
    "",
    "| Identifier | Limit | Default | Scope |",
    "| --- | ---: | ---: | --- |",
    ...catalog.limits.map(
      (limit) =>
        `| \`${limit.id}\` | ${limit.value} ${limit.unit} | ${limit.default === undefined ? "—" : `${limit.default} ${limit.unit}`} | ${escapeTable(limit.scope)} |`,
    ),
    "",
    "## Capability-package families",
    "",
    "Flow discovers exact package instances from the current project and installed immutable",
    "bundles. This repository reference describes the supported family contracts. It doesn't list",
    "operator-installed instances.",
    "",
    "| Kind | Name | Extension | Summary |",
    "| --- | --- | --- | --- |",
    ...catalog.capabilityFamilies.map(
      (family) =>
        `| \`${family.kind}\` | ${escapeTable(family.title)} | ${family.extension} | ${escapeTable(family.summary)} |`,
    ),
    "",
    "## Provider and evaluation seams",
    "",
    "### Ordinary model execution",
    "",
    "| Seam | Implementation | Openness | Summary |",
    "| --- | --- | --- | --- |",
    ...catalog.executionSeams.map(
      (seam) =>
        `| \`${seam.id}\` | \`${seam.implementation}\` | ${seam.openness} | ${escapeTable(seam.summary)} |`,
    ),
    "",
    "Provider and model identifiers are runtime inputs. This reference doesn't promise that a",
    "specific provider, model, credential, price, or availability state exists.",
    "",
    "### Evaluation adapters",
    "",
    "| Adapter | Isolation | Summary |",
    "| --- | --- | --- |",
    ...catalog.evaluationAdapters.map(
      (adapter) => `| \`${adapter.id}\` | ${adapter.isolation} | ${escapeTable(adapter.summary)} |`,
    ),
    "",
  );
  return lines.join("\n");
}

function renderTool(tool: PublicCapabilityToolInput): readonly string[] {
  return [
    `### \`${tool.name}\``,
    "",
    tool.description,
    "",
    `- Workflow selector: \`${tool.selector}\``,
    `- Execution mode: \`${tool.executionMode}\``,
    `- Policy actions: ${tool.policyActions.map((item) => `\`${item}\``).join(", ")}`,
    `- Public limits: ${tool.limitIds.length === 0 ? "None" : tool.limitIds.map((item) => `\`${item}\``).join(", ")}`,
    "",
    "Input schema:",
    "",
    "```json",
    JSON.stringify(tool.inputSchema, null, 2),
    "```",
    "",
  ];
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
