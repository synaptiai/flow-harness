import { describe, expect, it } from "vitest";
import { NodeExecutorRouter } from "../../../../src/application/node-executor-router.js";
import { LocalContainerCommandSandbox } from "../../../../src/infrastructure/oci/local-container-command-sandbox.js";
import { PiAgentExecutor } from "../../../../src/infrastructure/pi/pi-agent-executor.js";
import {
  createProductionCommandSandbox,
  createProductionNodeExecutor,
} from "../../../../src/infrastructure/runtime/production-node-executor.js";
import { SrtCommandSandbox } from "../../../../src/infrastructure/sandbox/srt-command-sandbox.js";

describe("production node executor composition", () => {
  it("keeps the native sandbox as the unchanged default", () => {
    expect(createProductionCommandSandbox()).toBeInstanceOf(SrtCommandSandbox);
    expect(createProductionCommandSandbox("native")).toBeInstanceOf(SrtCommandSandbox);
    const executor = createProductionNodeExecutor();
    expect(executor).toBeInstanceOf(NodeExecutorRouter);
    expect((executor as NodeExecutorRouter).agentExecutor).toBeInstanceOf(PiAgentExecutor);
    expect(
      ((executor as NodeExecutorRouter).agentExecutor as PiAgentExecutor).semanticSessionFactory,
    ).toBeTypeOf("function");
    expect(createProductionNodeExecutor("native")).toBeDefined();
  });

  it("selects the container adapter without initializing its runtime", () => {
    expect(createProductionCommandSandbox("container")).toBeInstanceOf(
      LocalContainerCommandSandbox,
    );
    expect(createProductionNodeExecutor("container")).toBeDefined();
  });
});
