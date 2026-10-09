import { describe, expect, it } from "vitest";

import { countClone3 } from "../../fixtures/observer-clone3-trace.js";

// Synthetic parser-contract examples only; none are captured Linux evidence.
describe("clone3 trace counting contract", () => {
  it.each(["", 'execve("/synthetic/node", [], []) = 0\nfutex(0x123, FUTEX_WAKE, 1) = 1\n'])(
    "reports zero for an empty or unrelated trace",
    (trace) => {
      expect(countClone3(trace)).toEqual({ calls: 0, completed: 0, enosys: 0, injected: 0 });
    },
  );

  it.each(["", "[pid 123] ", "  [pid   123]   ", "123 ", "  123   "])(
    "counts a completed call with prefix %j",
    (prefix) => {
      expect(countClone3(`${prefix}clone3({flags=CLONE_VM}, 88) = 456\n`)).toEqual({
        calls: 1,
        completed: 1,
        enosys: 0,
        injected: 0,
      });
    },
  );

  it("separates real ENOSYS, other errors, and injected ENOSYS", () => {
    const trace = [
      "clone3({}, 88) = -1 ENOSYS (Function not implemented)",
      "clone3({}, 88) = -1 EPERM (Operation not permitted)",
      "clone3({}, 88) = -1 ENOSYS (Function not implemented) (INJECTED)",
    ].join("\n");
    expect(countClone3(trace)).toEqual({ calls: 3, completed: 3, enosys: 2, injected: 1 });
  });

  it("matches interleaved unfinished and resumed calls by PID", () => {
    const trace = [
      "[pid 10] clone3({flags=CLONE_VM}, 88 <unfinished ...>",
      "[pid 11] clone3({flags=CLONE_VM}, 88 <unfinished ...>",
      "[pid 12] futex(0x123, FUTEX_WAKE, 1) = 1",
      "[pid 11] <... clone3 resumed>) = -1 ENOSYS (Function not implemented) (INJECTED)",
      "[pid 10] <... clone3 resumed>) = 13",
    ].join("\n");
    expect(countClone3(trace)).toEqual({ calls: 2, completed: 2, enosys: 1, injected: 1 });
  });

  it("does not interpret syscall-looking quoted data in unrelated calls", () => {
    expect(countClone3('write(2, "clone3({}, 88) = 5", 18) = 18\n')).toEqual({
      calls: 0,
      completed: 0,
      enosys: 0,
      injected: 0,
    });
  });

  it.each([
    ["unknown prefix", "[thread 12] clone3({}, 88) = 13"],
    ["malformed call name boundary", "clone3 ({}, 88) = 13"],
    ["malformed resumed marker", "<... clone3 resumed ) = 13"],
    ["missing return", "clone3({}, 88)"],
    ["incomplete return", "clone3({}, 88) = ?"],
    ["trailing return garbage", "clone3({}, 88) = 13unknown"],
    ["missing errno", "clone3({}, 88) = -1"],
    ["unsupported negative return", "clone3({}, 88) = -2"],
    ["unsafe integer return", "clone3({}, 88) = 9007199254740992"],
    ["incomplete call", "[pid 10] clone3({}, 88 <unfinished ...>"],
    ["unmatched continuation", "[pid 10] <... clone3 resumed>) = 13"],
    [
      "ambiguous prefix transition",
      "clone3({}, 88 <unfinished ...>\n[pid 10] <... clone3 resumed>) = 13",
    ],
    [
      "wrong PID continuation",
      "[pid 10] clone3({}, 88 <unfinished ...>\n[pid 11] <... clone3 resumed>) = 13",
    ],
    ["overlap", "[pid 10] clone3({}, 88 <unfinished ...>\n[pid 10] clone3({}, 88) = 13"],
  ])("rejects %s without disclosing trace contents", (_label, trace) => {
    expect(() => countClone3(trace)).toThrow();
    try {
      countClone3(trace);
    } catch (error) {
      expect((error as Error).message).not.toContain(trace);
      expect((error as Error).message).not.toContain("/synthetic/");
    }
  });
});
