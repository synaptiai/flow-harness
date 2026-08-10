import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { CliIo } from "../../../src/cli/main.js";
import {
  BUILT_IN_FLOW_CONFIG,
  calculateFlowPolicyDigest,
  FLOW_CONFIG_API_VERSION,
  type EffectiveFlowConfig,
} from "../../../src/domain/config/resolver.js";

vi.mock("../../../src/infrastructure/runtime/production-external-harness-runtime.js", () => {
  throw new Error("offline command loaded the production external harness runtime");
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

it("does not load the external harness runtime for offline inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-offline-evaluation-"));
  temporaryDirectories.push(root);
  const { main } = await import("../../../src/cli/main.js");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };

  expect(
    await main(["eval", "inspect", "missing", "--evaluations-dir", root], io, {
      cwd: root,
      loadConfig: async () => effectiveConfig(root),
    }),
  ).toBe(1);
  expect(stderr.join("\n")).toMatch(/not_found|does not exist/i);
  expect(stderr.join("\n")).not.toMatch(/loaded the production external harness runtime/i);
}, 20_000);

function effectiveConfig(projectRoot: string): EffectiveFlowConfig {
  const supervisor = { ...BUILT_IN_FLOW_CONFIG };
  return {
    apiVersion: FLOW_CONFIG_API_VERSION,
    supervisor,
    policyDigest: calculateFlowPolicyDigest(supervisor),
    projectRoot,
    sources: {
      builtIn: BUILT_IN_FLOW_CONFIG,
      operator: null,
      project: { path: join(projectRoot, ".flow", "config.yaml"), values: {} },
    },
  };
}
