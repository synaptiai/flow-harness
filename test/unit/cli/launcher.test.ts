import { describe, expect, it, vi } from "vitest";

import { runFlowLauncher } from "../../../src/cli/launcher.js";

describe("Flow package launcher", () => {
  it.each([
    ["linux", "26.7.0"],
    ["darwin", "26.7.0"],
    ["linux", "26.7.1"],
    ["darwin", "27.0.0"],
  ])("loads the CLI on supported %s Node.js %s hosts", async (platform, nodeVersion) => {
    const runDirectCli = vi.fn(async () => undefined);
    const loadCli = vi.fn(async () => ({ runDirectCli }));
    const stderr = vi.fn();
    const setExitCode = vi.fn();

    await runFlowLauncher(["--help"], {
      platform,
      nodeVersion,
      loadCli,
      stderr,
      setExitCode,
    });

    expect(loadCli).toHaveBeenCalledOnce();
    expect(runDirectCli).toHaveBeenCalledWith(["--help"]);
    expect(stderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it.each([
    ["linux", "26.6.99"],
    ["darwin", "25.99.99"],
    ["linux", "26.7.0-private"],
    ["linux", "PRIVATE_VERSION"],
  ])("rejects unsupported Node.js on %s without loading the CLI", async (platform, nodeVersion) => {
    const loadCli = vi.fn();
    const stderr = vi.fn();
    const setExitCode = vi.fn();

    await runFlowLauncher([], { platform, nodeVersion, loadCli, stderr, setExitCode });

    expect(loadCli).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("Flow requires Node.js 26.7.0 or newer.");
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(nodeVersion);
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it.each(["win32", "freebsd", "PRIVATE_PLATFORM"])(
    "rejects unsupported platform %s without loading the CLI",
    async (platform) => {
      const loadCli = vi.fn();
      const stderr = vi.fn();
      const setExitCode = vi.fn();

      await runFlowLauncher([], {
        platform,
        nodeVersion: "26.7.0",
        loadCli,
        stderr,
        setExitCode,
      });

      expect(loadCli).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith("Flow supports Linux and macOS.");
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(platform);
      expect(setExitCode).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    {
      label: "project on an old Node.js version",
      args: ["doctor"],
      platform: "linux",
      nodeVersion: "26.6.99",
      target: "project",
    },
    {
      label: "workflow on an unsupported platform",
      args: ["doctor", "PRIVATE_WORKFLOW_PATH"],
      platform: "freebsd",
      nodeVersion: "26.7.0",
      target: "workflow",
    },
    {
      label: "Prime on an unsupported platform",
      args: ["doctor", "--profile=prime-agent"],
      platform: "freebsd",
      nodeVersion: "26.7.0",
      target: "prime-agent",
    },
  ])("returns a fixed host report for $label without loading the CLI", async (fixture) => {
    const loadCli = vi.fn();
    const stdout = vi.fn();
    const stderr = vi.fn();
    const setExitCode = vi.fn();

    await runFlowLauncher(fixture.args, {
      platform: fixture.platform,
      nodeVersion: fixture.nodeVersion,
      loadCli,
      stdout,
      stderr,
      setExitCode,
    });

    expect(loadCli).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    const publishedReport = stdout.mock.calls[0]?.[0];
    if (publishedReport === undefined) {
      throw new Error("expected a host diagnostic report");
    }
    const report = JSON.parse(publishedReport);
    expect(report).toMatchObject({ version: 1, ok: false, target: fixture.target });
    expect(report.checks[0]).toEqual({
      category: "runtime.host",
      status: "fail",
      message: "The Flow host runtime is unsupported.",
      remediation: "Use a supported operating system and Node.js version, then rerun flow doctor.",
    });
    expect(
      report.checks.slice(1).every((check: { status: string }) => check.status === "skip"),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
