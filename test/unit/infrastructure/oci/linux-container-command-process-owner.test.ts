import { describe, expect, it } from "vitest";

import {
  isLinuxContainerCommandProcessOwnerAlive,
  parseLinuxContainerCommandProcessOwner,
} from "../../../../src/infrastructure/oci/linux-container-command-process-owner.js";

describe("Linux container command process owner", () => {
  it("parses boot, pid, and start identity when the process name contains parentheses", () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_, index) => `${index + 1}`), "987654"];

    expect(
      parseLinuxContainerCommandProcessOwner(
        "123e4567-e89b-42d3-a456-426614174000\n",
        `1234 (flow worker (recovery)) ${fields.join(" ")}\n`,
        1234,
      ),
    ).toEqual({
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      pid: 1234,
      startTicks: "987654",
    });
  });

  it.each([
    ["wrong pid", "1235 (flow) S 1", 1234],
    ["missing start field", "1234 (flow) S 1", 1234],
    ["invalid start field", `1234 (flow) ${["S", ...Array(18).fill("1"), "0"].join(" ")}`, 1234],
  ])("rejects %s", (_label, stat, pid) => {
    expect(() =>
      parseLinuxContainerCommandProcessOwner("123e4567-e89b-42d3-a456-426614174000\n", stat, pid),
    ).toThrow("Linux container command process identity is invalid");
  });

  it("distinguishes an exact live owner from PID reuse and a previous boot", async () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_, index) => `${index + 1}`), "987654"];
    const owner = {
      bootId: "123e4567-e89b-42d3-a456-426614174000",
      pid: 1234,
      startTicks: "987654",
    };
    const readStat = async () => `1234 (flow worker) ${fields.join(" ")}\n`;

    await expect(
      isLinuxContainerCommandProcessOwnerAlive(owner, {
        readBootId: async () => `${owner.bootId}\n`,
        readStat,
      }),
    ).resolves.toBe(true);
    await expect(
      isLinuxContainerCommandProcessOwnerAlive(
        { ...owner, startTicks: "987655" },
        { readBootId: async () => `${owner.bootId}\n`, readStat },
      ),
    ).resolves.toBe(false);
    await expect(
      isLinuxContainerCommandProcessOwnerAlive(owner, {
        readBootId: async () => "223e4567-e89b-42d3-a456-426614174000\n",
        readStat: async () => {
          throw new Error("must not read a previous-boot PID");
        },
      }),
    ).resolves.toBe(false);
  });
});
