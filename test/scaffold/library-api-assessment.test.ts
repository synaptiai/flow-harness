import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const rootUrl = new URL("../../", import.meta.url);

describe("library API assessment", () => {
  it("reproduces the documented internal export and static-reachability evidence", async () => {
    const { stdout, stderr } = await execute(
      process.execPath,
      [new URL("scripts/analyze-library-boundary.mjs", rootUrl).pathname],
      { cwd: rootUrl, encoding: "utf8", timeout: 10_000 },
    );

    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      version: "flow.library-boundary-analysis/v1",
      productionFiles: 370,
      exportedDeclarations: {
        total: 3_369,
        application: 549,
        cli: 24,
        domain: 1_593,
        infrastructure: 1_081,
        supervisor: 122,
      },
      documentedCliForms: 93,
      directJsonStdoutSites: 97,
      candidates: [
        {
          id: "workflow-compiler",
          entry: "src/domain/workflow/compiler.ts",
          reachableModules: 19,
          layers: ["domain"],
        },
        {
          id: "run-event-parser-reducer",
          entry: "src/domain/run/events.ts",
          reachableModules: 70,
          layers: ["domain"],
        },
        {
          id: "workflow-runner",
          entry: "src/application/run-workflow.ts",
          reachableModules: 77,
          layers: ["application", "domain"],
        },
        {
          id: "local-run-store",
          entry: "src/infrastructure/fs/jsonl-run-store.ts",
          reachableModules: 74,
          layers: ["application", "domain", "infrastructure"],
        },
        {
          id: "supervisor-service",
          entry: "src/supervisor/service.ts",
          reachableModules: 86,
          layers: ["application", "domain", "infrastructure", "supervisor"],
        },
        {
          id: "cli-composition-root",
          entry: "src/cli/main.ts",
          reachableModules: 338,
          layers: ["application", "cli", "domain", "infrastructure", "supervisor"],
        },
      ],
    });
  }, 15_000);
});
