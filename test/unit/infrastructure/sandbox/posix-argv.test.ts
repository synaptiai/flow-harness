import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { encodePosixCommand } from "../../../../src/infrastructure/sandbox/posix-argv.js";

const execFileAsync = promisify(execFile);

describe("encodePosixCommand", () => {
  it("round-trips hostile argument bytes without creating extra shell operations", async () => {
    const expected = [
      "",
      "plain",
      "two words",
      "single'quote",
      'double"quote',
      "line one\nline two",
      "$(printf injected)",
      "; printf injected",
      "| printf injected",
      "> should-not-exist",
      "`printf injected`",
      "back\\slash",
      "unicode-æøå-🧪",
    ];
    const command = encodePosixCommand(process.execPath, [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...expected,
    ]);

    const result = await execFileAsync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    });

    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.stderr).toBe("");
  });

  it("rejects values that POSIX command strings cannot represent", () => {
    expect(() => encodePosixCommand("", [])).toThrow("executable must not be empty");
    expect(() => encodePosixCommand("node", ["before\0after"])).toThrow(
      "command values must not contain NUL bytes",
    );
  });
});
