import { describe, expect, it } from "vitest";

import { formatErrorCauseChain } from "../../../src/cli/error-cause-chain.js";

describe("error cause chain", () => {
  it("renders each nested cause with its error name", () => {
    const root = new Error("Docker command failed with 1: network unreachable");
    const stage = new TypeError("stage failed", { cause: root });
    const top = new Error("build failed", { cause: stage });

    expect(formatErrorCauseChain(top)).toBe(
      [
        "build failed",
        "  caused by: TypeError: stage failed",
        "    caused by: Docker command failed with 1: network unreachable",
      ].join("\n"),
    );
  });

  it("renders every AggregateError member before its cause", () => {
    const aggregate = new AggregateError(
      [new Error("build error"), new Error("cleanup error")],
      "cleanup failed",
      { cause: "context" },
    );

    expect(formatErrorCauseChain(aggregate)).toBe(
      [
        "AggregateError: cleanup failed",
        "  - build error",
        "  - cleanup error",
        "  caused by: context",
      ].join("\n"),
    );
  });

  it("indents multi-line messages under their entry", () => {
    const error = new Error("outer", { cause: new Error("line one\nline two") });

    expect(formatErrorCauseChain(error)).toBe(
      ["outer", "  caused by: line one", "    line two"].join("\n"),
    );
  });

  it("removes terminal control sequences but keeps tabs", () => {
    const error = new Error("red \u001b[31mtext\u001b[0m\tbell\u0007 c1\u009b");

    const rendered = formatErrorCauseChain(error);

    expect(rendered).toBe("red \uFFFD[31mtext\uFFFD[0m\tbell\uFFFD c1\uFFFD");
    const controls = [...rendered].filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return (point < 0x20 && point !== 0x09 && point !== 0x0a) || (point >= 0x7f && point <= 0x9f);
    });
    expect(controls).toEqual([]);
  });

  it("redacts AWS access key identifiers", () => {
    const error = new Error("found AKIAABCDEFGHIJKLMNOP in output");

    expect(formatErrorCauseChain(error)).toBe("found AKIA[REDACTED] in output");
  });

  it("stops at repeated causes", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(formatErrorCauseChain(first)).toBe(
      ["first", "  caused by: second", "    caused by: (repeated cause omitted)"].join("\n"),
    );
  });

  it("bounds cause depth and entry count", () => {
    let deep: Error = new Error("level 20");
    for (let level = 19; level >= 0; level -= 1) {
      deep = new Error(`level ${level}`, { cause: deep });
    }
    const deepLines = formatErrorCauseChain(deep).split("\n");
    expect(deepLines).toHaveLength(10);
    expect(deepLines.at(-1)).toBe("(further causes omitted)");

    const wide = new AggregateError(
      Array.from({ length: 40 }, (_, index) => new Error(`member ${index}`)),
      "wide",
    );
    const wideLines = formatErrorCauseChain(wide).split("\n");
    expect(wideLines).toHaveLength(17);
    expect(wideLines.at(-1)).toBe("(further causes omitted)");
  });

  it("renders values whose string conversion throws", () => {
    const hostile = {
      toString() {
        throw new Error("no");
      },
    };

    expect(formatErrorCauseChain(new Error("outer", { cause: hostile }))).toBe(
      ["outer", "  caused by: (unprintable cause)"].join("\n"),
    );
  });
});
