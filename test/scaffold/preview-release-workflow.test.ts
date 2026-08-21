import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const rootUrl = new URL("../../", import.meta.url);

describe("preview release workflow", () => {
  it("builds once and verifies the same artifact on supported x64 hosts", async () => {
    const workflow = await readWorkflow();

    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          publish_github: {
            description: "Publish the verified immutable GitHub prerelease",
            required: true,
            default: false,
            type: "boolean",
          },
        },
      },
    });

    expect(workflow.jobs.prepare["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs.prepare.steps.map(stepName)).toEqual([
      "Check out the exact revision",
      "Set up Node.js",
      "Require successful CI for the revision",
      "Install exact dependencies",
      "Run release-focused tests",
      "Prepare the exact preview artifact",
      "Upload the exact preview artifact",
    ]);
    expect(workflow.jobs.prepare.steps.at(-1)).toMatchObject({
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "flow-preview-package",
        path: "release/package/*",
        "if-no-files-found": "error",
        "compression-level": 0,
        overwrite: false,
        "retention-days": 14,
      },
    });

    expect(workflow.jobs.verify.needs).toBe("prepare");
    expect(workflow.jobs.verify.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: ["ubuntu-24.04", "macos-15-intel"] },
    });
    expect(workflow.jobs.verify["runs-on"]).toBe("$" + "{{ matrix.os }}");
    expect(workflow.jobs.verify.steps.map(stepName)).toEqual([
      "Check out the exact revision",
      "Set up Node.js",
      "Install Ubuntu sandbox prerequisites",
      "Install exact dependencies",
      "Build the release verifier",
      "Download the exact preview artifact",
      "Verify the installed preview package",
    ]);
    expect(workflow.jobs.verify.steps[2]).toMatchObject({
      if: "runner.os == 'Linux'",
    });
    expect(workflow.jobs.verify.steps[2]?.run).toContain(
      "sudo apt-get install --yes bubblewrap ca-certificates curl ripgrep socat util-linux",
    );
    expect(workflow.jobs.verify.steps[2]?.run).toContain(
      "sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(workflow.jobs.verify.steps.at(-2)).toMatchObject({
      uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      with: {
        name: "flow-preview-package",
        path: "release/package",
      },
    });
    expect(workflow.jobs.verify.steps.at(-1)?.run).toBe("npm run release:verify");

    const source = await readText(".github/workflows/preview-release.yml");
    const prepareSource = jobSource(source, "prepare", "verify");
    const verifySource = jobSource(source, "verify", "attest");
    expect(count(prepareSource, "npm run release:prepare")).toBe(1);
    expect(verifySource).not.toContain("release:prepare");
    expect(verifySource).not.toContain("npm pack");
  });

  it("attests only after both hosts pass and publishes through a protected environment", async () => {
    const workflow = await readWorkflow();

    expect(workflow.jobs.attest.needs).toEqual(["prepare", "verify"]);
    expect(workflow.jobs.attest.permissions).toEqual({
      contents: "read",
      "id-token": "write",
      attestations: "write",
      "artifact-metadata": "write",
    });
    expect(workflow.jobs.attest.steps.map(stepName)).toEqual([
      "Download the exact preview artifact",
      "Attest the preview archive and evidence",
      "Name the attestation bundle",
      "Upload the attestation bundle",
    ]);
    expect(workflow.jobs.attest.steps[1]).toMatchObject({
      id: "provenance",
      uses: "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
      with: { "subject-path": "release/package/*" },
    });

    expect(workflow.jobs.publish.needs).toEqual(["prepare", "verify", "attest"]);
    expect(workflow.jobs.publish.if).toContain("inputs.publish_github");
    expect(workflow.jobs.publish.environment).toBe("preview-release");
    expect(workflow.jobs.publish.permissions).toEqual({ contents: "write" });
    expect(workflow.jobs.publish.steps.map(stepName)).toEqual([
      "Check out the exact revision",
      "Download the exact preview artifact",
      "Download the attestation bundle",
      "Require immutable releases",
      "Require an unused release identity",
      "Create the complete draft prerelease",
      "Publish the immutable prerelease",
    ]);

    const source = await readText(".github/workflows/preview-release.yml");
    const publishSource = jobSource(source, "publish", undefined);
    expect(publishSource).toContain("--draft");
    expect(publishSource).toContain("--prerelease");
    expect(publishSource).toContain("--latest=false");
    expect(publishSource).toContain("--draft=false");
    expect(publishSource).toContain("release/package/package-release-evidence.json");
    expect(publishSource).not.toContain("release/package/package-release.json");
    expect(publishSource).not.toContain("--clobber");
    expect(publishSource).not.toContain("npm publish");
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("NODE_AUTH_TOKEN");
    expect(source).not.toContain("id-token: read");
  });

  it("pins every external action and the public Node.js baseline", async () => {
    const workflow = await readWorkflow();
    const source = await readText(".github/workflows/preview-release.yml");

    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses !== undefined) {
          expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
        }
        if (step.uses?.startsWith("actions/setup-node@")) {
          expect(step.with?.["node-version"]).toBe("26.7.0");
        }
      }
    }

    expect(source).toContain("refs/heads/main");
    expect(source).toContain("0.1.0-alpha.1");
    expect(source).toContain("v0.1.0-alpha.1");
  });
});

type WorkflowStep = {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
};

type WorkflowJob = {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly environment?: string;
  readonly permissions?: Record<string, string>;
  readonly strategy?: unknown;
  readonly "runs-on"?: string;
  readonly steps: readonly WorkflowStep[];
};

type PreviewReleaseWorkflow = {
  readonly on: unknown;
  readonly jobs: Record<string, WorkflowJob> & {
    readonly prepare: WorkflowJob;
    readonly verify: WorkflowJob;
    readonly attest: WorkflowJob;
    readonly publish: WorkflowJob;
  };
};

async function readWorkflow(): Promise<PreviewReleaseWorkflow> {
  return parse(await readText(".github/workflows/preview-release.yml")) as PreviewReleaseWorkflow;
}

async function readText(path: string): Promise<string> {
  return readFile(new URL(path, rootUrl), "utf8");
}

function stepName(step: WorkflowStep): string | undefined {
  return step.name;
}

function jobSource(source: string, job: string, nextJob: string | undefined): string {
  const start = source.indexOf(`  ${job}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextJob === undefined ? source.length : source.indexOf(`  ${nextJob}:\n`, start + 1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function count(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}
