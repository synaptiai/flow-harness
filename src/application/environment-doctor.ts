import type { FlowSandboxProfile } from "../domain/config/sandbox-profiles.js";
import { isFlowHostSupported } from "../domain/host-requirements.js";

export const FLOW_DOCTOR_REPORT_VERSION = 1 as const;
export const FLOW_DOCTOR_PROBE_TIMEOUT_MS = 4_000;
const MAX_FLOW_DOCTOR_PROBE_TIMEOUT_MS = 5_000;

export type EnvironmentDoctorTarget = "project" | "workflow" | "prime-agent";
export type EnvironmentDoctorCheckStatus = "pass" | "fail" | "skip";

export interface EnvironmentDoctorModelRequirement {
  readonly provider: string;
  readonly model: string;
}

export interface EnvironmentDoctorWorkflowRequirements {
  readonly modelRequirements: readonly EnvironmentDoctorModelRequirement[];
  readonly requiresLinuxAgentCommands: boolean;
}

export interface EnvironmentDoctorConfiguration {
  readonly projectRoot: string | null;
  readonly sandbox: FlowSandboxProfile;
}

export interface EnvironmentDoctorCheck {
  readonly category: string;
  readonly status: EnvironmentDoctorCheckStatus;
  readonly message: string;
  readonly remediation?: string;
}

export interface EnvironmentDoctorReport {
  readonly version: typeof FLOW_DOCTOR_REPORT_VERSION;
  readonly ok: boolean;
  readonly target: EnvironmentDoctorTarget;
  readonly checks: readonly EnvironmentDoctorCheck[];
}

export interface EnvironmentDoctorInput {
  readonly target: EnvironmentDoctorTarget;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly invocationRoot: string;
  readonly probeTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EnvironmentDoctorDependencies {
  readonly loadConfiguration: (signal: AbortSignal) => Promise<EnvironmentDoctorConfiguration>;
  readonly inspectProjectFilesystem: (projectRoot: string, signal: AbortSignal) => Promise<void>;
  readonly inspectNativeSandbox: (root: string, signal: AbortSignal) => Promise<void>;
  readonly inspectContainerSandbox: (projectRoot: string, signal: AbortSignal) => Promise<void>;
  readonly inspectWorkflow: (signal: AbortSignal) => Promise<EnvironmentDoctorWorkflowRequirements>;
  readonly inspectProviders: (
    requirements: readonly EnvironmentDoctorModelRequirement[],
    signal: AbortSignal,
  ) => Promise<void>;
  readonly inspectPrime: (projectRoot: string, signal: AbortSignal) => Promise<void>;
}

type ProbeOutcome = "pass" | "failure" | "timeout";

export async function runEnvironmentDoctor(
  input: EnvironmentDoctorInput,
  dependencies: EnvironmentDoctorDependencies,
): Promise<EnvironmentDoctorReport> {
  const probeTimeoutMs = input.probeTimeoutMs ?? FLOW_DOCTOR_PROBE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(probeTimeoutMs) ||
    probeTimeoutMs < 1 ||
    probeTimeoutMs > MAX_FLOW_DOCTOR_PROBE_TIMEOUT_MS
  ) {
    throw new RangeError("Flow doctor probe timeout is invalid");
  }
  input.signal?.throwIfAborted();
  const initialHostCheck = hostCheck(input.platform, input.nodeVersion);
  if (initialHostCheck.status === "fail") {
    return unsupportedHostReport(input.target, initialHostCheck);
  }
  const checks: EnvironmentDoctorCheck[] = [initialHostCheck];
  const configurationResult = await runProbe(
    (signal) => dependencies.loadConfiguration(signal),
    probeTimeoutMs,
    input.signal,
  );
  if (configurationResult.outcome !== "pass") {
    checks.push(
      failCheck(
        "project.configuration",
        configurationResult.outcome === "timeout"
          ? "The effective Flow configuration check did not complete."
          : "The effective Flow configuration is unavailable.",
        "Fix the Flow configuration, then rerun flow doctor.",
      ),
      skipCheck(
        "project.discovery",
        "Project discovery was not checked because configuration failed.",
      ),
      skipCheck(
        "project.filesystem",
        "Project filesystem access was not checked because configuration failed.",
      ),
      skipCheck(
        "sandbox.configuration",
        "The sandbox was not checked because configuration failed.",
      ),
    );
    appendTargetConfigurationSkips(checks, input.target);
    return report(input.target, checks);
  }

  const configuration = configurationResult.value;
  checks.push(passCheck("project.configuration", "The effective Flow configuration is valid."));
  if (configuration.projectRoot === null) {
    checks.push(
      failCheck(
        "project.discovery",
        "No Flow project is configured.",
        "Run flow init in the intended project, then rerun flow doctor.",
      ),
      skipCheck(
        "project.filesystem",
        "Project filesystem access was not checked because no project was found.",
      ),
    );
  } else {
    checks.push(passCheck("project.discovery", "A Flow project is configured."));
    const filesystemResult = await runProbe(
      (signal) =>
        dependencies.inspectProjectFilesystem(configuration.projectRoot as string, signal),
      probeTimeoutMs,
      input.signal,
    );
    checks.push(
      probeCheck(filesystemResult.outcome, {
        category: "project.filesystem",
        pass: "The Flow project filesystem is accessible.",
        failure: "The Flow project filesystem is not accessible.",
        timeout: "The Flow project filesystem check did not complete.",
        remediation: "Confirm project read and write access, then rerun flow doctor.",
      }),
    );
  }

  const sandboxRoot = configuration.projectRoot ?? input.invocationRoot;
  const sandboxResult = await runProbe(
    (signal) =>
      configuration.sandbox === "native"
        ? dependencies.inspectNativeSandbox(sandboxRoot, signal)
        : configuration.projectRoot === null
          ? Promise.reject(new Error("configured container sandbox has no project"))
          : dependencies.inspectContainerSandbox(configuration.projectRoot, signal),
    probeTimeoutMs,
    input.signal,
  );
  const sandboxCategory = `sandbox.${configuration.sandbox}`;
  checks.push(
    probeCheck(sandboxResult.outcome, {
      category: sandboxCategory,
      pass: `The configured ${configuration.sandbox} sandbox is available.`,
      failure: `The configured ${configuration.sandbox} sandbox is unavailable.`,
      timeout: `The configured ${configuration.sandbox} sandbox check did not complete.`,
      remediation:
        configuration.sandbox === "native"
          ? "Install the documented native sandbox prerequisites, then rerun flow doctor."
          : "Prepare and verify the documented container runtime, then rerun flow doctor.",
    }),
  );

  if (input.target === "workflow") {
    await appendWorkflowChecks(checks, dependencies, input.platform, probeTimeoutMs, input.signal);
  }
  if (input.target === "prime-agent") {
    await appendPrimeCheck(
      checks,
      dependencies,
      configuration.projectRoot,
      probeTimeoutMs,
      input.signal,
    );
  }
  return report(input.target, checks);
}

export function createUnsupportedHostEnvironmentDoctorReport(
  target: EnvironmentDoctorTarget,
  platform: string,
  nodeVersion: string,
): EnvironmentDoctorReport {
  const check = hostCheck(platform, nodeVersion);
  if (check.status !== "fail") {
    throw new Error("Flow host failure report requires an unsupported host");
  }
  return unsupportedHostReport(target, check);
}

function hostCheck(platform: string, nodeVersion: string): EnvironmentDoctorCheck {
  return isFlowHostSupported({ platform, nodeVersion })
    ? passCheck("runtime.host", "The Flow host runtime is supported.")
    : failCheck(
        "runtime.host",
        "The Flow host runtime is unsupported.",
        "Use a supported operating system and Node.js version, then rerun flow doctor.",
      );
}

async function appendWorkflowChecks(
  checks: EnvironmentDoctorCheck[],
  dependencies: EnvironmentDoctorDependencies,
  platform: string,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<void> {
  const workflowResult = await runProbe(
    (signal) => dependencies.inspectWorkflow(signal),
    timeoutMs,
    callerSignal,
  );
  if (workflowResult.outcome !== "pass") {
    checks.push(
      probeCheck(workflowResult.outcome, {
        category: "workflow.admission",
        pass: "The selected workflow is valid and admitted.",
        failure: "The selected workflow is not admitted.",
        timeout: "The selected workflow check did not complete.",
        remediation: "Fix or install the selected workflow, then rerun flow doctor.",
      }),
      skipCheck(
        "workflow.host",
        "Workflow host requirements were not checked because admission failed.",
      ),
      skipCheck(
        "provider.configuration",
        "Provider configuration was not checked because workflow admission failed.",
      ),
    );
    return;
  }
  checks.push(passCheck("workflow.admission", "The selected workflow is valid and admitted."));
  if (workflowResult.value.requiresLinuxAgentCommands && platform !== "linux") {
    checks.push(
      failCheck(
        "workflow.host",
        "The selected workflow host requirements are unsupported.",
        "Run this workflow on a supported Linux host, then rerun flow doctor.",
      ),
      skipCheck(
        "provider.configuration",
        "Provider configuration was not checked because workflow host requirements failed.",
      ),
    );
    return;
  }
  checks.push(passCheck("workflow.host", "The selected workflow host requirements are supported."));
  if (workflowResult.value.modelRequirements.length === 0) {
    checks.push(
      passCheck(
        "provider.configuration",
        "The selected workflow does not require a model provider.",
      ),
    );
    return;
  }
  const providerResult = await runProbe(
    (signal) => dependencies.inspectProviders(workflowResult.value.modelRequirements, signal),
    timeoutMs,
    callerSignal,
  );
  checks.push(
    probeCheck(providerResult.outcome, {
      category: "provider.configuration",
      pass: "Every selected model and provider has local configuration.",
      failure: "A selected model or provider lacks local configuration.",
      timeout: "The selected provider configuration check did not complete.",
      remediation: "Configure every selected provider locally, then rerun flow doctor.",
    }),
  );
}

async function appendPrimeCheck(
  checks: EnvironmentDoctorCheck[],
  dependencies: EnvironmentDoctorDependencies,
  projectRoot: string | null,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<void> {
  if (projectRoot === null) {
    checks.push(
      skipCheck("prime.runtime", "The Prime runtime was not checked because no project was found."),
    );
    return;
  }
  const primeResult = await runProbe(
    (signal) => dependencies.inspectPrime(projectRoot, signal),
    timeoutMs,
    callerSignal,
  );
  checks.push(
    probeCheck(primeResult.outcome, {
      category: "prime.runtime",
      pass: "The prepared Prime runtime is current.",
      failure: "The prepared Prime runtime is unavailable or changed.",
      timeout: "The prepared Prime runtime check did not complete.",
      remediation: "Prepare the documented Prime runtime, then rerun flow doctor.",
    }),
  );
}

function appendTargetConfigurationSkips(
  checks: EnvironmentDoctorCheck[],
  target: EnvironmentDoctorTarget,
): void {
  if (target === "workflow") {
    checks.push(
      skipCheck("workflow.admission", "The workflow was not checked because configuration failed."),
      skipCheck(
        "workflow.host",
        "Workflow host requirements were not checked because admission did not run.",
      ),
      skipCheck(
        "provider.configuration",
        "Provider configuration was not checked because workflow admission did not run.",
      ),
    );
  }
  if (target === "prime-agent") {
    checks.push(
      skipCheck("prime.runtime", "The Prime runtime was not checked because configuration failed."),
    );
  }
}

function unsupportedHostReport(
  target: EnvironmentDoctorTarget,
  check: EnvironmentDoctorCheck,
): EnvironmentDoctorReport {
  const checks: EnvironmentDoctorCheck[] = [
    check,
    skipCheck(
      "project.configuration",
      "Configuration was not checked because the Flow host is unsupported.",
    ),
    skipCheck(
      "project.discovery",
      "Project discovery was not checked because the Flow host is unsupported.",
    ),
    skipCheck(
      "project.filesystem",
      "Project filesystem access was not checked because the Flow host is unsupported.",
    ),
    skipCheck(
      "sandbox.configuration",
      "The sandbox was not checked because the Flow host is unsupported.",
    ),
  ];
  if (target === "workflow") {
    checks.push(
      skipCheck(
        "workflow.admission",
        "The workflow was not checked because the host is unsupported.",
      ),
      skipCheck(
        "workflow.host",
        "Workflow host requirements were not checked because the host is unsupported.",
      ),
      skipCheck(
        "provider.configuration",
        "Provider configuration was not checked because the host is unsupported.",
      ),
    );
  }
  if (target === "prime-agent") {
    checks.push(
      skipCheck("prime.runtime", "Prime was not checked because the host is unsupported."),
    );
  }
  return report(target, checks);
}

async function runProbe<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<
  | { readonly outcome: "pass"; readonly value: T }
  | { readonly outcome: Exclude<ProbeOutcome, "pass"> }
> {
  callerSignal?.throwIfAborted();
  const timeoutController = new AbortController();
  const timeoutReason = new Error("Flow doctor probe timed out");
  const timer = setTimeout(() => timeoutController.abort(timeoutReason), timeoutMs);
  const signal =
    callerSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([callerSignal, timeoutController.signal]);
  let removeAbortListener: () => void = () => undefined;
  const interruption = new Promise<{ readonly outcome: "interrupted" }>((resolve) => {
    const onAbort = () => resolve({ outcome: "interrupted" });
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  const settlement = Promise.resolve()
    .then(() => operation(signal))
    .then(
      (value) => ({ outcome: "pass" as const, value }),
      () => ({ outcome: "failure" as const }),
    );
  try {
    const outcome = await Promise.race([settlement, interruption]);
    if (callerSignal?.aborted === true) {
      callerSignal.throwIfAborted();
    }
    if (outcome.outcome === "interrupted") {
      return { outcome: "timeout" };
    }
    return outcome;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

function probeCheck(
  outcome: ProbeOutcome,
  messages: {
    readonly category: string;
    readonly pass: string;
    readonly failure: string;
    readonly timeout: string;
    readonly remediation: string;
  },
): EnvironmentDoctorCheck {
  if (outcome === "pass") {
    return passCheck(messages.category, messages.pass);
  }
  return failCheck(
    messages.category,
    outcome === "timeout" ? messages.timeout : messages.failure,
    messages.remediation,
  );
}

function passCheck(category: string, message: string): EnvironmentDoctorCheck {
  return Object.freeze({ category, status: "pass" as const, message });
}

function failCheck(category: string, message: string, remediation: string): EnvironmentDoctorCheck {
  return Object.freeze({ category, status: "fail" as const, message, remediation });
}

function skipCheck(category: string, message: string): EnvironmentDoctorCheck {
  return Object.freeze({ category, status: "skip" as const, message });
}

function report(
  target: EnvironmentDoctorTarget,
  checks: readonly EnvironmentDoctorCheck[],
): EnvironmentDoctorReport {
  return Object.freeze({
    version: FLOW_DOCTOR_REPORT_VERSION,
    ok: checks.every((check) => check.status !== "fail"),
    target,
    checks: Object.freeze([...checks]),
  });
}
