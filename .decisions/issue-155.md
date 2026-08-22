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

3. **Record** — Flow writes the effective profile to the first durable run event before external
   work starts. This includes model, tool, and supervisor-worker work.

4. **Guide** — Before each model-backed attempt, Flow supplies the effective profile and one
   point-in-time view of the existing remaining run budget. Missing dimensions are identified as
   unbounded. The view cannot update the ledger or change admission.

5. **Inspect** — Public run, inspect, and event output shows the effective profile. It does not add
   provider state, capability contents, credentials, or other private data.

6. **Resume** — Recovery replays the durable profile. An omitted resume selection accepts that
   identity. A conflicting explicit selection fails before new work.

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

- Attached, detached, recovery, and child paths enter one scheduler and preserve one
  provider-neutral contract.

### Research conclusions

- DeepSeek Harness uses “profile” for boot-time plugin composition, so Flow uses explicit work
  profile names for this different concept.

- DeepSeek Harness derives its model surface from an append-only session log, while Flow derives
  profile context from authoritative run state.

- ACP session options are mutable agent-defined settings, so they cannot promote the durable Flow
  profile.

- Provider reasoning and completion-token settings remain unchanged per-request model controls.

## Decision

### Considered approaches

| Approach | Summary | Advantages | Disadvantages | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| A: Built-in numeric profile ceilings | Map each profile to a complete five-dimensional budget and combine it with workflow limits. | Immediately bounds unbudgeted work. Uses simple operator vocabulary. | Makes arbitrary cross-provider numbers a public policy contract. Changes legacy enforcement. Can confuse reported cost with prepaid authority. | Medium | High |
| B: Durable identity and read-only context | Record a closed profile identity and show the model the existing remaining workflow budget without changing it. | Preserves compatibility and provider neutrality. Separates guidance from authority. Prepares later session records. | Guides pacing rather than guaranteeing different resource use. Unbudgeted dimensions remain unbounded. | Medium | Low |
| C: Operator-configured profile catalog | Resolve profiles from project or machine configuration and freeze the resulting descriptor. | Supports team and provider customization. | Adds machine-specific semantics and configuration drift. Adds recovery and trust boundaries before user evidence justifies them. | Large | Medium |
| D: Policy-package aliases | Express each profile through signed policy packages. | Reuses trusted narrowing and composition. | Couples work posture to capability policy. Makes ordinary profile selection operationally heavy. Still lacks a model-facing budget view. | Large | Medium |

**Approved approach**: B, a durable provider-neutral identity plus bounded read-only budget context.

`standard` is the deterministic default. An explicit operator selection overrides the workflow
preference only when starting a new run. Recovery accepts no selection or the exact durable value.
It rejects a different selection. The effective root selection propagates to every child run.

Profiles do not contain numeric defaults. They do not alter the compiled budget, scheduler,
approval operation, tool set, model choice, reasoning effort, timeout, accounting, or terminal
status. They communicate a fixed pacing posture:

- `fast`: prioritize the shortest adequate path and early decisive evidence.
- `standard`: balance completeness, verification, and resource use.
- `long`: permit broader investigation and deeper verification within the same existing authority.

The application creates one structured context snapshot from `RunState` after current scheduling
events have been committed. Infrastructure renders that fixed data for model-backed agent and
verifier attempts. Concurrent attempts can receive the same conservative post-admission snapshot.
Flow does not invent reservations for usage that has not settled.

### Consequences

- Every new and legacy-replayed run has a visible effective work profile without adding hidden
  enforcement.

- Explicit workflow profiles affect the workflow digest. The omitted default does not change a
  legacy compiled workflow digest.

- A resumed run cannot change profile, even if the workflow file or CLI default changes.

- Child runs use the root run profile. A child workflow declaration cannot silently promote it.

- Models can pace work using truthful remaining values, but provider behavior is not guaranteed.

- ACP can later project this profile read-only without owning it as configuration.

## Specification

_Captured by the specification-capture skill on 2026-08-22. Source: Issue #155 and the
user-approved Approach B._

### Non-goals

- This slice does not assign numeric budgets to `fast`, `standard`, or `long`.

- This slice does not change any resource, execution, capability, model, approval, or terminal-state
  authority.

- This slice does not guarantee that a provider or model uses fewer or more resources because of a
  profile label.

- This slice does not add phase-aware model routing, provider-specific request settings, session
  compaction, or a provider-neutral session event log.

- This slice does not expose work profile as writable ACP session configuration.

- No mutable project profile catalogs or signed profile packages.

### Failure modes

- **Timeouts** — Profile rendering performs no I/O and introduces no new deadline. Existing
  workflow, provider, command, and supervisor deadlines remain authoritative.

- **Partial failures** — A new run writes its effective profile in `run_started` before external
  work. A failed append creates no model request. Recovery derives one value from the durable
  event. It does not consult transient provider state.

- **Invalid input** — Unknown source values and CLI values fail strict validation before run or
  detached-job creation. Unknown persisted values fail event parsing and replay.

- **Missing context** — An omitted workflow and operator selection resolves to `standard`. An
  omitted budget renders every absent dimension as `unbounded`. Flow never invents a remaining
  number.

- **Recovery mismatch** — A conflicting explicit resume value returns a fixed workflow-mismatch
  error. It starts no model, tool, approval, or child run.

- **Concurrent work** — Each attempt receives an immutable point-in-time snapshot after the
  scheduler's current durable start events. Unsettled concurrent usage is absent rather than
  estimated.

- **Resource exhaustion** — Context rendering has a fixed schema, five fixed dimensions, closed
  labels, and safe-integer values already validated by replay. It does not add another resource
  counter.

- **Host or provider drift** — Resume uses the ledger profile and Flow budget state. Local ACP,
  provider, session, or capability configuration cannot substitute a new value.

### Interface contracts

- `WorkProfile` is exactly `fast | standard | long`. The public default is `standard`.

- Workflow source may declare optional `workProfile`. Its compiled representation is present only
  when declared so omitted legacy workflow digests remain stable.

- `flow run --work-profile <value>` selects the effective profile for a new attached or detached
  run. Workflow declaration is the fallback and `standard` is the final fallback.

- Resume accepts an optional explicit value only when it equals the durable profile. Omitting it
  reuses the durable value.

- New `run_started` events carry `workProfile`. Event parsing accepts its absence only for legacy
  ledgers and replays it as `standard`. `RunState.workProfile` is always present.

- Child `run_started` events carry the inherited effective root profile.

- The model context has one closed profile value and five remaining values. They cover node starts,
  model tokens, reported cost, active execution time, and retained-artifact bytes.

- Each remaining value is a non-negative safe integer or the literal `unbounded`.

- The context states that it is guidance only and cannot change Flow policy, budget, scheduling,
  tool, model, or approval authority.

- Public output contains the profile string but does not expose the private capability snapshot or
  model context block.

## Criterion verification map

All criteria inherit the non-goals above.

| Criterion | Type | Verification command | Expected evidence |
| --- | --- | --- | --- |
| Strict workflow and operator selection | Contract and error | `npx vitest run test/unit/workflow/compiler.test.ts test/unit/run/work-profile.test.ts test/integration/cli/main.test.ts -t 'work profile'` | Closed values compile, omitted source resolves to `standard`, operator selection wins for new runs, and invalid values create no run or detached job. |
| Durable replay and recovery | Data and recovery | `npx vitest run test/unit/run/budget-reducer.test.ts test/unit/application/run-workflow.test.ts` | New events bind the effective value, legacy events replay as `standard`, exact recovery passes, and a conflict invokes no executor. |
| Attached, detached, and child propagation | Integration and lifecycle | `npx vitest run test/unit/application/run-workflow.test.ts test/unit/application/run-workflow-child.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts -t 'profile'` | One effective value crosses foreground, job, worker, replay, and child boundaries without provider or model substitution. |
| Bounded model-facing budget view | Behavior and privacy | `npx vitest run test/unit/run/work-profile.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts test/unit/application/verifier-executor.test.ts -t 'work profile'` | Every model-backed attempt receives one fixed five-dimension context; absent limits say `unbounded`; private canaries and extra fields are absent. |
| Informational non-authority | Authority and behavior | `npx vitest run test/unit/application/run-workflow-work-profile.test.ts test/unit/run/work-profile.test.ts -t 'informational|does not change'` | The three profiles produce identical budget, scheduling, model, tool, approval, accounting, and terminal behavior for the same workflow. |
| Public output and documentation | Public contract and documentation | `npx vitest run test/unit/cli/public-output.test.ts test/integration/cli/main.test.ts` plus the three documentation scripts below | Run, inspect, and event views show the profile. Documentation uses the exact public vocabulary and passes every style gate. |
| Complete package remains releasable | Regression | `npm run check && npm run test:coverage && npm run test:runtime && npm run pack:check && npm audit --omit=dev --audit-level=low` | Static, complete, coverage, runtime, package-consumer, and dependency gates pass without provider credentials. |

## Implementation plan

1. Add the closed work-profile domain contract and optional workflow declaration. Add the durable
   event field, replay default, public run state, and recovery mismatch checks with RED tests.

2. Add attached CLI selection, detached command propagation, worker handoff, and exact child
   inheritance with RED integration tests.

3. Add the structured five-dimension point-in-time context. Render it for agent and model verifier
   attempts with RED boundary, privacy, and non-authority tests.

4. Update public workflow, CLI, architecture, recovery, security, testing, example, roadmap, and
   README routing only where reader navigation requires it.

5. Run the mapped selector, full serial shards, coverage shards, runtime, documentation, build,
   package, dependency, and adversarial review gates. Merge only after review has no P1, P2, or P3
   findings.

## Research references

- [DeepSeek Harness profiles and bundles](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

- [DeepSeek Harness append-only session source](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md)

- [ACP stabilized session configuration options](https://agentclientprotocol.com/announcements/session-config-options-stabilized)

- [ACP session configuration design](https://agentclientprotocol.com/rfds/session-config-options)

## Final evidence

Status: complete and locally verified on 2026-08-22.

### Criterion selector

The exact mapped selector passed 370 tests across 14 files:

```sh
npx vitest run \
  test/unit/workflow/compiler.test.ts \
  test/unit/run/work-profile.test.ts \
  test/unit/run/budget-reducer.test.ts \
  test/unit/application/run-workflow-work-profile.test.ts \
  test/unit/application/run-workflow-child.test.ts \
  test/unit/application/run-workflow.test.ts \
  test/unit/application/verifier-executor.test.ts \
  test/unit/infrastructure/pi/pi-agent-executor.test.ts \
  test/unit/cli/public-output.test.ts \
  test/unit/supervisor/protocol.test.ts \
  test/unit/supervisor/records.test.ts \
  test/integration/cli/main.test.ts \
  test/integration/supervisor/service.test.ts \
  test/integration/supervisor/worker.test.ts
```

The compiled detached-process proof passed one selected runtime test:

```sh
npm run test:runtime -- \
  -t "runs detached work beyond the client and replays it from another CLI"
```

### Repository-wide evidence

- `npm run test:coverage` passed 4,974 tests and skipped 4 tests across 364 test files.
- Coverage reached 85.00% statements, 79.55% branches, 91.58% functions, and 85.25% lines.
- `npm run test:browser` passed 2 tests.
- `npm run test:runtime` passed 44 tests and skipped 37 environment-dependent tests.
- `node scripts/smoke-compiled.mjs` passed with local Unix-socket permission.

### Packaging and dependency evidence

- `npm run pack:check` verified clean installation and execution from the generated tarball.
- The root dependency audit found no vulnerabilities.
- The Prime dependency audit passed for the Node lock and 60 Python packages.

### Static and documentation evidence

- `npm run format:check`, `npm run typecheck`, and `npm run build` passed.
- `npm run lint` passed with one pre-existing informational notice in
  `src/application/external-harness-adapter.ts`.
- `npm run docs:style`, `npm run docs:links`, and `npm run docs:ste` passed.
- The architecture and community-file tests passed 35 tests across 2 files.
- `git diff --check` passed.

### Environment boundary

The local host used Node 26.7.0. Its Docker Desktop runtime was Linux arm64 Docker 29.7.2 with runc
1.3.6. It cannot prove the pinned Linux x64 Docker 28.3.3 and runc 1.2.5 Prime contract. The pull
request CI job remains the required proof for that environment before merge.

### Review result

The adversarial review found four P2 verification gaps. The fix-forward added legacy event
projection, profile-bound command idempotency, duplicate resume grammar, and detached recovery
identity evidence. The final spec, security, correctness, error, performance, maintainability, and
holdout passes found no unresolved P1, P2, or P3 issue.
