import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const rootUrl = new URL("../../", import.meta.url);

describe("preview npm stage workflow", () => {
  it("verifies the immutable release before requesting staged-publication authority", async () => {
    const workflow = await readWorkflow();

    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          release_tag: {
            description: "Immutable Flow preview tag to stage on npm",
            required: true,
            type: "string",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.verify.environment).toBeUndefined();
    expect(workflow.jobs.verify.permissions).toEqual({
      attestations: "read",
      contents: "read",
    });
    expect(workflow.jobs.verify.steps.map(stepName)).toEqual([
      "Require a default-branch dispatch",
      "Check out the default-branch verifier",
      "Check out the immutable release tag",
      "Set up Node.js",
      "Require the staged-publication toolchain",
      "Resolve the manifest-derived identity",
      "Read and validate the immutable release",
      "Download the exact release assets",
      "Verify the release and asset identity",
      "Verify the release provenance",
      "Install Ubuntu sandbox prerequisites",
      "Install exact dependencies",
      "Build the release verifier",
      "Verify the installed release package",
      "Require the current npm channel policy",
      "Require an unused npm version",
    ]);

    const source = await readText(".github/workflows/preview-npm-stage.yml");
    const verifySource = jobSource(source, "verify", "stage");
    expect(verifySource).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(verifySource).toContain("path: release-source");
    expect(verifySource).toContain("--root release-source");
    expect(verifySource).toContain("git -C release-source rev-parse HEAD");
    expect(verifySource).toContain("gh release verify");
    expect(verifySource).toContain("gh release verify-asset");
    expect(verifySource).toContain("gh attestation verify");
    expect(verifySource).toContain("--signer-workflow");
    expect(verifySource).toContain("--source-digest");
    expect(verifySource).toContain("npm run release:verify");
    expect(verifySource.indexOf("Verify the release provenance")).toBeLessThan(
      verifySource.indexOf("Install exact dependencies"),
    );
    expect(verifySource).not.toContain("cache-dependency-path");
    expect(verifySource).toContain("tags.preview");
    expect(verifySource).toContain("tags.latest");
    expect(verifySource).toContain('error?.code !== "E404"');
    expect(verifySource).not.toContain('npm stage publish "release/package');
  });

  it("stages the same verified bytes without moving a public distribution tag", async () => {
    const workflow = await readWorkflow();
    const stage = workflow.jobs.stage;

    expect(stage.needs).toBe("verify");
    expect(stage.environment).toBe("preview-release");
    expect(stage.permissions).toEqual({
      attestations: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(stage.steps.map(stepName)).toEqual([
      "Set up Node.js",
      "Require the staged-publication toolchain",
      "Download the exact release assets again",
      "Reverify the release and staged archive",
      "Capture the public npm tags",
      "Require the npm version to remain unused",
      "Stage the exact preview archive",
      "Require public npm tags to remain unchanged",
    ]);

    const source = await readText(".github/workflows/preview-npm-stage.yml");
    const stageSource = jobSource(source, "stage", undefined);
    expect(stageSource).toContain("npm stage publish");
    expect(stageSource).toContain("--access public");
    expect(stageSource).toContain(`tag "${shellVariable("NPM_DIST_TAG")}"`);
    expect(stageSource).toContain("--provenance");
    expect(stageSource).toContain("cmp --silent");
    expect(stageSource).not.toContain("npm publish");
    expect(stageSource).not.toContain("npm dist-tag add");
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("NODE_AUTH_TOKEN");
    expect(source).not.toMatch(/0\.1\.0-alpha\.\d+/);
  });

  it("pins every external action and the supported Node.js baseline", async () => {
    const workflow = await readWorkflow();

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
  });
});

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly needs?: string;
  readonly environment?: string;
  readonly permissions?: Record<string, string>;
  readonly steps: readonly WorkflowStep[];
}

interface PreviewNpmStageWorkflow {
  readonly on: unknown;
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, WorkflowJob> & {
    readonly verify: WorkflowJob;
    readonly stage: WorkflowJob;
  };
}

async function readWorkflow(): Promise<PreviewNpmStageWorkflow> {
  return parse(
    await readText(".github/workflows/preview-npm-stage.yml"),
  ) as PreviewNpmStageWorkflow;
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

function shellVariable(name: string): string {
  return `\${${name}}`;
}
