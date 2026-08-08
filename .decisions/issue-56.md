# Decision Journal: Issue #56 — Pause exact agent commands for per-call operator approval

**Issue**: #56 | **Branch**: `codex/issue-56-agent-command-approval` | **Started**: 2026-08-08
**Base dependency**: PR #55, commit `1a44ecd`

---

## Context and flow map

Issue #54 gave agent nodes a bounded `flow_exec` tool whose normalized command is authorized,
prepared, sandboxed, settled, and charged before its result returns to the model. The workflow
author still has only two choices: omit `exec`, or pre-authorize every exact command the model may
select during the node. The remaining Gate 3 gap is a point-of-use decision over the exact command
that exists only after the model emits a tool call.

### Author flow

1. The workflow author includes `exec` in the node's explicit tool list.
2. The author optionally declares that every `exec` call requires approval and sets a bounded grant
   lifetime.
3. Compilation freezes that declaration into the workflow and run-start recovery contract.
4. Nodes without the declaration retain the Issue #54 behavior.

### Agent flow

1. The model emits one strict `flow_exec` request.
2. Flow normalizes the executable, literal argv, and timeout and creates the exact operation digest.
3. Flow records the in-memory policy decision, then the active run owner appends the exact human
   approval request before command preparation, sandbox setup, or process spawn.
4. The Pi tool coroutine waits while the model turn remains active.
5. Approval continues through the existing write-ahead command, sandbox, and evidence path; denial
   becomes a bounded tool error that the same model turn can inspect.

### Operator flow

1. `flow inspect` exposes the pending request and exact command snapshot.
2. A second `flow approve` or `flow deny` process submits a decision for that request without taking
   ledger ownership from the active run.
3. The active owner validates and commits exactly one decision. Approval is then consumed by exactly
   one matching command preparation; denial starts no process.
4. The operator can detach before or during the wait because the run-owning worker retains the live
   agent session.

### System flow

```text
model flow_exec -> normalize + policy -> durable request -> wait for decision
                                                 ^              |
                                                 |              v
operator CLI -> exact decision sidecar -----------+       owner commits decision
                                                                |
                                   approve ---------------------+----> prepare -> sandbox
                                   deny ------------------------+----> bounded tool error
```

## Coupling analysis

- The workflow domain owns only the portable per-node declaration and its grant lifetime.
- The approval domain owns the provider-neutral exact operation, request identity, digest, actor,
  decision, expiry, and denial text.
- The run domain remains the replay authority. It owns request/decision/expiry events, the ordered
  per-attempt projection, single-use consumption, and terminal-history invariants.
- The application owns the live gate because it alone can serialize append operations and update
  the current replay-derived state while a node executor is active.
- The decision channel is an application port. A local filesystem implementation lets another CLI
  process submit one immutable decision without becoming a second event-ledger writer.
- The Pi adapter routes a policy-allowed request into the command recorder, which awaits the
  application gate before command preparation. It does not persist approvals or own operator
  policy.
- The supervisor requires no approval-specific RPC path. Attached and detached execution share the
  same run-local coordination contract, avoiding a detached-only feature.
- The existing command prepare event consumes the exact grant. This avoids a second command path
  and makes replay, inspection, artifact charging, containment, and cancellation reuse Issue #54.

Dependency direction remains CLI/infrastructure -> application ports -> domain. The domain imports
no Pi, supervisor, filesystem, or sandbox implementation types.

## Research and challenged assumptions

- Pi 0.84.0 deliberately has no built-in permission system. Its custom tool `execute()` returns a
  promise that the agent loop awaits, and the requested assistant tool-call message is finalized
  before execution begins. This makes a live Flow-owned wait possible without modifying Pi. Pi's
  persisted session format can resume completed turn boundaries, but an open assistant tool call
  is not the provider-neutral crash checkpoint this issue needs. See
  <https://github.com/earendil-works/pi> and the installed `pi-agent-core` event-flow docs.
- OMP separates a tool's read/write/exec tier from user `allow | prompt | deny` policy, supports
  argument-dependent safety overrides, and routes interactive ACP decisions back to the active
  runtime. This validates a per-call live gate. Flow adds exact digests, durable events, and
  single-writer consumption instead of importing OMP's TUI/client authority. See
  <https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md> and
  <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>.
- Prime Agent validates a daemon/worker boundary for detach and reattach, but its architecture says
  workers and kernels are lifecycle boundaries rather than security sandboxes. Model-generated
  Python and commands run with the worker's OS authority. Flow reuses the owner-worker continuity
  principle while retaining its stricter broker, approval, and sandbox layers. See
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
  and <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md>.
- Claude Code and OMP both support a separate permission-prompt client in non-interactive/protocol
  modes. That is useful precedent for separating UI from execution, but direct client-to-ledger
  writes would violate Flow's single-owner invariant. See
  <https://docs.anthropic.com/en/docs/claude-code/cli-usage>.
- The initial supervisor-RPC idea was rejected because it would work only for detached jobs. A
  run-local decision channel supports attached CLI execution, detached workers, child restrictions,
  and future alternative supervisors without moving durable authority into transport code.
- The initial session-checkpoint idea was rejected for this slice because it combines dynamic
  approval with opaque session continuation, expands Pi-specific persistence, and changes the
  failure model. A dead owner remains fail-closed with an open non-resumable exec attempt.

## Approaches considered

| Approach | Simplicity | Provider neutrality | Attached + detached | Crash recovery | Safety | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Live tool promise + durable run-local decision channel | Medium | High | Yes | Fail-closed, no continuation | High | **Selected** |
| Live tool promise + supervisor/ACP RPC | High | Medium | Detached only | Process remains required | Medium | Rejected |
| Abort, persist Pi session, and continue after approval | Low | Low/medium | Yes | Stronger | Potentially high | Deferred to Gate 4 |
| Restart a fresh model attempt with injected decision | Medium | High | Yes | Fresh retry only | Low for duplicate intent/effects | Rejected |
| Declarative allow/deny rules without a live prompt | High | High | Yes | Strong | High | Useful later; does not meet issue |

The selected approach reuses the most proven part of OMP and Claude Code—an active runtime waiting
on a per-call decision—while preserving Flow's event-sourced single-writer and exact-operation
contracts.

## Decision

Add an opt-in `agent.toolApproval.exec` declaration with mode `required` and a bounded grant lifetime.
When the model calls `flow_exec`, create one exact approval request for the normalized command and
pause the live tool coroutine. Another local process submits one immutable exact decision through a
run-local channel. Only the current run owner validates that submission and appends the approval
event. A valid unexpired grant must be referenced and consumed by the matching command preparation.

Denial is a tool-level result, not automatic run failure. Cancellation or the outer node deadline
closes the pending wait before any late grant can create spawn authority. If the owner exits while
the Pi turn is open, the existing execution-capable recovery rule blocks automatic resume; opaque
session continuation remains a separate roadmap item.

## Specification

_Captured by specification-capture skill on 2026-08-08. Source: extracted-from-issue._

### Non-goals

- Does not persist or resume an opaque provider or Pi session after the run-owning process exits.
- Does not add approval modes for filesystem edits, network tools, credentials, destructive tools,
  or third-party extensions.
- Does not replace sandbox containment, command evidence, workflow-level approval nodes, or
  deterministic command-node approval.
- Does not allow approval to broaden the tools or policy authority declared by the workflow.
- Does not add reusable command-pattern grants, session-wide allow rules, a yolo mode, remote
  approval services, or authenticated multi-user identity.

### Failure modes

- **Timeouts** — An expired grant or timed-out agent wait cannot start a process. The active turn
  receives a bounded failure/cancellation, and a late decision cannot reopen the request.
- **Partial failures** — If a decision is submitted but cannot be committed by the run owner,
  execution remains blocked and the durable request remains unresolved. A failed command prepare
  append after approval consumes no executable authority.
- **Invalid input** — Malformed, stale, duplicate, mismatched, forged, oversized, or non-current
  requests and decisions fail closed with a typed error and no command process.
- **Missing context** — Missing approval coordination, durable run ownership, sandbox execution, or
  command journaling prevents the command from starting.
- **Dependency outage** — Loss of the active owner leaves the open attempt non-resumable. A decision
  channel read failure keeps the live tool blocked until cancellation or timeout.
- **Resource exhaustion** — Request, decision, event, command-count, actor, reason, path, and wait
  data are bounded. Exceeding a bound rejects work before spawn.
- **Cancellation** — The owner commits a request cancellation before the node settles. A concurrent
  grant either wins serialization and remains subject to the already-aborted command signal, or
  loses and cannot authorize execution.
- **Concurrency** — `flow_exec` remains sequential per Pi turn, and human decision waits are
  serialized per run across concurrent agent nodes. Previously granted commands may prepare while
  the next exact request waits. Exactly one decision sidecar and one terminal approval event exist
  per request; competing submissions do not use last-writer-wins.
- **Tampering** — Replay rejects execution before grant, digest/attempt/request mismatch, grant reuse,
  duplicate decisions, decision after closure, altered operation snapshots, and terminal nodes with
  live approval grants.

### Interface contracts

Workflow declaration:

```yaml
agent:
  tools: [read, exec]
  toolApproval:
    exec:
      mode: required
      grantTtlMs: 300000
```

- `toolApproval.exec` is valid only when `exec` is selected. Its mode is exactly `required`; grant
  lifetime defaults to 300,000 ms and is a positive safe integer no greater than 86,400,000 ms.
- A request binds version, run/workflow/node/attempt, tool `exec`, absolute execution directory,
  normalized `{version, executable, args, timeoutMs}`, lowercase SHA-256 operation digest, request
  identity, request time, and grant lifetime.
- A decision submission binds version, request identity, operation digest, actor, approve/deny,
  optional denial reason, and submission time. It is coordination input, not ledger authority.
- The run owner appends exactly one granted, denied, expired, or cancelled terminal decision for a
  request. Approval includes an expiry derived from the committed decision time.
- A required command preparation carries the exact request id and operation digest of one unexpired
  grant. Replay atomically changes that grant to consumed; no other preparation may reuse it.
- Denial throws a bounded tool error after the denial event is durable. Command preparation,
  sandbox setup, and process spawn have not occurred; the pre-existing policy decision records the
  model's attempted operation but grants no process authority by itself.
- Attached and detached runs use the same decision-channel contract. The channel stores bounded
  per-request immutable submissions inside protected run state and does not permit agent access.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Opt-in workflow declaration | Contract/error | `npx vitest run test/unit/workflow/compiler.test.ts -t "agent.*approval"` | Required exec approval compiles, changes digest, and rejects missing exec/unknown modes/invalid TTL | Other tools or pattern policy |
| Exact durable pre-spawn request | Application/security | `npx vitest run test/unit/application/run-workflow-agent-command-approval.test.ts` | Request contains the complete command and no prepare/spawn occurs before decision | Opaque session checkpoint |
| Separate-process decision channel | Integration/runtime | `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "live agent-command denial" && npx vitest run test/integration/supervisor/worker.test.ts -t "detached agent tool"` | One attached owner process receives denial from a separate compiled CLI process; detached ownership consumes an exact external grant | Remote or multi-user approval |
| Exact, expiring, single-use grant | Domain/adversarial | `npx vitest run test/unit/run/agent-command-approval-reducer.test.ts` | Mismatch, stale grant, duplicate decision, early prepare, reuse, and tampering reject replay | Reusable policy grants |
| Denial returns to model without spawn | Pi/application | `npx vitest run test/unit/infrastructure/pi/pi-agent-executor.test.ts -t "production Pi loop" && npx vitest run test/integration/cli/main.test.ts -t "external live denial"` | The real pinned Pi loop receives a bounded error tool result; actor/reason are durable; preparation and executor are untouched | Whole-run failure on denial |
| Cancellation and timeout races | Application/adversarial | `npx vitest run test/unit/application/run-workflow-agent-command-approval.test.ts -t "aborted|expires" && npx vitest run test/unit/run/agent-command-approval-reducer.test.ts -t "aborted"` | Pending waits close, grants expire durably, and late decisions cannot start a command | Resuming after owner death |
| Inspection and docs | Integration/docs | `npx vitest run test/scaffold/community-files.test.ts -t "live agent command approval" && npm run build && node dist/cli/main.js validate examples/agent-command-approval.workflow.yaml` | Public docs state the owner, denial, recovery, security, and provider limitations; the example compiles and validates | TUI rendering |
| Full regression and package | Regression | `npm run check && npm run test:coverage && npm run pack:check` | All quality gates pass and coverage remains above project thresholds | Live provider credentials |

## Planned RED -> GREEN -> REFACTOR sequence

1. [x] Compile and digest the opt-in `exec` approval declaration.
2. [x] Define exact approval request/decision schemas and adversarial replay transitions.
3. [x] Add the bounded immutable local decision channel with concurrency and tamper tests.
4. [x] Add the application-owned live approval gate and exact command-grant consumption.
5. [x] Await the gate in `flow_exec` after policy allowance and before command preparation.
6. [x] Route external approve/deny decisions while the active owner retains the ledger.
7. [x] Cover denial, expiry, cancellation, timeout, append failure, and owner-loss behavior.
8. [x] Complete attached, detached, inspection, child restriction, and recovery verification.
9. [x] Update public architecture, workflow, security, recovery, roadmap, README, and example docs.
10. [x] Run focused, full, clean-room, package, holdout, and adversarial verification.

## Adversarial review cycle 1

- **P2 · live expiry poisoned publication** — fixed by committing
  `agent_command_approval_expired` inside the owner queue and throwing the bounded tool error only
  after publication succeeds. RED/GREEN coverage uses a valid 1 ms grant.
- **P2 · unbounded or non-regular decision input** — fixed with a 16 KiB bounded, non-blocking,
  no-follow regular-file reader before JSON parsing, plus oversized and symlink tests.
- **P2 · concurrent agent approvals poisoned publication** — fixed with a per-run decision queue,
  one pending request invariant, and exact grants that may prepare concurrently. Two admitted agent
  nodes now complete through distinct approvals.
- **P2 · replay exceeded the runtime attempt limit** — fixed by enforcing
  `MAX_AGENT_COMMANDS_PER_ATTEMPT` on approval requests, including denied calls, with an exact 32/33
  replay boundary test.
- **P3 · attached live-owner integration allegedly absent** — dropped after challenge. The existing
  CLI integration starts an attached run, waits for its durable request, submits through a second
  CLI composition, and verifies exact grant consumption.
- **P1 · cancellation could lose after a decision read** — fixed by checking cancellation after the
  bounded sidecar read, after the decision wait, and inside owner-serialized grant/deny publication.
  Race tests prove cancellation wins before decision commit while an already committed grant remains
  constrained by the aborted command signal.
- **P2 · separate-process denial was not exercised against a live owner** — fixed with an attached
  owner process that receives denial from a separate compiled CLI process, records actor/reason,
  returns the error to the live runner, and emits no prepare/settle command event.
- **P2 · the model-visible denial claim stopped at a fake runner** — fixed with the pinned production
  Pi `createAgentSession` and agent loop plus a deterministic in-process provider. The test observes
  `flow_exec` denial as `toolResult.isError`, verifies the bounded text, and proves the next model
  turn can revise without preparation or execution.
- **P2 · public docs/example lacked executable contract evidence** — fixed with a repository-contract
  test spanning README, architecture, workflow, recovery, roadmap, security, testing guidance, and
  compilation of the public example. The built CLI validation remains a release command.
- **P2 · invalid receipts and transport outages shared one terminal reason** — fixed with a
  provider-neutral typed decision-source error. Malformed or mismatched receipts close durably as
  `decision_invalid`; transient read failures retry with bounded abortable backoff until a valid
  receipt or enclosing cancellation/deadline. Unit and real-channel CLI integration prove both
  paths without command preparation.
- **P3 · lossy UTF-8 decoding could rewrite receipt attribution** — fixed with fatal UTF-8 decoding
  before JSON parsing. A raw-byte regression proves malformed actor bytes close as
  `decision_invalid` rather than becoming replacement characters in a durable grant.

## Final verification

- `npm run check` passed from a clean local clone of feature commit `fe54164`: formatting and lint
  checked 176 files, type checking passed, 104 test files with 1,349 tests passed, the build passed,
  and 3 runtime files with 21 process tests passed.
- `npm run test:coverage` passed on the final implementation with 84.16% statements, 78.21%
  branches, 93.44% functions, and 84.23% lines.
- `npm run pack:check` passed a clean tarball installation and CLI execution.
- The focused detached-worker approval test and the complete suite exposed a first-append polling
  race only in test observation. The helper now retries the exact transient empty-ledger window;
  all other corruption remains immediately visible, and the complete suite passes afterward.
- Independent holdout validation passed without conflicts. The adversarial reviewer reached zero
  actionable P1/P2/P3 findings, including a final targeted review of the polling-race correction.
