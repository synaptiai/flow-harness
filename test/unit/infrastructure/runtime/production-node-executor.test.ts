import { describe, expect, it } from "vitest";
import { LocalContainerCommandSandbox } from "../../../../src/infrastructure/oci/local-container-command-sandbox.js";
import {
  createProductionCommandSandbox,
  createProductionNodeExecutor,
} from "../../../../src/infrastructure/runtime/production-node-executor.js";
import { SrtCommandSandbox } from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";

describe("production node executor composition", () => {
  it("keeps the native sandbox as the unchanged default", () => {
    expect(createProductionCommandSandbox()).toBeInstanceOf(SrtCommandSandbox);
    expect(createProductionCommandSandbox("native")).toBeInstanceOf(SrtCommandSandbox);
    expect(createProductionNodeExecutor()).toBeDefined();
    expect(createProductionNodeExecutor("native")).toBeDefined();
  });

  it("selects the container adapter without initializing its runtime", () => {
    expect(createProductionCommandSandbox("container")).toBeInstanceOf(
      LocalContainerCommandSandbox,
    );
    expect(createProductionNodeExecutor("container")).toBeDefined();
  });
});
