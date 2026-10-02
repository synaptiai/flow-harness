const FRAME_BYTES = 64;
const MAGIC = Buffer.from("FLOWOBS1", "ascii");

export type NativeObserverResultRecord = Readonly<
  { clone3FallbackUsed: boolean } & (
    | { kind: "normal_exit"; exitCode: number }
    | { kind: "signalled"; signal: number }
    | { kind: "setup_failed"; errno: number; stage: SetupStage }
    | { kind: "exec_failed"; errno: number }
    | { kind: "policy_interference" }
    | { kind: "supervisor_failed"; errno: number; stage: SupervisorStage }
  )
>;

type SetupStage = "bootstrap" | "namespace_setup" | "filter_setup" | "descriptor_handoff";
type SupervisorStage = "descriptor_handoff" | "settlement";

/**
 * Recognizes one complete private-channel frame, not candidate stdout/stderr.
 * Correlation binds bytes to an invocation; it does not authenticate the writer.
 * Custody, executable identity, EOF, cancellation and descendant settlement must
 * be established independently before using a record. A signal does not prove
 * successful exec. Policy interference and unqualified clone3 fallback must not
 * become behavioral repair evidence, even with a normal-exit record.
 */
export function parseNativeObserverResult(
  bytes: unknown,
  expectedCorrelation: unknown,
): NativeObserverResultRecord | null {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== FRAME_BYTES ||
    bytes.buffer instanceof SharedArrayBuffer ||
    typeof expectedCorrelation !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedCorrelation)
  )
    return null;
  const frame = Buffer.from(bytes);
  if (
    !frame.subarray(0, 8).equals(MAGIC) ||
    !frame.subarray(8, 40).equals(Buffer.from(expectedCorrelation, "hex")) ||
    frame.subarray(56).some((byte) => byte !== 0)
  )
    return null;
  const kind = frame.readUInt32LE(40);
  const detail = frame.readUInt32LE(44);
  const stage = frame.readUInt32LE(48);
  const flags = frame.readUInt32LE(52);
  if (flags > 1) return null;
  const common = { clone3FallbackUsed: flags === 1 };
  switch (kind) {
    case 1:
      return stage === 0 && detail <= 255
        ? Object.freeze({ ...common, kind: "normal_exit", exitCode: detail })
        : null;
    case 2:
      return stage === 0 && detail >= 1 && detail <= 64
        ? Object.freeze({ ...common, kind: "signalled", signal: detail })
        : null;
    case 3: {
      const phases = [
        "bootstrap",
        "namespace_setup",
        "filter_setup",
        "descriptor_handoff",
      ] as const;
      const phase = phases[stage - 1];
      return validErrno(detail) && phase !== undefined
        ? Object.freeze({ ...common, kind: "setup_failed", errno: detail, stage: phase })
        : null;
    }
    case 4:
      return stage === 0 && validErrno(detail)
        ? Object.freeze({ ...common, kind: "exec_failed", errno: detail })
        : null;
    case 5:
      return stage === 0 && detail === 0
        ? Object.freeze({ ...common, kind: "policy_interference" })
        : null;
    case 6:
      return validErrno(detail) && (stage === 4 || stage === 5)
        ? Object.freeze({
            ...common,
            kind: "supervisor_failed",
            errno: detail,
            stage: stage === 4 ? "descriptor_handoff" : "settlement",
          })
        : null;
    default:
      return null;
  }
}

function validErrno(value: number): boolean {
  return value >= 1 && value <= 4095;
}
