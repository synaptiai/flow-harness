# Decision Journal: Issue #20 — Durable run resource boundaries

**Issue**: #20 | **Branch**: `codex/issue-20-durable-run-budgets` | **Started**: 2026-08-07

---

## Context

Flow can bound one command or agent node, but it cannot yet state how much work an entire run may
consume. That omission is manageable for the current finite acyclic graph and unsafe for detached
supervision, retries, and loops. A restarted client must not forget prior tokens, cost, starts, or
active execution time, and provider-specific session files cannot be authoritative graph state.

Pi already exposes session-wide token, reported-cost, and tool-call statistics through
`getSessionStats()`. OMP exposes thinking-level token settings and per-tool timeouts. Prime Agent
separates detached supervision from worker execution and explicitly leaves fixed workload caps out
of its daemon layer. These are useful mechanisms and references, but none supplies Flow's durable,
provider-neutral, run-wide stop decision.

Model cost has an unavoidable settlement boundary: the runtime learns authoritative usage after a
provider response. Flow can refuse to schedule more work and can report exhaustion, but it cannot
truthfully promise a prepaid hard cap without provider-side reservation or an external billing
authority. Active execution time has a different boundary: Flow can reduce a node's effective
timeout to the remaining committed allowance before execution.

## Specification

_Captured from issue #20 and the architecture analysis on 2026-08-07._

### Non-goals

- Guaranteeing a prepaid, invoice-authoritative, or zero-overshoot model-cost cap.
- Adding CPU, memory, disk, network-byte, concurrency, or artifact-size quotas.
- Adding retries, graph loops, detached supervision, child runs, or multi-host reservation.
- Inferring provider prices, converting currency, issuing refunds, or reconciling invoices.
- Treating Pi, OMP, Prime Agent, or any provider transcript as authoritative run state.
- Persisting opaque provider sessions or changing the open-operation recovery policy.
- Counting human approval wait, client detachment, or process downtime as active execution.
- Adding per-tool, per-model, per-node, daily, account-wide, or organization-wide quota policy.
- Promising exact preemption at a model-token boundary inside a response already in flight.

### Failure modes

- **Timeouts** — Before a node or approval request, its effective timeout is no greater than the
  remaining active-execution allowance. Reaching that boundary records available node evidence and
  terminates without scheduling downstream work.
- **Partial failures** — Successful or failed node evidence contributes every available resource
  observation. A crash after node outcome but before the terminal budget event is recovered from
  the committed totals and reaches the same exhausted result.
- **Invalid input** — Unknown budget fields, empty budgets, non-finite numbers, non-positive values,
  fractional integer dimensions, excessive precision, and values outside safe bounds fail strict
  workflow compilation before run creation or execution.
- **Missing context** — Legacy workflows and ledgers with no budget remain unbounded. Agent work
  that fails before model usage becomes available records no invented usage; a successful current
  Pi session must provide a valid observation.
- **Malformed or tampered evidence** — Negative, fractional, overflowing, or structurally invalid
  resource observations fail event parsing or replay. Recovery refuses a persisted budget that
  differs from the exact compiled workflow.
- **Single-response overshoot** — The full observed response is committed conservatively; Flow
  records resource exhaustion and starts no downstream node. The amount is not truncated to the
  configured limit.
- **Boundary equality** — Consumption at a ceiling is exhausted for new applicable work. A model
  usage, reported-cost, or active-duration settlement that reaches a ceiling is terminal even if
  the just-finished node otherwise succeeded.
- **Cancellation races** — Cancellation may override node success but never erases evidence that
  the executor already returned. Once committed evidence exhausts a settlement limit, durable
  exhaustion takes precedence over a later cancellation signal in both scheduling and replay. A
  depleted start allowance likewise takes precedence while graph work remains pending, but does
  not replace an already-determined final success or failure.
- **Approval delay and expiry** — Waiting does not consume active time. The command operation shown
  for approval includes the budget-bounded timeout and recovery must reproduce that exact timeout.
  Grant expiry creates a fresh request only if a budget still permits the command.
- **Arithmetic overflow** — Token, micro-USD, start, and duration aggregation that cannot remain a
  non-negative safe integer fails replay instead of wrapping, saturating, or silently losing
  precision.
- **Concurrent clients** — Existing run ownership serializes resume and budget terminalization on
  one host. This slice provides no distributed reservation or cross-host consensus.

### Interface contracts

- A workflow may declare `budget` with one or more of `maxNodeStarts`, `maxModelTokens`,
  `maxCostUsd`, and `maxExecutionMs`. Presence is optional and strict; existing workflows retain
  their behavior.
- Public cost is a positive USD number with at most six decimal places. The compiler translates it
  to non-negative integer micro-USD for compiled state, digests, evidence aggregation, replay, and
  comparison.
- Model evidence may carry a Flow-owned usage observation containing non-negative safe-integer
  input, output, cache-read, and cache-write tokens plus reported micro-USD. Total tokens are
  derived, never accepted as redundant input.
- `run_started` captures the exact compiled budget. A recovered workflow must reproduce both its
  digest and budget independently; old events without a budget remain valid.
- Run state exposes immutable limits, consumption, remaining allowances, and every exhausted
  dimension. Duration consumption is the sum of each committed evidence duration rounded up to a
  whole millisecond; approval and detached wall time are absent by construction.
- `node_started` consumes one start. Node success and failure consume available evidence duration
  and model usage. Missing evidence consumes neither duration nor model usage.
- A dedicated terminal run outcome records resource exhaustion only when a configured dimension is
  at or above its exact durable limit and no node remains running. It rejects incomplete goals and
  cannot be followed by another event.
- The scheduler checks budget before creating approval requests or node starts and after committing
  node outcomes. It remains the only component that may choose a graph transition.
- A command or agent node is passed to its executor with an effective timeout equal to the lesser
  of its declared timeout and remaining active-execution allowance. A command approval operation
  binds this effective value, not a later recomputation from wall time.
- The Pi adapter translates `getSessionStats()` into Flow usage. No Pi type crosses the adapter or
  appears in workflow, event, run-state, CLI, or package contracts.
- CLI run, resume, and inspect output includes the provider-neutral budget state. Resource
  exhaustion exits non-zero and is never reported as success.

## User and system flows

### Declare and validate

1. A workflow author adds one or more run-wide limits in USD, tokens, starts, or milliseconds.
2. The compiler rejects malformed or empty declarations and translates accepted values to the
   compiled provider-neutral contract.
3. Flow records that exact budget with run start before any node or external effect.

### Execute within budget

1. The scheduler derives durable consumption from run state.
2. Before a ready node or approval request, it verifies that a new start is allowed and derives the
   remaining active-execution allowance.
3. The executor receives a budget-bounded timeout. The model runtime remains unaware of graph
   transitions and budget terminal status.
4. Flow commits the node outcome and all available usage before making another scheduling decision.

### Settle exhaustion

1. Replay adds the committed node start, duration, token components, and reported micro-USD using
   checked arithmetic.
2. If model, cost, or active time reaches its limit, Flow appends a terminal exhausted outcome.
3. No dependent node or approval request begins, and inspection shows both actual consumption and
   the limit rather than clipping overshoot.

### Inspect and recover

1. An operator inspects limits, consumption, remaining allowance, and exhausted dimensions from the
   Flow ledger without opening a provider transcript.
2. Resume validates the exact compiled workflow and budget, then replays committed observations.
3. If a prior process stopped after the node outcome but before terminalization, resume appends the
   same exhausted outcome. If an attempt remains open, the existing uncertain-operation rule still
   blocks recovery.

## Coupling analysis

- Workflow schema owns author-facing validation and compiled limits; it imports no runtime or store.
- Run domain owns provider-neutral usage, checked aggregation, remaining values, terminal
  exhaustion, and replay invariants; it imports no Pi, CLI, filesystem, or executor.
- The scheduler queries only Flow budget state, bounds an execution node, and records transitions.
  It does not calculate provider prices or inspect a session transcript.
- The approval domain hashes the scheduler-provided effective command operation. It remains unaware
  of why the timeout is smaller than the workflow declaration.
- The Pi adapter alone translates current `SessionStats`; fake and future executors can produce the
  same Flow evidence without depending on Pi.
- The JSONL store remains an append/claim/read/release mechanism and needs no budget-specific API.
- CLI inspection serializes RunState and therefore gains budget reporting without becoming an
  accounting authority.
- Dependency direction remains CLI/infrastructure → application → domain. No domain-to-runtime
  import or supervisor-only shared mutable counter is introduced.

## Options considered

| Option | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Flow-owned limits reduced from durable evidence | Provider-neutral, replayable, auditable, testable without credentials, shared by CLI and later supervisor | Requires event and scheduler work; provider settlement can overshoot one response | **Chosen** |
| Pi or OMP runtime settings | Proven per-session/per-tool controls and little Flow code | Runtime-specific, not graph-wide, not sufficient for replay or terminal semantics | Reuse as lower-level defense later, not authority |
| Supervisor-only in-memory counters | Simple detached-worker admission control | Lost on restart, bypassed by direct CLI runs, creates hidden shared state | Rejected |
| External billing or quota service | Can coordinate organizations and provider accounts | Adds network dependency, availability and identity problems, and still needs durable local evidence | Deferred integration boundary |
| OS or sandbox resource limits | Strong for CPU, memory, process, and filesystem containment | Cannot express model tokens, billed cost, graph starts, or evidence-based completion | Complementary future capability |

## Decision

Implement Flow-owned durable accounting and four run-wide limits: node starts, model tokens,
provider-reported cost, and active execution duration. Persist cost as integer micro-USD and round
committed evidence durations up to integer milliseconds. Preserve all observed overshoot rather
than clipping it.

Use Pi's current `getSessionStats()` only inside the adapter and translate its token components and
cost before returning. An absent observation is distinct from a zero observation. Current successful
Pi work must produce an observation; failures before a session or response exists may legitimately
have none.

Make resource exhaustion a distinct terminal run status rather than a synthetic successful node or
an overloaded cancellation. Check starts before work, and check model usage, reported cost, and
active duration after every committed node outcome. Do not let a start ceiling alone invalidate a
fully completed graph; it prevents the next applicable start. Other settlement ceilings are
terminal at equality because the resource is fully consumed.

Bound node execution by cloning the compiled node for that one executor call. For approval-required
commands, derive the bounded node before requesting consent so the operation digest, displayed
timeout, and later execution remain identical across detachment and recovery.

## Consequences

- Flow obtains a durable admission-control primitive needed by supervisors, retries, loops, and
  provider benchmarks.
- Cost reporting is conservative to the nearest micro-USD and remains provider-reported rather than
  invoice-authoritative.
- A final otherwise-successful model node that consumes its exact token or cost ceiling ends as
  resource-exhausted. Authors who need success at that usage must configure headroom.
- Failure evidence can terminate as resource-exhausted when it settles at a boundary; the node's
  original failure remains inspectable in node state.
- An approval operation may show a smaller timeout than the workflow node because it exposes the
  actual remaining authority.
- Existing unbudgeted compiled workflows and ledgers keep their current semantics.
- Artifact, concurrency, per-provider, and distributed quota policy remain separate capabilities.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict optional four-limit declaration | Contract/error | `npx vitest run test/unit/workflow/compiler.test.ts -t "budget"` | Valid combinations compile; empty, unknown, imprecise, unsafe, fractional, zero, negative, and non-finite values fail before execution | Provider price lookup |
| Legacy workflows and ledgers remain compatible | Compatibility | `npx vitest run test/unit/run/budget-reducer.test.ts test/unit/application/run-workflow-budget.test.ts -t "legacy|unbudgeted"` | Missing budget remains null/unbounded and existing execution succeeds | Stable pre-1.0 wire schema |
| Inspection reconstructs limits and consumption | Data | `npx vitest run test/unit/run/budget-reducer.test.ts test/integration/cli/main.test.ts -t "budget|resource exhausted"` | RunState and CLI JSON contain limits, consumed, remaining, and exhausted dimensions from events alone | External invoice reconciliation |
| Successful, failed, and cancelled model work is accounted | Behavioral | `npx vitest run test/unit/infrastructure/pi-agent-executor.test.ts test/unit/application/run-workflow-budget.test.ts test/unit/run/budget-reducer.test.ts -t "usage|failed model|cancellation"` | Pi stats translate; returned observations survive every node outcome and durable exhaustion outranks later cancellation | Usage unavailable before provider work |
| Active time excludes approval wait | Behavioral | `npx vitest run test/unit/application/run-workflow-budget.test.ts -t "approval wait|active execution"` | Large wall-clock gaps do not alter consumption; only evidence duration does | Trusted host time |
| Pre-start exhaustion invokes no executor | Safety | `npx vitest run test/unit/application/run-workflow-budget.test.ts -t "does not start|start limit"` | Exhausted run terminalizes with zero further executor calls or approval requests | Distributed admission control |
| Settlement exhaustion blocks downstream work | Lifecycle | `npx vitest run test/unit/application/run-workflow-budget.test.ts -t "settles|overshoot|equality"` | Full observation commits, exhausted status follows, dependent executor stays untouched | Zero-overshoot provider billing |
| Remaining duration bounds exact operation | Contract/recovery | `npx vitest run test/unit/application/run-workflow-budget.test.ts -t "remaining execution|approved timeout"` | Executor and approval digest use the same reduced timeout before and after detach | CPU-time accounting |
| Recovery reproduces consumption and terminal decision | Recovery | `npx vitest run test/unit/application/run-workflow-budget.test.ts test/unit/run/budget-reducer.test.ts -t "recover|resume|replay"` | Interrupted ledger reaches identical totals and exhaustion; open attempts remain blocked | Open-operation reconciliation |
| Malformed and tampered evidence fails closed | Error/evidence | `npx vitest run test/unit/run/budget-reducer.test.ts -t "rejects|overflow|tamper|mismatch"` | Schema, checked arithmetic, and recovery reject invalid usage or budget state | Cryptographic ledger authenticity |
| Public capability claims remain accurate | Documentation | `npx vitest run test/scaffold/community-files.test.ts` | README, architecture, recovery, workflow, security, roadmap, example, and testing docs match behavior | Future loop or daemon behavior |
| Complete package remains releasable | Regression | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Local CI-equivalent, coverage, compiled runtime, package, and audit checks pass | Live provider availability |

## Implementation tasks

1. [x] Add strict author-facing and compiled budget contracts with compatibility tests.
2. [x] Add provider-neutral usage evidence, checked replay aggregation, and terminal exhaustion events.
3. [x] Translate Pi session statistics on success, incomplete settlement, abort, timeout, and failure
   paths where observations are available.
4. [x] Enforce pre-start and post-settlement scheduler boundaries, including bounded node timeouts.
5. [x] Preserve exact approval operations and recovery checks under active-execution limits.
6. [x] Expose budget state through CLI behavior and add credential-free examples.
7. [x] Update all public architecture, workflow, recovery, security, roadmap, and testing claims.
8. [x] Run local CI, coverage, runtime, package, clean-consumer, dependency audit, and adversarial review.

## Verification results

- `npm run check`: 340 tests, production build, and 7 compiled-runtime tests passed.
- `npm run test:coverage`: 88.19% statements, 81.67% branches, 93.15% functions, and
  88.37% lines; every configured threshold passed.
- `NPM_CONFIG_CACHE=/tmp/flow-harness-npm-cache npm run pack:check`: the release artifact contains
  the compiled budget domain, CLI, documentation, and credential-free example.
- A clean temporary consumer installed the packed tarball, validated the published budget example,
  and ran it through the native sandbox. The run completed with two starts, reconstructed active
  duration, zero model usage, an exhausted final start allowance, and accepted goal evidence.
- `npm audit --omit=dev --audit-level=low`: zero production vulnerabilities.
- Three adversarial lifecycle findings were reproduced and fixed: cancellation can no longer erase
  settled executor evidence, a later cancellation can no longer relabel an already-exhausted
  settlement, and replay cannot relabel a pending graph after its start allowance is depleted.

## Research references

- Pi SDK and session management: <https://pi.dev/docs/latest/sdk>
- Pi session persistence: <https://pi.dev/docs/latest/sessions>
- Pi RPC and event surfaces: <https://pi.dev/docs/latest/rpc>
- OMP settings, thinking budgets, tool timeout, and approval configuration: <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>
- OMP advisor watchdog budgets: <https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md>
- Prime Agent worker and supervisor architecture: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
- Prime Agent daemon, leases, schedules, and recovery: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
