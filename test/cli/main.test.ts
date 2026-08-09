import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  armForcedExit,
  createEvaluationEnvironment,
  isDirectEntry,
  main,
  resolveDirectExitCode,
} from "../../src/cli/main.js";
import { resolveFlowConfig } from "../../src/domain/config/resolver.js";

describe("flow CLI", () => {
  it("captures supported evaluation environments from installed package metadata", async () => {
    const packageMetadata = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly version: string };

    expect(
      createEvaluationEnvironment({
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
      }),
    ).toEqual({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "v22.19.0",
      flowVersion: packageMetadata.version,
    });
    expect(() =>
      createEvaluationEnvironment({
        platform: "freebsd",
        architecture: "x64",
        nodeVersion: "v22.19.0",
      }),
    ).toThrow(/unsupported.*platform|platform.*unsupported/i);
  });

  it("prints resume help without requiring provider configuration", async () => {
    const output: string[] = [];

    const exitCode = await main(["--help"], {
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("Provider-neutral coding-agent harness");
    expect(output.join("\n")).toContain("flow validate");
    expect(output.join("\n")).toContain("flow init");
    expect(output.join("\n")).toContain("flow config show");
    expect(output.join("\n")).toContain("flow eval validate");
    expect(output.join("\n")).toContain("flow eval run");
    expect(output.join("\n")).toContain("flow eval inspect");
    expect(output.join("\n")).toContain("flow eval export");
    expect(output.join("\n")).toContain("flow run");
    expect(output.join("\n")).toContain("flow resume");
    expect(output.join("\n")).toContain("flow inspect");
    expect(output.join("\n")).toContain("flow cancel");
    expect(output.join("\n")).toContain("flow events");
    expect(output.join("\n")).toContain("flow supervisor status");
    expect(output.join("\n")).not.toContain("__worker");
  });

  it("initializes an explicit directory with replacement only when requested", async () => {
    const output: string[] = [];
    const calls: Array<{ directory: string; replace: boolean | undefined }> = [];

    const exitCode = await main(
      ["init", "project", "--force"],
      {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      },
      {
        cwd: "/workspace",
        initializeProject: async (directory, options) => {
          calls.push({ directory, replace: options?.replace });
          return {
            created: false,
            projectRoot: directory,
            path: `${directory}/.flow/config.yaml`,
          };
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ directory: "/workspace/project", replace: true }]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      created: false,
      projectRoot: "/workspace/project",
    });
  });

  it("shows effective configuration without starting a supervisor", async () => {
    const output: string[] = [];
    let loadedFrom: string | undefined;

    const exitCode = await main(
      ["config", "show"],
      {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      },
      {
        cwd: "/workspace/project",
        loadConfig: async (options) => {
          loadedFrom = options?.cwd;
          return resolveFlowConfig({ projectRoot: "/workspace/project" });
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(loadedFrom).toBe("/workspace/project");
    expect(JSON.parse(output.join("\n"))).toMatchObject({
      projectRoot: "/workspace/project",
      supervisor: { maxActiveWorkers: 1, maxQueuedJobs: 32 },
    });
  });

  it("resolves inspect storage from the discovered project root", async () => {
    const output: string[] = [];
    let runsDirectory: string | undefined;

    const exitCode = await main(
      ["inspect", "run-1"],
      {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      },
      {
        cwd: "/workspace/project/packages/worker",
        loadConfig: async () => resolveFlowConfig({ projectRoot: "/workspace/project" }),
        createStore: (rootDirectory) => {
          runsDirectory = rootDirectory;
          throw new Error("stop after resolving storage");
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(runsDirectory).toBe("/workspace/project/.flow/runs");
    expect(output.join("\n")).toContain("stop after resolving storage");
  });

  it("requires an explicit run id for resume", async () => {
    const output: string[] = [];

    const exitCode = await main(
      ["resume", "workflow.yaml"],
      {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      },
      {
        readTextFile: async () => {
          throw new Error("workflow must not be read before usage is valid");
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain("resume requires --run-id <id>");
  });

  it("rejects unknown commands with a usage error", async () => {
    const output: string[] = [];

    const exitCode = await main(["unknown"], {
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain('Unknown command "unknown"');
  });

  it("recognizes an npm-style symlink as the executable entrypoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flow-cli-entry-"));
    const target = join(directory, "main.js");
    const linkedBinary = join(directory, "flow");
    try {
      await writeFile(target, "", "utf8");
      await symlink(target, linkedBinary);

      expect(isDirectEntry(linkedBinary, pathToFileURL(target).href)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("lets a durably committed success win a late signal exit request", () => {
    expect(resolveDirectExitCode(0, 130)).toBe(0);
    expect(resolveDirectExitCode(1, 130)).toBe(130);
    expect(resolveDirectExitCode(1, undefined)).toBe(1);
  });

  it("arms an unreferenced forced-exit guard for leaked provider handles", () => {
    let code: number | undefined;
    const timer = armForcedExit(7, 60_000, (exitCode) => {
      code = exitCode;
      throw new Error("not reached by this test");
    });
    try {
      expect(timer.hasRef()).toBe(false);
      expect(code).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  });
});
