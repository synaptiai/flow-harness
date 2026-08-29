import type {
  AgentCommandExecutor,
  NodeAgentCommandJournal,
  NodeExecutionContext,
} from "../../application/ports.js";
import {
  type AgentCommandRequest,
  calculateAgentCommandDigest,
} from "../../domain/agent-command.js";
import type { PolicyDecision } from "../../domain/policy/types.js";
import {
  type AgentCommandSettlementOutcome,
  MAX_AGENT_COMMANDS_PER_ATTEMPT,
  type NodeFailure,
} from "../../domain/run/events.js";

export class AgentCommandRecorder {
  readonly #outcomes: AgentCommandSettlementOutcome[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #inFlight = 0;
  #started = 0;
  #uncertain = false;
  #closed = false;

  constructor(
    readonly executor: AgentCommandExecutor | undefined,
    readonly journal: NodeAgentCommandJournal | undefined,
    readonly context: NodeExecutionContext,
    readonly onArtifactBudgetExhausted?: () => void,
    readonly onTerminationUnconfirmed?: () => void,
  ) {}

  async execute(
    request: AgentCommandRequest,
    decision: PolicyDecision,
    signal?: AbortSignal,
  ): Promise<AgentCommandSettlementOutcome> {
    if (this.#closed) {
      throw new AgentCommandAuditClosedError();
    }
    if (this.executor === undefined || this.journal === undefined) {
      throw new AgentCommandJournalUnavailableError();
    }
    if (this.#started >= MAX_AGENT_COMMANDS_PER_ATTEMPT) {
      throw new AgentCommandAuditLimitError(MAX_AGENT_COMMANDS_PER_ATTEMPT);
    }
    const operationDigest = calculateAgentCommandDigest(request);
    validateDecision(request, operationDigest, decision);
    this.#started += 1;
    this.#inFlight += 1;
    let executionStarted = false;
    try {
      const approval = await this.context.agentCommandApprovalGate?.authorize(request, signal);
      const prepared = await this.journal.prepare({
        request,
        operationDigest,
        decision,
        ...(approval === undefined ? {} : { approval }),
      });
      executionStarted = true;
      const executionContext = withArtifactProducer(
        withExecutionSignal(this.context, signal),
        prepared,
      );
      const { commandStdin: _commandStdin, ...agentCommandContext } = executionContext;
      const outcome = await this.executor.executeAgentCommand(request, agentCommandContext);
      const settlement = await prepared.settle(outcome);
      const durableOutcome = deepFreeze(structuredClone(outcome));
      this.#outcomes.push(durableOutcome);
      if (durableOutcome.evidence?.terminationStatus === "unconfirmed") {
        this.#closed = true;
        this.onTerminationUnconfirmed?.();
      }
      if (settlement.artifactBudgetExhausted) {
        this.onArtifactBudgetExhausted?.();
      }
      return durableOutcome;
    } catch (error) {
      if (executionStarted) {
        this.#uncertain = true;
      }
      throw error;
    } finally {
      this.#inFlight -= 1;
      this.#notifyIdle();
    }
  }

  snapshot(): readonly AgentCommandSettlementOutcome[] {
    return Object.freeze([...this.#outcomes]);
  }

  sideEffectStatus(forceUncertain = false): NodeFailure["sideEffectStatus"] {
    if (forceUncertain || this.#uncertain || this.#inFlight > 0) {
      return "uncertain";
    }
    let committed = false;
    for (const outcome of this.#outcomes) {
      if (outcome.status === "succeeded" || outcome.error.sideEffectStatus === "committed") {
        committed = true;
      }
      if (outcome.status === "failed" && outcome.error.sideEffectStatus === "uncertain") {
        return "uncertain";
      }
    }
    return committed ? "committed" : "none";
  }

  whenIdle(): Promise<void> {
    if (this.#inFlight === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  close(): void {
    this.#closed = true;
  }

  #notifyIdle(): void {
    if (this.#inFlight !== 0) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function withArtifactProducer(
  context: NodeExecutionContext,
  prepared: Awaited<ReturnType<NodeAgentCommandJournal["prepare"]>>,
): NodeExecutionContext {
  if (context.artifactStore === undefined) return context;
  if (context.nodeId === undefined) {
    throw new TypeError("artifact-enabled agent command context is missing its node identity");
  }
  return Object.freeze({
    ...context,
    agentCommandArtifactProducer: Object.freeze({
      kind: "agent-command" as const,
      runId: context.runId,
      workflowId: context.workflowId,
      nodeId: context.nodeId,
      attempt: context.attempt,
      commandId: prepared.commandId,
      commandSequence: prepared.commandSequence,
    }),
  });
}

function withExecutionSignal(
  context: NodeExecutionContext,
  signal: AbortSignal | undefined,
): NodeExecutionContext {
  if (signal === undefined) {
    return context;
  }
  if (context.signal === undefined || context.signal === signal) {
    return Object.freeze({ ...context, signal });
  }
  return Object.freeze({ ...context, signal: AbortSignal.any([context.signal, signal]) });
}

export class AgentCommandJournalUnavailableError extends Error {
  override readonly name = "AgentCommandJournalUnavailableError";

  constructor() {
    super("Agent command execution requires a sandbox executor and attempt-scoped durable journal");
  }
}

export class AgentCommandAuditLimitError extends Error {
  override readonly name = "AgentCommandAuditLimitError";

  constructor(readonly limit: number) {
    super(`Agent command audit limit of ${limit} commands was reached`);
  }
}

export class AgentCommandAuditClosedError extends Error {
  override readonly name = "AgentCommandAuditClosedError";

  constructor() {
    super("Agent command audit is closed; late command execution is denied");
  }
}

function validateDecision(
  request: AgentCommandRequest,
  operationDigest: string,
  decision: PolicyDecision,
): void {
  if (
    decision.action !== "process.execute" ||
    decision.authority !== "execute" ||
    decision.target !== request.executable ||
    decision.operationDigest !== operationDigest ||
    decision.outcome !== "allowed" ||
    decision.reason !== "operation_declared"
  ) {
    throw new AgentCommandAuthorizationMismatchError();
  }
}

export class AgentCommandAuthorizationMismatchError extends Error {
  override readonly name = "AgentCommandAuthorizationMismatchError";

  constructor() {
    super("Agent command request does not match its exact process authorization");
  }
}
