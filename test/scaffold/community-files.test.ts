import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const rootUrl = new URL("../../", import.meta.url);

describe("public repository contracts", () => {
  it("documents an honest source-based pre-alpha first run", async () => {
    const readme = await readText("README.md");

    expect(readme).toMatch(/pre-alpha/i);
    expect(readme).toMatch(/not published to npm/i);
    expect(readme).toContain("git clone https://github.com/synaptiai/flow-harness.git");
    expect(readme).toContain("npm ci --ignore-scripts");
    expect(readme).toContain("bubblewrap");
    expect(readme).toContain("node dist/cli/main.js run");
    expect(readme).toContain("[Contributing](CONTRIBUTING.md)");
    expect(readme).toContain("[Support](SUPPORT.md)");
    expect(readme).toContain("[Security](SECURITY.md)");
  });

  it("documents and configures the Ubuntu 24.04 sandbox prerequisite", async () => {
    const [readme, workflow] = await Promise.all([
      readText("README.md"),
      readText(".github/workflows/ci.yml"),
    ]);
    const appArmorSetting = "kernel.apparmor_restrict_unprivileged_userns=0";

    expect(readme).toContain(appArmorSetting);
    expect(workflow).toContain(`sudo sysctl -w ${appArmorSetting}`);
  });

  it("scopes CI to one validation path per pull request while retaining main and manual runs", async () => {
    const workflow = parse(await readText(".github/workflows/ci.yml")) as WorkflowDefinition;

    expect(workflow.on.pull_request).toBeDefined();
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(Object.keys(workflow.jobs).sort()).toEqual(["dependency-audit", "quality"]);
  });

  it("routes support, conduct, and vulnerability reports to distinct channels", async () => {
    const [support, conduct, security] = await Promise.all([
      readText("SUPPORT.md"),
      readText("CODE_OF_CONDUCT.md"),
      readText("SECURITY.md"),
    ]);

    expect(support).toContain("support@synapti.ai");
    expect(support).toContain("/security/advisories/new");
    expect(conduct).toContain("support@synapti.ai");
    expect(security).toContain("/security/advisories/new");
  });

  it.each([
    ["bug", ".github/ISSUE_TEMPLATE/bug.yml", ["reproduction", "expected", "security"]],
    ["capability", ".github/ISSUE_TEMPLATE/capability.yml", ["outcome", "evidence", "security"]],
  ])("provides a structured %s issue form", async (_kind, path, requiredIds) => {
    const form = parse(await readText(path)) as IssueForm;

    expect(form.name).toEqual(expect.any(String));
    expect(form.description).toEqual(expect.any(String));
    expect(form.body.map((field) => field.id)).toEqual(expect.arrayContaining(requiredIds));
    for (const id of requiredIds) {
      expect(form.body.find((field) => field.id === id)?.validations?.required).toBe(true);
    }
  });

  it("disables unstructured issues and redirects private security reports", async () => {
    const config = parse(await readText(".github/ISSUE_TEMPLATE/config.yml")) as IssueConfig;

    expect(config.blank_issues_enabled).toBe(false);
    expect(config.contact_links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "https://github.com/synaptiai/flow-harness/security/advisories/new",
        }),
      ]),
    );
  });

  it("asks pull requests for issue linkage, evidence, boundary impact, and failure modes", async () => {
    const template = await readText(".github/pull_request_template.md");

    for (const heading of [
      "## Linked issue",
      "## Outcome",
      "## Architecture and security boundaries",
      "## Failure modes",
      "## Verification",
      "## Documentation",
    ]) {
      expect(template).toContain(heading);
    }
  });
});

async function readText(path: string): Promise<string> {
  return await readFile(new URL(path, rootUrl), "utf8");
}

interface IssueForm {
  readonly name?: string;
  readonly description?: string;
  readonly body: Array<{
    readonly id?: string;
    readonly validations?: { readonly required?: boolean };
  }>;
}

interface IssueConfig {
  readonly blank_issues_enabled?: boolean;
  readonly contact_links?: ReadonlyArray<{ readonly url?: string }>;
}

interface WorkflowDefinition {
  readonly on: {
    readonly pull_request?: unknown;
    readonly push?: { readonly branches?: readonly string[] };
    readonly workflow_dispatch?: unknown;
  };
  readonly jobs: Readonly<Record<string, unknown>>;
}
