# Decision Journal: Issue #166 — Run prompt-only local ACP agents under Flow authority

**Issue**: #166 | **Branch**: `codex/issue-166-acp-executor` | **Started**: 2026-08-23

---

## Context

Slice 10.1a admitted one exact local Agent Client Protocol (ACP) v1 runtime as an immutable
run capability. Slice 10.1b must execute that identity behind the existing Flow-owned
`AgentExecutor` boundary without adding executor selection to workflow YAML or granting an ACP
agent ambient editor authority.

ACP agents execute their own tools. Client permission requests and tool notifications therefore
cannot act as Flow's execution boundary. Flow must prevent ambient effects with process
containment, deny unexpected protocol activity, and record uncertainty when an observed activity
might already have produced an effect.

## Approved architecture

The user approved refined Approach B on 2026-08-23:

- Add a dedicated ACP executor and a dedicated sandbox interface.
- Back both the command and ACP sandbox paths with the existing shared Sandbox Runtime coordinator
  so concurrent nodes cannot race independent global sandbox sessions.
- Create one fresh process, session, and private state directory for every attempt.
- Grant only one exact provider hostname and one masked credential lease.
- Bind model and reasoning choices through exact ordered configuration identifiers and values.
- Preserve the embedded Pi route when no ACP selection exists.

The rejected alternatives were a generic dynamic command-sandbox profile, which would enlarge the
ordinary command authority surface, and an immutable container per attempt, which would add Docker
and runtime-packaging requirements to the initial local executor.

## Specification

_Captured by specification-capture skill on 2026-08-23. Source: mixed issue contract and
user-confirmed architecture._

### Non-goals

- Do not add ACP selection to workflow YAML, compiled workflows, or workflow digests.
- Do not permit ACP tools, filesystem access, terminal access, elicitation, MCP servers,
  extensions, session resume, or persistent agent sessions.
- Do not implement ACP v2, HTTP transport, remote agents, A2A, multi-user hosts, or dynamic agent
  selection.
- Do not make ACP a capability-package ABI or Flow's durable event model.
- Do not add silent provider, model, reasoning, credential, or configuration fallback.
- Do not claim VM-grade, hostile multi-tenant, privileged-host, or hostile same-user isolation.
- Do not change the observable embedded Pi path when a run has no ACP selection.
- Do not duplicate detailed operator guidance in the root README. The canonical ACP guide and
  architecture document own the details.

### Failure modes

- **Timeouts** — initialization, session creation, configuration, prompt completion, cancellation,
  process exit, and process-tree cleanup have fixed deadlines. A deadline terminates the complete
  process group, confirms cleanup, and returns one bounded category.
- **Partial failures** — a process, session, or provider request that starts but does not settle
  publishes no success evidence. Observed tool activity or another potentially open effect records
  uncertainty and is never retried automatically.
- **Invalid input** — malformed JSON-RPC, unsupported protocol versions, contaminated standard
  output, excessive frames or text, missing or rejected configuration, configuration drift,
  undeclared methods, permission requests, and tool activity fail closed with fixed diagnostics.
- **Missing context** — a missing current runtime identity, model mapping, configuration option,
  provider authority, selected credential, complete budget dimension, sandbox capability, or
  process-containment proof fails before useful model work.
- **Dependency outage** — a provider or proxy failure settles as a bounded attempt failure. Flow
  does not infer fallback or expose raw provider or proxy output.
- **Resource exhaustion** — aggregate protocol bytes, frames, in-flight requests, message text,
  standard error, duration, and descendant cleanup are bounded. Exceeding a bound terminates the
  process tree and retains no unbounded payload.

### Interface contracts

- `flow validate` and `flow run` accept one project-relative `--acp-agent` manifest selection.
  Detached submission stores the admitted capability snapshot. Resume uses the durable snapshot
  and exact current identity; it does not accept a second executor authority channel.
- The capability snapshot remains the only executor-selection input to `AgentExecutor`. An ACP
  route exists only when `NodeExecutionContext.capabilitySnapshot.acpAgent` exists.
- ACP execution is compatible only with model-backed nodes that declare no Flow tools, skills,
  tool packages, or tool approval. Incompatible workflows fail during admission.
- The manifest configuration contract binds an ordered list of exact session configuration
  assignments. Model and reasoning assignments resolve from the compiled node tuple. Literal
  assignments remain exact. ACP display categories never determine correctness.
- The client sends ACP v1 initialization without filesystem, terminal, elicitation, MCP, or
  extension capabilities. `session/new` uses the private attempt directory, an empty MCP-server
  list, and no additional directories.
- A dedicated inverse ACP protocol stream owns client requests and validates agent responses,
  notifications, permission requests, configuration updates, and aggregate bounds.
- A dedicated ACP sandbox request contains the exact runtime, private attempt directory, selected
  provider hostname, and selected credential variable. It cannot express arbitrary filesystem,
  network, or credential grants.
- The child receives a masked credential sentinel. Sandbox Runtime can inject the source secret
  only into TLS traffic to the selected exact provider hostname. Durable and public surfaces never
  receive the secret value.
- Successful `AgentEvidence` records provider-neutral executor, session, sandbox, termination, and
  independent usage-completeness provenance. Public projection removes host paths, launch details,
  credential names, private session identifiers, and raw protocol content.
- Every normal and abnormal outcome confirms process-group termination. Failure errors remain
  fixed, bounded, and free of raw standard output, standard error, host paths, credentials, and
  nested causes.

## Criterion verification map

### Criterion 1: Exact selection across run paths

- **Type**: Behavioral and contract.
- **Command**: `npx vitest run test/integration/cli/acp-agent-executor.test.ts test/integration/supervisor/worker.test.ts`.
- **Expected evidence**: Validation, attached execution, and detached execution carry the same ACP
  snapshot while repeated compilation produces the same workflow digest.
- **Does not promise**: executor selection in workflow YAML or a second resume-time selection.

### Criterion 2: Fresh process and session per attempt

- **Type**: Behavioral.
- **Command**: `npx vitest run test/unit/infrastructure/acp/local-acp-agent-executor.test.ts`.
- **Expected evidence**: Consecutive and recovery attempts observe distinct process and session
  identities, each bound to the expected run, node, and attempt.
- **Does not promise**: persistent ACP sessions or conversation continuity outside Flow evidence.

### Criterion 3: Exact model configuration

- **Type**: Contract and error handling.
- **Command**: `npx vitest run test/unit/capability/acp-agent.test.ts test/unit/infrastructure/acp/local-acp-agent-executor.test.ts`.
- **Expected evidence**: Exact ordered assignments succeed. Missing options, rejected values,
  fallback, autonomous updates, and later drift fail.
- **Does not promise**: category-based discovery, model aliases, or fallback.

### Criterion 4: No client authority

- **Type**: Protocol contract.
- **Command**: `npx vitest run test/unit/infrastructure/acp/acp-agent-protocol-stream.test.ts`.
- **Expected evidence**: Initialization advertises no optional authority. Session creation supplies
  an empty MCP-server list, no additional directories, and the private attempt directory.
- **Does not promise**: tool-capable ACP interoperability.

### Criterion 5: Authority violations terminate

- **Type**: Error handling and security boundary.
- **Command**: `npx vitest run test/unit/infrastructure/acp/acp-agent-protocol-stream.test.ts test/unit/infrastructure/acp/local-acp-agent-executor.test.ts`.
- **Expected evidence**: Tool calls, permission requests, client filesystem, terminal, elicitation,
  MCP, extension, and unknown method activity produce fixed categories and termination.
- **Does not promise**: proof of an agent's unobservable internal intent.

### Criterion 6: Filesystem and network containment

- **Type**: Runtime security boundary.
- **Command**: `npx vitest run --config vitest.runtime.config.ts test/runtime/acp-agent-sandbox.runtime.test.ts`.
- **Expected evidence**: A real Linux Sandbox Runtime process cannot read project, home, Flow,
  protected, or credential files; writes succeed only in private state; unlisted network fails.
- **Does not promise**: privileged-host, hostile-kernel, or hostile same-user isolation.

### Criterion 7: One non-disclosing credential lease

- **Type**: Runtime security and data contract.
- **Command**: `npx vitest run --config vitest.runtime.config.ts test/runtime/acp-agent-sandbox.runtime.test.ts && npx vitest run test/unit/cli/public-output.test.ts`.
- **Expected evidence**: The selected child variable contains only a sentinel, unselected variables
  are absent, the real value reaches only the allowed TLS host, and secret scanning finds no value
  in events, errors, output, or public evidence.
- **Does not promise**: a general credential broker or arbitrary proxy compatibility.

### Criterion 8: Bounded failures and confirmed termination

- **Type**: Error handling and runtime behavior.
- **Command**: `npx vitest run test/unit/infrastructure/acp/local-acp-agent-executor.test.ts && npx vitest run --config vitest.runtime.config.ts test/runtime/acp-agent-sandbox.runtime.test.ts`.
- **Expected evidence**: Timeout, cancellation, malformed frames, output contamination, aggregate
  overflow, EOF, and descendants settle with fixed failures and an absent process group.
- **Does not promise**: termination of remote provider processes.

### Criterion 9: Open-effect uncertainty

- **Type**: Recovery and error handling.
- **Command**: `npx vitest run test/unit/infrastructure/acp/local-acp-agent-executor.test.ts test/unit/application/run-workflow-model-session.test.ts`.
- **Expected evidence**: Disconnect after observed tool or permission activity records unknown
  side-effect status and a nonretryable outcome.
- **Does not promise**: reconciliation of opaque agent-owned effects.

### Criterion 10: Provider-neutral success evidence

- **Type**: Schema, replay, and data processing.
- **Command**: `npx vitest run test/unit/infrastructure/acp/local-acp-agent-executor.test.ts test/unit/run/reducer.test.ts test/unit/cli/public-output.test.ts test/unit/application/evaluation-adapter.test.ts`.
- **Expected evidence**: Success records exact executor and sandbox provenance, private session
  binding, confirmed termination, and independently complete or unavailable token and cost data.
- **Does not promise**: durable raw ACP transcripts or inferred provider pricing.

### Criterion 11: Embedded Pi regression

- **Type**: Behavioral regression.
- **Command**: `npx vitest run test/unit/infrastructure/runtime/production-node-executor.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts test/integration/pi/pi-agent-executor.test.ts`.
- **Expected evidence**: Runs without `acpAgent` construct and execute the existing Pi path with
  unchanged observable requests and evidence.
- **Does not promise**: changes or enhancements to Pi.

### Criterion 12: Hosted Linux x64 containment

- **Type**: Hosted runtime verification.
- **Command**: `npm run ci:local` on the repository's Ubuntu 24.04 x64 CI job.
- **Expected evidence**: The dedicated runtime suite and all local release gates pass with real
  bubblewrap, network namespace, credential proxy, and process-tree cleanup.
- **Does not promise**: equivalent macOS containment or VM-grade isolation.
