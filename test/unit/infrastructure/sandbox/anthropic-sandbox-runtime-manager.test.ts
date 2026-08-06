import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_SANDBOX_RUNTIME_VERSION,
  resolveAnthropicSandboxRuntimeSeccompPath,
} from "../../../../src/infrastructure/sandbox/anthropic-sandbox-runtime-manager.js";

const packageJsonUrl = new URL("../../../../package.json", import.meta.url);

describe("Anthropic Sandbox Runtime dependency", () => {
  it("pins the exact version recorded in sandbox evidence", async () => {
    const manifest = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };

    expect(manifest.dependencies?.["@anthropic-ai/sandbox-runtime"]).toBe(
      ANTHROPIC_SANDBOX_RUNTIME_VERSION,
    );
    expect(ANTHROPIC_SANDBOX_RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("resolves only the packaged Linux seccomp helpers supported by SRT", () => {
    expect(resolveAnthropicSandboxRuntimeSeccompPath("linux", "x64")).toMatch(
      /vendor\/seccomp\/x64\/apply-seccomp$/,
    );
    expect(resolveAnthropicSandboxRuntimeSeccompPath("linux", "arm64")).toMatch(
      /vendor\/seccomp\/arm64\/apply-seccomp$/,
    );
    expect(resolveAnthropicSandboxRuntimeSeccompPath("darwin", "arm64")).toBeUndefined();
    expect(resolveAnthropicSandboxRuntimeSeccompPath("linux", "ia32")).toBeUndefined();
  });
});
