import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/main.js";

describe("flow CLI", () => {
  it("prints help without requiring provider configuration", () => {
    const output: string[] = [];

    const exitCode = main(["--help"], (text) => output.push(text));

    expect(exitCode).toBe(0);
    expect(output.join("\n")).toContain("Provider-neutral harness");
    expect(output.join("\n")).toContain("flow --help");
  });

  it("rejects unknown commands with a usage error", () => {
    const output: string[] = [];

    const exitCode = main(["unknown"], (text) => output.push(text));

    expect(exitCode).toBe(2);
    expect(output.join("\n")).toContain('Unknown command "unknown"');
  });
});
