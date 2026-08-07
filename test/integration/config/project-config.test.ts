import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FLOW_CONFIG_API_VERSION, FlowConfigError } from "../../../src/domain/config/resolver.js";
import {
  FlowConfigStoreError,
  initializeFlowProject,
  loadEffectiveFlowConfig,
  resolveOperatorConfigPath,
} from "../../../src/infrastructure/fs/flow-config-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Flow project configuration", () => {
  it("initializes a minimal project atomically and refuses an implicit overwrite", async () => {
    const project = await temporaryDirectory("flow-config-project-");
    const initialized = await initializeFlowProject(project);

    expect(initialized).toEqual({
      created: true,
      projectRoot: project,
      path: join(project, ".flow", "config.yaml"),
    });
    expect(await readFile(initialized.path, "utf8")).toBe(
      `apiVersion: ${FLOW_CONFIG_API_VERSION}\nkind: FlowProjectConfig\n`,
    );
    expect((await lstat(initialized.path)).isFile()).toBe(true);

    await expect(initializeFlowProject(project)).rejects.toMatchObject({
      name: "FlowConfigStoreError",
      code: "already_exists",
    });
  });

  it("replaces only an existing regular config when explicitly requested", async () => {
    const project = await temporaryDirectory("flow-config-replace-");
    await mkdir(join(project, ".flow"));
    const configPath = join(project, ".flow", "config.yaml");
    await writeFile(configPath, "invalid: true\n", "utf8");

    await expect(initializeFlowProject(project, { replace: true })).resolves.toMatchObject({
      created: false,
      path: configPath,
    });
    expect(await readFile(configPath, "utf8")).toContain("kind: FlowProjectConfig");

    const symlinkProject = await temporaryDirectory("flow-config-symlink-");
    const outside = join(symlinkProject, "outside.yaml");
    await writeFile(outside, "do-not-touch\n", "utf8");
    await mkdir(join(symlinkProject, ".flow"));
    await symlink(outside, join(symlinkProject, ".flow", "config.yaml"));

    await expect(initializeFlowProject(symlinkProject, { replace: true })).rejects.toMatchObject({
      code: "unsafe_target",
    });
    expect(await readFile(outside, "utf8")).toBe("do-not-touch\n");
  });

  it("discovers the nearest project root from a subdirectory and merges operator limits", async () => {
    const project = await temporaryDirectory("flow-config-discovery-");
    const xdg = await temporaryDirectory("flow-config-xdg-");
    const nested = join(project, "packages", "app", "src");
    await mkdir(nested, { recursive: true });
    await mkdir(join(project, ".flow"));
    await writeFile(
      join(project, ".flow", "config.yaml"),
      `${projectConfigHeader()}supervisor:\n  maxActiveWorkers: 2\n  maxQueuedJobs: 7\n`,
      "utf8",
    );
    await mkdir(join(xdg, "flow"));
    await writeFile(
      join(xdg, "flow", "config.yaml"),
      `${operatorConfigHeader()}supervisor:\n  maxActiveWorkers: 4\n  maxQueuedJobs: 9\n`,
      "utf8",
    );

    const effective = await loadEffectiveFlowConfig({
      cwd: nested,
      xdgConfigHome: xdg,
      homeDirectory: join(project, "unused-home"),
    });

    expect(effective).toMatchObject({
      projectRoot: project,
      supervisor: { maxActiveWorkers: 2, maxQueuedJobs: 7 },
      sources: {
        operator: { path: join(xdg, "flow", "config.yaml") },
        project: { path: join(project, ".flow", "config.yaml") },
      },
    });
  });

  it("selects a nested Flow project instead of its ancestor", async () => {
    const root = await temporaryDirectory("flow-config-nested-");
    const nested = join(root, "packages", "child");
    await mkdir(join(root, ".flow"));
    await writeFile(join(root, ".flow", "config.yaml"), projectConfigHeader(), "utf8");
    await mkdir(join(nested, ".flow"), { recursive: true });
    await writeFile(join(nested, ".flow", "config.yaml"), projectConfigHeader(), "utf8");
    await mkdir(join(nested, "src"));

    const effective = await loadEffectiveFlowConfig({
      cwd: join(nested, "src"),
      xdgConfigHome: join(root, "missing-xdg"),
      homeDirectory: join(root, "missing-home"),
    });

    expect(effective.projectRoot).toBe(nested);
  });

  it("reports YAML and schema source paths before creating runtime state", async () => {
    const project = await temporaryDirectory("flow-config-invalid-");
    await mkdir(join(project, ".flow"));
    const configPath = join(project, ".flow", "config.yaml");
    await writeFile(configPath, `${projectConfigHeader()}supervisor: [\n`, "utf8");

    await expect(
      loadEffectiveFlowConfig({
        cwd: project,
        xdgConfigHome: join(project, "missing-xdg"),
        homeDirectory: join(project, "missing-home"),
      }),
    ).rejects.toMatchObject({
      name: "FlowConfigError",
      code: "invalid_config",
      sourcePath: configPath,
      fieldPath: "<yaml>",
    });
    await expect(lstat(join(project, ".flow", "runs"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(configPath, `${projectConfigHeader()}unknown: true\n`, "utf8");
    await expect(
      loadEffectiveFlowConfig({
        cwd: project,
        xdgConfigHome: join(project, "missing-xdg"),
        homeDirectory: join(project, "missing-home"),
      }),
    ).rejects.toBeInstanceOf(FlowConfigError);
  });

  it("falls back from a relative XDG path and returns built-ins without config files", async () => {
    const project = await temporaryDirectory("flow-config-defaults-");
    const home = join(project, "home");

    expect(resolveOperatorConfigPath({ xdgConfigHome: "relative", homeDirectory: home })).toBe(
      join(home, ".config", "flow", "config.yaml"),
    );
    await expect(
      loadEffectiveFlowConfig({ cwd: project, xdgConfigHome: "relative", homeDirectory: home }),
    ).resolves.toMatchObject({
      projectRoot: null,
      supervisor: { maxActiveWorkers: 1, maxQueuedJobs: 32 },
      sources: { operator: null, project: null },
    });
  });

  it("loads the production operator location from an injected XDG environment", async () => {
    const project = await temporaryDirectory("flow-config-environment-");
    const xdg = await temporaryDirectory("flow-config-environment-xdg-");
    await mkdir(join(xdg, "flow"));
    await writeFile(
      join(xdg, "flow", "config.yaml"),
      `${operatorConfigHeader()}supervisor:\n  maxActiveWorkers: 3\n`,
      "utf8",
    );

    await expect(
      loadEffectiveFlowConfig({
        cwd: project,
        environment: {
          XDG_CONFIG_HOME: xdg,
          HOME: join(project, "unused-home"),
        },
      }),
    ).resolves.toMatchObject({
      supervisor: { maxActiveWorkers: 3, maxQueuedJobs: 32 },
      sources: { operator: { path: join(xdg, "flow", "config.yaml") } },
    });
  });

  it("rejects an unsafe .flow directory instead of following it", async () => {
    const project = await temporaryDirectory("flow-config-flow-link-");
    const target = await temporaryDirectory("flow-config-flow-link-target-");
    await symlink(target, join(project, ".flow"));

    await expect(initializeFlowProject(project)).rejects.toBeInstanceOf(FlowConfigStoreError);
    await expect(initializeFlowProject(project)).rejects.toMatchObject({ code: "unsafe_target" });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function projectConfigHeader(): string {
  return `apiVersion: ${FLOW_CONFIG_API_VERSION}\nkind: FlowProjectConfig\n`;
}

function operatorConfigHeader(): string {
  return `apiVersion: ${FLOW_CONFIG_API_VERSION}\nkind: FlowOperatorConfig\n`;
}
