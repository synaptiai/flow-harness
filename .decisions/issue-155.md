# Decision journal: Issue #155 — Expose durable work profiles to model runs

**Issue**: #155
**Branch**: `codex/issue-155-work-profiles`
**Started**: 2026-08-22

## Exploration

### User, operator, and system flows

1. **Declare** — A workflow author can select `fast`, `standard`, or `long`. A workflow without a
   selection remains valid and resolves to `standard`.

2. **Override** — An operator can select one profile for a new attached or detached run. The
   operator selection takes precedence over the workflow preference.

3. **Record** — Flow writes the effective profile to the first durable run event before model,
   tool, supervisor-worker, or other external work starts.

4. **Guide** — Before each model-backed attempt, Flow supplies the effective profile and one
   point-in-time view of the existing remaining run budget. Missing dimensions are identified as
   unbounded. The view cannot update the ledger or change admission.

5. **Inspect** — Public run, inspect, and event output shows the effective profile. It does not add
   provider state, capability contents, credentials, or other private data.

6. **Resume** — Recovery replays the durable profile. An omitted resume selection accepts that
   identity; a conflicting explicit selection fails before new work.

7. **Run children** — Child runs inherit the root run's effective operator profile so one run tree
   cannot silently change posture. The child event records the inherited value independently.

### Existing patterns

- The workflow schema already owns strict author input and keeps omitted optional fields backward
  compatible.
- `run_started` is the durable source for workflow identity, budgets, capabilities, concurrency,
  execution workspace, recovery rules, and goals.
- `RunState.budget.remaining` already computes all five required dimensions from immutable limits
  and durable resource evidence.
- `NodeExecutionContext` carries Flow-owned goal-workspace and supplemental-memory projections to
  model infrastructure without giving those projections scheduler authority.
- Public run and event projection already strips private capability and source bytes.
- Attached, detached, recovery, and child paths all enter the same application scheduler, so the
  application boundary can preserve one profile contract without provider-specific state.

### Research conclusions

- DeepSeek Harness uses “profile” for a boot-time plugin composition, not a run budget or work
  posture. Flow therefore uses the explicit `workProfile` and `--work-profile` names rather than an
  ambiguous generic profile flag.
- DeepSeek Harness treats its append-only session log as source of truth and derives the model
  surface from it. Flow similarly derives the work-profile context from its authoritative run
  state instead of persisting a separate mutable prompt counter.
- ACP session configuration options standardize client-visible model, mode, and reasoning
  selectors. They are agent-defined mutable session configuration. Flow does not use them as work
  profile authority in this slice because the model or an ACP peer must not promote the durable
  Flow profile.
- Provider reasoning effort and completion-token settings are per-request model controls. They are
  not provider-neutral run profiles and remain unchanged.

## Decision

### Considered approaches

| Approach | Summary | Advantages | Disadvantages | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| A: Built-in numeric profile ceilings | Map each profile to a complete five-dimensional budget and combine it with workflow limits. | Immediately bounds unbudgeted work; simple operator vocabulary. | Makes arbitrary cross-provider numbers a public policy contract; changes legacy enforcement; can confuse reported cost with prepaid authority. | Medium | High |
| B: Durable identity and read-only context | Record a closed profile identity and show the model the existing remaining workflow budget without changing it. | Backward compatible; provider neutral; truthful; separates guidance from authority; prepares later session records. | Profiles guide pacing rather than guaranteeing different resource use; unbudgeted dimensions remain unbounded. | Medium | Low |
| C: Operator-configured profile catalog | Resolve profiles from project or machine configuration and freeze the resulting descriptor. | Flexible for teams and providers. | Machine-specific semantics weaken portability; adds configuration drift, recovery, and trust boundaries before user evidence justifies them. | Large | Medium |
| D: Policy-package aliases | Express each profile through signed policy packages. | Reuses trusted narrowing and composition. | Couples work posture to capability policy; makes ordinary profile selection operationally heavy; still lacks a model-facing budget view. | Large | Medium |

**Approved approach**: B, a durable provider-neutral identity plus bounded read-only budget context.

`standard` is the deterministic default. An explicit operator selection overrides the workflow
preference only when starting a new run. Recovery accepts no selection or the exact durable value;
it rejects a different selection. The effective root selection propagates to every child run.

Profiles do not contain numeric defaults. They do not alter the compiled budget, scheduler,
approval operation, tool set, model choice, reasoning effort, timeout, accounting, or terminal
status. They communicate a fixed pacing posture:

- `fast`: prioritize the shortest adequate path and early decisive evidence.
- `standard`: balance completeness, verification, and resource use.
- `long`: permit broader investigation and deeper verification within the same existing authority.

The application creates one structured context snapshot from `RunState` after current scheduling
events have been committed. Infrastructure renders that fixed data for model-backed agent and
verifier attempts. Concurrent attempts can receive the same conservative post-admission snapshot;
Flow does not invent reservations for usage that has not settled.

### Consequences

- Every new and legacy-replayed run has a visible effective work profile without adding hidden
  enforcement.
- Explicit workflow profiles affect the workflow digest. The omitted default does not change a
  legacy compiled workflow digest.
- A resumed run cannot change profile, even if the workflow file or CLI default changes.
- Child runs use the root run profile. A child workflow declaration cannot silently promote it.
- Models can pace work using truthful remaining values, but provider behavior is not guaranteed.
- ACP can project this profile read-only in a later compatibility slice; ACP configuration does not
  own it here.

## Specification

_Captured by the specification-capture skill on 2026-08-22. Source: Issue #155 and the
user-approved Approach B._

### Non-goals

- This slice does not assign numeric budgets to `fast`, `standard`, or `long`.
- This slice does not change workflow or policy limits, usage accounting, scheduling, concurrency,
  timeouts, approvals, tools, capabilities, model selection, reasoning effort, or terminal status.
- This slice does not guarantee that a provider or model uses fewer or more resources because of a
  profile label.
- This slice does not add phase-aware model routing, provider-specific request settings, session
  compaction, or a provider-neutral session event log.
- This slice does not expose work profile as writable ACP session configuration.
- This slice does not add mutable project profile catalogs or signed profile packages.

### Failure modes

- **Timeouts** — Profile rendering performs no I/O and introduces no new deadline. Existing
  workflow, provider, command, and supervisor deadlines remain authoritative.
- **Partial failures** — A new run writes its effective profile in `run_started` before external
  work. A failed append creates no model request. Recovery derives one value from the durable
  event; it does not consult transient provider state.
- **Invalid input** — Unknown source values and CLI values fail strict validation before run or
  detached-job creation. Unknown persisted values fail event parsing and replay.
- **Missing context** — An omitted workflow and operator selection resolves to `standard`. An
  omitted budget renders every absent dimension as `unbounded`; Flow never invents a remaining
  number.
- **Recovery mismatch** — An explicit resume value that differs from the durable profile returns a
  fixed workflow-mismatch error before a model, tool, approval, or child run starts.
- **Concurrent work** — Each attempt receives an immutable point-in-time snapshot after the
  scheduler's current durable start events. Unsettled concurrent usage is absent rather than
  estimated.
- **Resource exhaustion** — Context rendering has a fixed schema, five fixed dimensions, closed
  labels, and safe-integer values already validated by replay. It does not add another resource
  counter.
- **Host or provider drift** — Resume uses the ledger profile and Flow budget state. Local ACP,
  provider, session, or capability configuration cannot substitute a new value.

### Interface contracts

- `WorkProfile` is exactly `fast | standard | long`; the public default is `standard`.
- Workflow source may declare optional `workProfile`. Its compiled representation is present only
  when declared so omitted legacy workflow digests remain stable.
- `flow run --work-profile <value>` selects the effective profile for a new attached or detached
  run. Workflow declaration is the fallback and `standard` is the final fallback.
- Resume accepts an optional explicit value only when it equals the durable profile. Omitting it
  reuses the durable value.
- New `run_started` events carry `workProfile`. Event parsing accepts its absence only for legacy
  ledgers and replays it as `standard`. `RunState.workProfile` is always present.
- Child `run_started` events carry the inherited effective root profile.
- The model context has one closed profile value and exactly five remaining values: node starts,
  model tokens, reported cost in micro-USD, active execution milliseconds, and retained-artifact
  bytes. Each value is a non-negative safe integer or the literal `unbounded`.
- The context states that it is guidance only and cannot change Flow policy, budget, scheduling,
  tool, model, or approval authority.
- Public output contains the profile string but does not expose the private capability snapshot or
  model context block.

## Criterion verification map

All criteria inherit the non-goals above.

| Criterion | Type | Verification command | Expected evidence |
| --- | --- | --- | --- |
| Strict workflow and operator selection | Contract and error | `npx vitest run test/unit/workflow/compiler.test.ts test/unit/run/work-profile.test.ts test/integration/cli/main.test.ts -t 'work profile'` | Closed values compile, omitted source resolves to `standard`, operator selection wins for new runs, and invalid values create no run or detached job. |
| Durable replay and recovery | Data and recovery | `npx vitest run test/unit/run/work-profile.test.ts test/unit/application/run-workflow-work-profile.test.ts -t 'durable|recover|legacy|mismatch'` | New events bind the effective value, legacy events replay as `standard`, exact recovery passes, and a conflict invokes no executor. |
| Attached, detached, and child propagation | Integration and lifecycle | `npx vitest run test/unit/application/run-workflow-work-profile.test.ts test/unit/application/run-workflow-child.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts -t 'work profile'` | One effective value crosses foreground, job, worker, replay, and child boundaries without provider or model substitution. |
| Bounded model-facing budget view | Behavior and privacy | `npx vitest run test/unit/run/work-profile.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts test/unit/infrastructure/pi/model-verifier-executor.test.ts -t 'work profile'` | Every model-backed attempt receives one fixed five-dimension context; absent limits say `unbounded`; private canaries and extra fields are absent. |
| Informational non-authority | Authority and behavior | `npx vitest run test/unit/application/run-workflow-work-profile.test.ts test/unit/run/work-profile.test.ts -t 'informational|does not change'` | The three profiles produce identical budget, scheduling, model, tool, approval, accounting, and terminal behavior for the same workflow. |
| Public output and documentation | Public contract and documentation | `npx vitest run test/unit/cli/public-output.test.ts test/integration/cli/main.test.ts -t 'work profile' && npm run docs:style && npm run docs:links && npm run docs:ste` | Run, inspect, and event views show the profile; docs use the exact public vocabulary and pass all style gates. |
| Complete package remains releasable | Regression | `npm run check && npm run test:coverage && npm run test:runtime && npm run pack:check && npm audit --omit=dev --audit-level=low` | Static, complete, coverage, runtime, package-consumer, and dependency gates pass without provider credentials. |

## Implementation plan

1. Add the closed work-profile domain contract, optional workflow declaration, durable event field,
   replay default, public run state, and recovery mismatch checks with RED tests.

2. Add attached CLI selection, detached command propagation, worker handoff, and exact child
   inheritance with RED integration tests.

3. Add the structured five-dimension point-in-time context and render it for agent and model
   verifier attempts with RED boundary, privacy, and non-authority tests.

4. Update public workflow, CLI, architecture, recovery, security, testing, example, roadmap, and
   README routing only where reader navigation requires it.

5. Run the mapped selector, full serial shards, coverage shards, runtime, documentation, build,
   package, dependency, and adversarial review gates. Merge only after review has no P1, P2, or P3
   findings.

## Research references

- DeepSeek Harness profiles and bundles:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- DeepSeek Harness append-only session source of truth:
  <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
- ACP stabilized session configuration options:
  <https://agentclientprotocol.com/announcements/session-config-options-stabilized>
- ACP session configuration design:
  <https://agentclientprotocol.com/rfds/session-config-options>
