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
      productionFiles: 320,
      exportedDeclarations: {
        total: 2_938,
        application: 398,
        cli: 17,
        domain: 1_460,
        infrastructure: 941,
        supervisor: 122,
      },
      documentedCliForms: 92,
      directJsonStdoutSites: 97,
      candidates: [
        {
          id: "workflow-compiler",
          entry: "src/domain/workflow/compiler.ts",
          reachableModules: 16,
          layers: ["domain"],
        },
        {
          id: "run-event-parser-reducer",
          entry: "src/domain/run/events.ts",
          reachableModules: 67,
          layers: ["domain"],
        },
        {
          id: "workflow-runner",
          entry: "src/application/run-workflow.ts",
          reachableModules: 75,
          layers: ["application", "domain"],
        },
        {
          id: "local-run-store",
          entry: "src/infrastructure/fs/jsonl-run-store.ts",
          reachableModules: 72,
          layers: ["application", "domain", "infrastructure"],
        },
        {
          id: "supervisor-service",
          entry: "src/supervisor/service.ts",
          reachableModules: 84,
          layers: ["application", "domain", "infrastructure", "supervisor"],
        },
        {
          id: "cli-composition-root",
          entry: "src/cli/main.ts",
          reachableModules: 289,
          layers: ["application", "cli", "domain", "infrastructure", "supervisor"],
        },
      ],
    });
  }, 15_000);
});
