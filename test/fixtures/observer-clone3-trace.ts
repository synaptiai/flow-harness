/**
 * Parses synthetic-contract or bounded real strace text; never supplies runtime
 * evidence by itself. Unprefixed-to-prefixed unfinished-call transitions are
 * unsupported: do not guess process identity from an unmatched continuation.
 */
export function countClone3(trace: string) {
  const pending = new Set<string>();
  const counts = { calls: 0, completed: 0, enosys: 0, injected: 0 };
  for (const line of trace.split("\n")) {
    const match = /^\s*(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)?(.*)$/.exec(line);
    if (match === null) throw new Error("Unsupported trace framing");
    const pid = match[1] ?? match[2] ?? "main";
    const body = (match[3] ?? "").trimEnd();
    if (body.startsWith("clone3(")) {
      if (pending.has(pid)) throw new Error("Overlapping clone3 records");
      counts.calls++;
      if (body.endsWith("<unfinished ...>")) {
        pending.add(pid);
        continue;
      }
    } else if (body.startsWith("<... clone3 resumed>")) {
      if (!pending.delete(pid)) throw new Error("Unmatched clone3 continuation");
    } else {
      if (/^(?:clone3\b|<\.\.\.\s+clone3\b)/.test(body))
        throw new Error("Unrecognized clone3 trace record");
      // An unrelated syscall can contain quoted source or log text. Such data
      // must not be confused with a syscall name at the start of a trace record.
      const unrelatedCall = /^(?:[a-zA-Z_]\w*\(|<\.\.\. [a-zA-Z_]\w* resumed>)/.test(body);
      if (!unrelatedCall && (line.includes("clone3(") || line.includes("clone3 resumed>")))
        throw new Error("Unrecognized clone3 trace record");
      continue;
    }
    const result =
      /\)\s+=\s+(-?\d+)(?:\s+([A-Z][A-Z0-9_]*)(?:\s+\([^()\n]*\))?)?(?:\s+\(INJECTED\))?$/.exec(
        body,
      );
    if (result === null) throw new Error("Unsupported clone3 return framing");
    const value = Number(result[1]);
    if (
      !Number.isSafeInteger(value) ||
      value < -1 ||
      (value === -1 ? result[2] === undefined : result[2] !== undefined)
    )
      throw new Error("Unsupported clone3 return value");
    counts.completed++;
    if (result[1] === "-1" && result[2] === "ENOSYS") counts.enosys++;
    if (body.endsWith("(INJECTED)")) counts.injected++;
  }
  if (pending.size !== 0) throw new Error("Incomplete clone3 observations");
  return counts;
}
