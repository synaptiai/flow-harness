# Decision journal: Issue #151 — Maintain a durable revisioned goal workspace

**Issue**: #151
**Branch**: `codex/issue-151-goal-workspace`
**Started**: 2026-08-21

## Exploration

### User, operator, and system flows

1. **Initialize** — An operator writes one bounded workspace document and receives revision `1`
   with its exact digest.
2. **Inspect** — An operator reads the current public revision or a bounded page of immutable
   history without loading referenced private evidence.
3. **Update** — An operator submits a complete replacement document with the expected current
   revision and digest. Flow either commits one new revision or changes nothing.
4. **Run** — An operator explicitly selects the current goal workspace for a workflow run. Flow
   freezes the selected revision into durable run history and presents its bounded context to agent
   nodes.
5. **Recover** — Flow replays committed workspace or run records. Recovery does not start a new run,
   resume a run, update the workspace, or mark a workflow complete.

### Existing patterns

- Workflow completion already belongs to the deterministic goal and criterion reducer.
- Run history is an append-only JSONL ledger with contiguous sequence validation, bounded records,
  durable writes, and fail-closed replay.
- Selected Agent Skills, effective-harness state, supplemental memory, policy packages, and the
  language-server identity already travel in one durable capability snapshot.
- Public run output already projects private package and semantic-query contents away from the
  durable internal record.

### Research conclusions

- DeepSeek Harness persists an append-only typed session-event log as the source of truth and uses
  full request snapshots when replay must reconstruct an exact surface.
- LangGraph separates thread-scoped checkpoints from a cross-thread store. A project goal workspace
  is cross-run state and does not belong inside one run ledger.
- RFC 9110 strong validators provide the lost-update semantics required for compare-and-set updates.
- RFC 8785 canonical JSON supports repeatable revision digests.
- W3C PROV models derivation as a new entity related to prior entities and activities. Goal-workspace
  verified facts therefore retain evidence references rather than copying evidence contents.

## Decision

### Considered approaches

| Approach | Summary | Advantages | Disadvantages | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| A: Mutable snapshot | Atomically replace one current workspace file. | Smallest implementation and fastest current reads. | No durable history; weak recovery explanation; audit behavior differs from Flow run ledgers. | Small | Medium |
| B: Append-only full revisions | Keep a separate project ledger whose events contain complete immutable workspace revisions. | Strong audit and replay; one source of truth; exact CAS; aligns with existing Flow and external event-log patterns. | More validation, locking, and bounded-history tests. | Medium | Low |
| C: Run-ledger workspace | Append workspace updates to whichever run is active. | Reuses an existing store. | Wrong scope; no single cross-run current state; conflates context with workflow authority and recovery. | Medium | High |
| D: Snapshot plus audit log | Maintain a mutable current file and a second history log. | Fast reads and explicit history. | Two sources of truth require cross-file atomicity and create reconciliation ambiguity. | Large | High |

**Approved approach**: B, append-only full revisions.

The workspace ledger is project-scoped and independent from run ledgers. Each revision includes the
complete bounded state, its predecessor digest, and its own canonical digest. Updates hold one local
writer lease while checking the exact expected revision identity and appending the next record. A
run explicitly selected with `--goal-workspace` freezes the current revision into the existing
capability snapshot. Resume, detached execution, and child execution use only that durable snapshot.

### Consequences

- Current reads require replay of a bounded ledger rather than reading one mutable file.
- Full snapshots make every committed revision independently understandable and avoid patch replay
  ambiguity.
- The capability snapshot remains the exact selected run surface. A goal workspace adds context but
  does not add package, tool, policy, budget, transition, or completion authority.
- A later compaction design can add a verified checkpoint event without changing the revision model.

## Specification

_Captured by the specification-capture skill on 2026-08-21. Source: user-confirmed architecture and
Issue #151._

### Non-goals

- The workspace does not mark workflow goals or criteria accepted, rejected, or complete.
- The workspace does not start, resume, retry, or continue a run after recovery.
- A model cannot create, update, select, or activate a workspace revision.
- This slice does not provide multiple named workspaces, remote synchronization, collaboration, or
  automatic merge conflict resolution.
- This slice does not retain raw run evidence or oversized artifacts outside their existing stores.
- The workspace does not grant tools, packages, model routes, budgets, filesystem access, network
  access, approval, or policy authority.
- ACP remains a presentation or future executor transport and is not the workspace persistence
  protocol.

### Failure modes

- **Timeouts and cancellation** — Local reads and evidence resolution observe the caller signal at
  asynchronous boundaries. Cancellation before durable append changes no state. No background retry
  starts.
- **Partial failures** — Replay may ignore only an unterminated final JSONL fragment. Invalid
  committed records fail closed. A mutation truncates an uncommitted tail only while holding the
  writer lease. An append with unresolved settlement returns a fixed uncertainty error.
- **Invalid input** — Strict YAML or JSON parsing rejects aliases, duplicate keys, invalid Unicode,
  unknown fields, invalid identifiers, duplicate entries, invalid evidence references, and every
  byte or count excess before mutation.
- **Missing context** — Initialization and selection require a Flow project root. Missing workspace
  or referenced run evidence returns a fixed error and changes no state.
- **Concurrent updates** — One local writer lease encloses replay, CAS validation, and append. A stale
  expected revision or digest fails without mutation. Readers never treat an unterminated tail as
  committed.
- **Resource exhaustion** — Source bytes, entry counts, evidence references, revision bytes, total
  revisions, total ledger bytes, history page size, JSON depth, and JSON nodes have fixed limits.
- **Corruption** — A changed digest, broken predecessor link, noncontiguous revision, committed empty
  line, invalid schema, unsafe file identity, or exceeded bound rejects the complete read.
- **Settlement uncertainty** — Flow reopens the ledger after an append failure. It returns success
  only if the exact prepared revision is committed; otherwise it reports a value-free uncertainty.
  Writer-lease release failure cannot be reported as clean success.

### Interface contracts

- A source document has API version `flow.synapti.ai/v1alpha1`, kind `GoalWorkspace`, one objective,
  bounded `facts`, `invariants`, `verifiedFacts`, `openQuestions`, and exactly one `nextAction`.
- Every list entry has a stable identifier and text. Each verified fact has one or more run-evidence
  locators. Admission resolves each locator to one immutable run event sequence and digest.
- A committed revision has version `1`, a positive contiguous revision, an optional predecessor
  digest only on revision `1`, a UTC timestamp, the complete workspace state, and a SHA-256 digest of
  its canonical content.
- `flow goal init <document>`, `flow goal show`, `flow goal history`, and `flow goal update <document>
  --expected-revision <n> --expected-digest <sha256>` are noninteractive and return JSON public views.
- `flow run ... --goal-workspace` and `flow validate ... --goal-workspace` explicitly select the
  current revision. Resume accepts no live-workspace selector and uses durable run history.
- Agent context contains the objective and text entries but no evidence locator contents,
  supplemental-memory contents, or run evidence. It states that the workspace is reference context
  and cannot override the node prompt or Flow authority.
- Public run and workspace projections may show revision identity and evidence locators, but never
  raw referenced evidence or supplemental-memory contents.

## Criterion verification map

All criteria inherit the non-goals above.

| Criterion | Type | Verification command | Expected evidence |
| --- | --- | --- | --- |
| Initialize bounded workspace | Contract and behavior | `npx vitest run test/unit/goal/goal-workspace.test.ts test/unit/application/goal-workspace.test.ts` | Exact-limit positives and invalid-schema, duplicate, Unicode, evidence, and limit negatives pass. |
| Exact CAS updates | Behavior and concurrency | `npx vitest run test/unit/infrastructure/fs/local-goal-workspace-store.test.ts` | Fresh init, exact update, stale revision/digest, concurrent writers, and no-mutation assertions pass. |
| Durable recovery | Error and data | `npx vitest run test/unit/infrastructure/fs/local-goal-workspace-store.test.ts` | Restart, torn tail, corruption, cancellation, bound, and settlement tests pass. |
| Safe current and history views | Behavior and privacy | `npx vitest run test/integration/cli/goal-workspace.test.ts test/unit/cli/public-output.test.ts` | Current, history, and run projections omit private evidence canaries, retain the safe allowlist, and enforce paging and project requirements. |
| Frozen run selection | Integration and replay | `npx vitest run test/integration/cli/goal-workspace.test.ts test/unit/application/run-workflow-capabilities.test.ts test/unit/application/run-workflow-child.test.ts test/integration/supervisor/worker.test.ts` | Foreground, detached, child, changed-live-state, missing-live-state, resume, and recovery use the exact durable revision. |
| Non-authoritative agent context | Security and behavior | `npx vitest run test/unit/application/run-workflow-capabilities.test.ts test/unit/application/run-workflow-child.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts` | Agents receive bounded context; completion, tools, budget, and policy remain unchanged; evidence contents stay absent. |
| Deterministic failures | Error and privacy | `npx vitest run test/unit/infrastructure/fs/local-goal-workspace-store.test.ts test/integration/cli/goal-workspace.test.ts` | Missing, invalid, stale, cancelled, exhausted, corrupt, and uncertain paths use fixed public errors and retain no private cause. |
| Public documentation | Documentation | `npm run docs:style`, `npm run docs:links`, and `npm run docs:ste` | All documentation gates pass and the architecture diagram, roadmap, project status, task guide, and README links agree. |

## Implementation plan

1. Add the bounded domain document, immutable revision, digest, public projection, and agent-context
   renderer with RED boundary and mutation tests.
2. Add evidence resolution against durable run events with RED missing, changed, private, and
   cancellation tests.
3. Add the bounded append-only project store with RED CAS, ownership, recovery, corruption,
   concurrency, resource, and settlement tests.
4. Bind an explicitly selected revision into capability snapshots and run replay with RED digest,
   combination, resume, child, and no-authority tests.
5. Add CLI initialize, update, show, history, validate-selection, and run-selection flows with RED
   privacy, grammar, offline detached, and frozen-recovery tests.
6. Update public documentation and architecture, run mapped and complete gates, conduct adversarial
   review, and merge only at zero P1/P2/P3 findings.

## Verification evidence

### Feature and documentation gates

- The exact 13-file portable selector passed 175 tests. It covers the domain, application,
  filesystem source and store, capability snapshot, run and child-run propagation, public output,
  agent prompt, CLI, and architecture documentation.
- The socket-backed supervisor worker suite passed 26 tests outside the restricted desktop
  sandbox.
- `npm run typecheck`, `npm run build`, `npm run format:check`, `npm run lint`,
  `npm run docs:style`, `npm run docs:links`, `npm run docs:ste`, and `git diff --check` passed. The
  linter reported one pre-existing informational constructor notice in
  `src/application/external-harness-adapter.ts`.
- The built CLI help command passed and listed the goal-workspace commands.
- `npm run pack:check` installed the generated package and ran its CLI successfully. The package
  archive SHA-256 digest was
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

### Repository-wide gates

- `npm run test:coverage -- --testTimeout=15000` passed 4,863 tests in 357 files, with four tests
  skipped and one file skipped. Coverage was 84.99% statements, 79.53% branches, 91.68% functions,
  and 85.18% lines.
- The standard-timeout serial test run passed 4,862 tests and skipped four. One unrelated
  filesystem artifact-limit test exceeded its 5-second test timeout. That test passed in isolation
  with a 15-second timeout. The unrelated language-server suite also passed 20 tests in isolation
  after the serial run emitted a teardown `EPIPE`.
- The runtime selector passed 37 tests in seven files and skipped 37 tests in 11 files, but seven
  timing-sensitive tests missed their local deadlines on this host. The native Pi runtime file
  passed three tests in isolation, with two skipped. The full CLI process file passed 13 of 16 tests
  in isolation; its remaining browser, capacity, and rebinding cases retained their existing
  hard-coded process deadlines. No goal-workspace runtime path failed.

These results establish the Issue #151 behavior and package boundary. The local runtime timing
exceptions remain explicit rather than being represented as passing evidence; hosted CI remains the
independent runtime gate.

## Adversarial review

Review covered specification compliance, execution authority, public-data projection, evidence
identity, snapshot replay, filesystem identity, compare-and-set behavior, cancellation, resource
bounds, crash settlement, documentation claims, and test mutation resistance.

The review found and fixed these defects before the final gate:

- Reusing one evidence locator in multiple verified facts caused a false duplicate-reference
  rejection.
- A backward revision timestamp could be appended before replay rejected it.
- A symbolic link at the project `.flow` path could redirect workspace-state creation.
- JSON containing an escaped lone surrogate could pass through YAML normalization.
- Ledger reads did not initially check cancellation between chunks or revalidate the pathname after
  reading the opened inode.
- Initial ledger creation could reconcile as successful before the containing directory entry was
  synchronized.
- The canonical source, canonical revision, history-page, and cumulative ledger boundaries needed
  exact-limit and limit-plus-one evidence.

The settled tree has zero current P1, P2, or P3 findings. The branch is ready for independent pull
request review and hosted CI.
