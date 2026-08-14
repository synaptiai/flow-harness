import { describe, expect, it } from "vitest";

import {
  calculateContainerCommandConfigurationDigest,
  parseContainerCommandIntent,
} from "../../../../src/infrastructure/oci/container-command-intent.js";

const configuration = {
  Image: `sha256:${"d".repeat(64)}`,
  Entrypoint: ["node"],
  Cmd: ["-e", "console.log('PRIVATE_COMMAND')"],
  HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
};

describe("container command durable intent", () => {
  it("freezes one exact intent with process and runtime identity", () => {
    const record = parseContainerCommandIntent(intentRecord());

    expect(record).toMatchObject({
      version: 1,
      state: "intent",
      containerName: `flow-command-${"b".repeat(32)}`,
      configurationDigest: calculateContainerCommandConfigurationDigest(configuration),
      owner: {
        bootId: "123e4567-e89b-42d3-a456-426614174000",
        pid: 1234,
        startTicks: "987654",
      },
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.owner)).toBe(true);
    expect(Object.isFrozen(record.configuration)).toBe(true);
    expect(Object.isFrozen(record.configuration.HostConfig)).toBe(true);
  });

  it("requires owned state and the full container ID to agree", () => {
    expect(() =>
      parseContainerCommandIntent({
        ...intentRecord(),
        state: "owned",
      }),
    ).toThrow("container command durable intent is invalid");
    expect(() =>
      parseContainerCommandIntent({
        ...intentRecord(),
        containerId: "c".repeat(64),
      }),
    ).toThrow("container command durable intent is invalid");
  });

  it("rejects configuration mutation and unknown authority fields", () => {
    expect(() =>
      parseContainerCommandIntent({
        ...intentRecord(),
        configuration: { ...configuration, Image: `sha256:${"e".repeat(64)}` },
      }),
    ).toThrow("container command durable intent is invalid");
    expect(() =>
      parseContainerCommandIntent({
        ...intentRecord(),
        privileged: true,
      }),
    ).toThrow("container command durable intent is invalid");
  });
});

function intentRecord(): Record<string, unknown> {
  return {
    version: 1,
    state: "intent",
    ownerNonce: "a".repeat(64),
    containerName: `flow-command-${"b".repeat(32)}`,
    owner: {
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      pid: 1234,
      startTicks: "987654",
    },
    runtime: {
      engineVersion: "28.3.3",
      apiVersion: "1.51",
      socketPath: "/var/run/docker.sock",
      imageId: `sha256:${"d".repeat(64)}`,
      runtimeName: "flow-prime-runc",
      policyDigest: "f".repeat(64),
    },
    privateDirectory: "/private/flow-container-command-a",
    configuration,
    configurationDigest: calculateContainerCommandConfigurationDigest(configuration),
  };
}
