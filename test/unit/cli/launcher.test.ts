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
});
