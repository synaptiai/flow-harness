# Decision Journal: Issue #28 — Typed interrupted-effect reconciliation

**Issue**: #28 | **Branch**: `codex/issue-28-typed-effect-reconciliation` | **Started**: 2026-08-07

---

## Context

Issue #25 established an acknowledged write-ahead protocol for Flow-owned hash-anchored edits. A
writable agent attempt now records a strict `filesystem.edit` descriptor before rename and records
an executor settlement after a known non-entry, acknowledged directory sync, or post-commit
failure. A process death can still leave the prepare event without a settlement. The current
recovery path exposes that open effect but rejects the whole attempt before appending anything.

The prepared descriptor contains enough evidence to classify the current target only for this one
typed effect: exact before and after SHA-256 values, the preserved POSIX permission mode, canonical
target, and operation identity. It does not contain proof that the provider response settled, that
Pi's session is resumable, that usage accounting is complete, or that the whole node finished.

Primary-source cross-checks preserve that separation. Pi and OMP store append-only session messages
and tool results, not authoritative external-effect state. Prime Agent records incomplete mutating
commands as uncertain and explicitly does not replay their side effects after worker recovery. AWS
durable-execution guidance likewise permits automatic re-execution only for idempotent operations;
an interrupted at-most-once step remains interrupted. Flow can therefore reconcile a supported
workspace observation without automatically retrying or continuing the open node.

## Specification

_Captured by specification-capture on 2026-08-07. Source: user-approved Gate 4 direction, Issue
#28, Issue #25's durable-effect contract, and primary-source recovery research._

### Non-goals

- This issue does not automatically retry, continue, fail, succeed, or otherwise terminalize the
  interrupted node attempt.
- This issue does not restore a Pi/OMP/Prime conversation or infer that a model response completed.
- This issue does not reconcile commands, provider requests, network calls, process creation,
  arbitrary filesystem operations, or edits not described by `flow.effects/v1`.
- This issue does not claim that observing the after-state proves the original directory sync was
  acknowledged; observed `applied` is distinct from executor-settled `committed`.
- This issue does not reuse approval grants, invent missing provider usage, add attempt two, or add
  retry/backoff budgets.
- This issue does not add multi-host coordination or defend the workspace from another process
  running as the same operating-system user. The existing same-host Flow lock remains coordination,
  not isolation.
- This issue does not mutate, repair, delete, rename, chmod, or rewrite the target during
  reconciliation.
- This issue does not change legacy ledgers or settled effects; only an open protocol-v1 edit is
  eligible.

### Failure modes

- **Timeouts and cancellation** — Observation is bounded by the existing 8 MiB edit-target limit,
  hashes only the initially observed size in 64 KiB chunks, and accepts the resume abort signal.
  Cancellation before durable publication leaves the effect open; no classification is invented.
  Filesystem calls do not gain a separate wall-clock timeout in this local slice.
- **Partial failures** — Each open effect is observed and durably published while its target lock is
  held. If later effects fail or the process stops, earlier events remain authoritative and later
  effects remain open for a future resume.
- **Invalid input** — Unknown event fields, invalid outcome/reason pairs, invalid observed hashes or
  modes, mismatched node/attempt/effect attribution, reconciliation of an unknown/already settled/
  already reconciled effect, or an observation contradicting its descriptor fail schema or replay.
- **Missing context** — An open effect with no production reconciler, an unsupported effect kind, or
  an attempt without the durable protocol fails closed before workflow continuation. Production
  composition always supplies the reconciler explicitly.
- **Target missing** — Record `unknown/target_missing`; do not create the target. If missing ancestry
  prevents the sibling lock from existing, publish only after a second observation remains missing
  under the in-process target queue; any observable target remains open.
- **Target non-regular** — Record `unknown/target_not_regular`; do not follow a symlink or read a
  device, socket, FIFO, or directory.
- **Target unreadable** — Record `unknown/target_unreadable` without persisting raw operating-system
  error text.
- **Target oversized** — Record `unknown/target_too_large` before reading bytes.
- **Content divergence** — Record the bounded observed SHA-256 and mode as
  `unknown/target_content_diverged`; never choose the nearer state.
- **Mode divergence** — If content exactly matches before or after but mode differs, record the
  observed digest and mode as `unknown/target_mode_diverged`.
- **Observation race** — If the opened file or target identity changes during inspection, record
  `unknown/target_changed_during_observation`. The same-user hostile-race limitation remains
  documented.
- **Target ownership contention** — A live, foreign-host, or malformed Flow target lock returns a
  typed busy failure and appends nothing. The effect stays open for a later resume.
- **Publication failure** — If the run store rejects the reconciliation event, the adapter releases
  its target lock and the effect remains open. A later resume can observe again; the target is never
  changed.
- **Lock release failure after publication** — The durable observation remains replayable and the
  current resume reports the coordination failure. Reconciliation is not duplicated on a later
  attempt.
- **Malformed history** — Workflow/history validation happens before any target lock, observation,
  or append.
- **Resource exhaustion** — Observation stores only fixed enums, one SHA-256, and one mode. It never
  persists target bytes or unbounded errors and never reads a regular target larger than 8 MiB.

### Interface contracts

- `node_effect_reconciled` references the exact running node, attempt, and still-open prepared
  effect. It is legal once and is mutually exclusive with executor `node_effect_settled`.
- Reconciliation outcomes are `applied`, `not_applied`, and `unknown`. Applied requires
  `target_matches_after`; not applied requires `target_matches_before`; unknown requires one of the
  bounded target-state reasons.
- Matching and divergence observations retain the observed lowercase SHA-256 and POSIX mode. Replay
  cross-checks exact matches and contradictions against the prepared descriptor.
- `NodeEffectRunState` retains executor settlement and recovery reconciliation as separate nullable
  fields. An effect is open only while both are null.
- A provider-neutral `NodeEffectReconciler` receives one typed descriptor and an acknowledged
  publication callback. It cannot construct run events or choose run, workflow, node, attempt,
  sequence, timestamp, or effect identity.
- The filesystem implementation invokes the publication callback exactly once while holding the
  same per-target in-process queue and same-host cross-process lock used by edits. The sole lockless
  exception is rechecked missing ancestry, where cooperating Flow edits can neither acquire their
  sibling lock nor create the missing target; no regular-file observation may use this fallback.
- Recovery validates the workflow and complete history before observation, processes open effects
  in attempt-local sequence order, applies each appended event through the reducer, and then rejects
  the still-running attempt as `uncertain_operation` without appending `run_resumed`.
- Repeating recovery skips both executor-settled and already-reconciled effects. It never calls the
  node executor while any attempt remains running.
- Detached workers preserve a typed recovery refusal together with the replayed authoritative run
  status. The worker and admission slot may terminate while the uncertain run remains `running`.

## User, operator, and system flows

### Operator: target matches the prepared after-state

1. The operator inspects an interrupted run and sees an open prepared edit.
2. The operator invokes resume with the exact workflow and execution directory.
3. Flow claims the run, validates the ledger and workflow, and coordinates access to the target.
4. The target's regular-file bytes and mode exactly match the prepared after-state.
5. Flow durably records an observed-applied recovery event while the target remains locked.
6. Resume returns `uncertain_operation`; inspect now explains the effect, while no model or node
   execution starts.

### Operator: target matches the prepared before-state

The same flow records observed-not-applied. This classification narrows the edit outcome but does
not prove that the provider turn is safe to retry, so the node remains open and recovery refuses
continuation.

### Operator: target is divergent or unavailable

Flow records a bounded unknown reason and any safe regular-file digest/mode evidence. It does not
modify the target, expose raw file bytes, or turn uncertainty into a retry decision.

### System: concurrent Flow edit

1. Reconciliation and normal edit enter the same target-keyed queue and cross-process lock.
2. Exactly one operation observes or mutates at a time.
3. Reconciliation publishes its event before releasing the lock; a later edit cannot invalidate the
   causal ordering between observed target state and the durable event.
4. A live external Flow owner yields `target_busy`; recovery records nothing and can be retried.

### System: multiple open effects and interruption

Flow processes effects by their durable `effectSequence`. Each publication is an independent fsync
boundary. If publication two fails after publication one succeeds, replay skips one and retries only
the still-open remainder.

## Options considered

| Option | Simplicity | Flexibility | Consistency and safety | Effort | Risk | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Add a distinct reconciliation event and publish it through an acknowledged callback under the existing target lock | Moderate | High; future effect kinds can provide adapters without gaining event authority | Strongest provenance; observation and ledger order are coordinated, while executor settlement remains semantically intact | Moderate | New schema and composition surface | **Selected by the user** |
| Extend `node_effect_settled` with recovery outcomes/source | Superficially high | Low; execution and recovery semantics become a growing union | Conflates acknowledged directory sync with later target observation and complicates terminal receipt projection | Low | Reviewers or future retry policy may over-credit observed state | Rejected |
| Store a reconciliation sidecar outside the run ledger | Moderate | Moderate | Splits authority, has no atomic order with run replay, and makes inspect/restart behavior depend on two stores | Moderate | Lost or contradictory sidecars | Rejected |
| Return an observation, release the target lock, then append in the application | High | Moderate | Leaves a race in which another Flow edit changes the target before evidence is durable | Low | Ledger can claim a stale current observation | Rejected |
| Restore the model session and automatically retry/continue the node | Low | Potentially high | Current evidence cannot prove provider usage, completion, approval validity, or whole-node idempotency | High | Duplicate model/tool effects and incorrect accounting | Deferred to explicit retry/session work |

## Decision

Introduce a recovery-specific event and state field. Keep the filesystem observation provider behind
a narrow application port and require its durable publication callback to run inside the existing
target queue and cross-process lock. Exact content and mode matching produces applied or not
applied; every other supported observation is unknown. The application remains the only owner of
event construction, sequence allocation, timestamps, store append, and reducer application.

Do not treat a recovery observation as an executor settlement. Specifically, observing the after
bytes does not prove the original directory fsync or model turn completed. After reconciling all
eligible open effects, retain the existing `uncertain_operation` refusal and do not append
`run_resumed`.

## Dependency and lock analysis

```text
CLI / detached worker
        |
        v
resumeWorkflow -- validates history, owns event identity/append/reducer
        |
        | NodeEffectReconciler + acknowledged publish callback
        v
filesystem reconciler
        |
        v
target queue -> cross-process target lock -> open/no-follow -> hash/mode -> append callback
                                                                    |
                                                                    v
                                                           release target lock
```

- Domain types import no application, filesystem, Pi, supervisor, or CLI modules.
- Application ports import domain descriptors/observations but no infrastructure types.
- Filesystem code cannot access the run store and cannot create raw events.
- Production CLI and detached-worker composition explicitly supply the same reconciler.
- Lock order remains target lock then run-ledger append, matching normal edit preparation and
  settlement. No application path holds an append lock while waiting for the target lock.
- Reconciliation serializes only per target; independent targets remain independent.
- The run claim prevents two schedulers from reconciling the same ledger concurrently. The target
  lock prevents a cooperating Flow edit from invalidating the target observation before append.

## Recovery state model

```text
node_effect_prepared
  |
  +-- node_effect_settled          # executor provenance
  |     +-- committed / directory_synced
  |     +-- not_applied / commit_not_entered
  |     `-- unknown / post_commit_failure
  |
  `-- node_effect_reconciled       # recovery provenance
        +-- applied / target_matches_after
        +-- not_applied / target_matches_before
        `-- unknown / bounded target-state reason

Neither branch proves the interrupted node completed.
```

Invariants:

1. Settlement and reconciliation are mutually exclusive and each may occur at most once.
2. Only the exact running protocol-v1 attempt may receive a reconciliation event.
3. Applied must reproduce the prepared after digest and mode exactly.
4. Not applied must reproduce the prepared before digest and mode exactly.
5. Content divergence must match neither prepared digest; mode divergence must match a prepared
   digest but differ from the prepared mode.
6. Missing/non-regular/unreadable/oversized/raced observations cannot masquerade as exact matches.
7. A reconciled effect remains in an open node attempt and cannot satisfy terminal receipt
   projection.
8. Reconciliation changes no run status, node status, resources, approvals, goal, or timestamps
   other than event sequence and reconciliation time.
9. Legacy attempts and executor-settled effects retain byte-for-byte replay behavior.
10. Repeating resume appends no second event for a resolved effect.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict event/state provenance, match validation, mutual exclusion, immutable replay | Contract/data | `npx vitest run test/unit/run/effect-reconciliation-reducer.test.ts` | Valid observations replay; malformed pairs, contradictory hashes/modes, duplicate/settled/unknown effects fail at the offending event | Filesystem truth or node retry |
| Exact before/after and bounded unknown target classifications | Integration/behavioral | `npx vitest run test/unit/infrastructure/fs/hash-anchored-reconciliation.test.ts` | Real files classify exact states and missing/nonregular/unreadable/oversized/divergent/raced states without mutation | Hostile same-user exclusion or reboot durability |
| Shared edit lock and callback-before-unlock ordering | Concurrency/integration | `npx vitest run test/unit/infrastructure/fs/hash-anchored-reconciliation.test.ts test/unit/infrastructure/fs/hash-anchored-edit.test.ts` | Edit and reconciliation cannot overtake; busy target appends nothing; publication completes before another edit enters | Multi-host coordination |
| Application ordering, partial progress, idempotency, fail-closed continuation | Behavioral/error | `npx vitest run test/unit/application/run-workflow-reconciliation.test.ts` | Effects process in sequence; durable prefix survives later failure; repeats skip resolved effects; executor and `run_resumed` remain absent | Automatic attempt terminalization |
| Real JSONL restart and inspectable provenance | Integration/data | `npx vitest run test/integration/fs/durable-effect-reconciliation.test.ts test/integration/cli/main.test.ts` | Reopened ledger exposes exact reconciliation; CLI returns uncertain and does not modify target or duplicate evidence | Live provider continuation |
| Production CLI and detached-worker composition | Integration/contract | `npx vitest run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts` | Foreground and detached resume supply the reconciler and preserve failure codes/evidence | Remote supervisor or multi-host workers |
| Public docs remain truthful | Contract/docs | `npx vitest run test/scaffold/community-files.test.ts` | README, architecture, recovery, workflow spec, security, testing, and roadmap agree on observed state versus retry | Gate 5 graph features |
| Full release compatibility | Release | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Static checks, all tests, build/runtime tests, coverage, clean install, and dependency audit pass | Paid-provider availability or hostile-host isolation |

## Planned RED → GREEN → REFACTOR sequence

1. **Domain RED** — Add focused event-schema and reducer tests for exact observations, provenance,
   contradictions, mutual exclusion, duplicate records, legacy replay, and immutable state.
2. **Domain GREEN/REFACTOR** — Add the strict event union/state projection and centralize descriptor
   cross-checks without altering status, resource, approval, or terminal semantics.
3. **Filesystem RED** — Exercise exact before/after, every unknown classification, no-follow and size
   bounds, callback ordering, edit/reconcile contention, publication rejection, and abort behavior on
   real temporary targets.
4. **Filesystem GREEN/REFACTOR** — Reuse the current target queue/lock and add bounded file-handle
   observation with no mutation.
5. **Application RED** — Prove history validation precedes observation, effects reconcile in order,
   durable partial progress is replay-safe, repeats are idempotent, failures stay open, and no
   executor/`run_resumed` event occurs.
6. **Application GREEN/REFACTOR** — Split compatibility validation from open-attempt refusal and add
   an application-owned publication callback.
7. **Composition/integration** — Supply the reconciler in foreground and detached workers, then
   reopen real JSONL state and exercise CLI inspection/recovery.
8. **Documentation and verification** — Update all public contracts, run the complete verification
   map and full release gates, perform adversarial review, and record evidence limitations.

## Research cross-checks

- Pi sessions persist JSONL message/tool-result history and tree branches, which is useful context
  but not proof of current workspace state.
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>
- OMP documents append-only session entries, context reconstruction, persistence, and storage
  bounds; its transcript remains distinct from Flow's authoritative external-effect ledger.
  <https://github.com/can1357/oh-my-pi/blob/main/docs/session.md>
- Prime Agent journals mutating commands before dispatch, reports incomplete results as uncertain,
  and does not replay uncertain side effects after worker recovery.
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
- AWS durable execution distinguishes at-least-once idempotent work from interrupted at-most-once
  side effects and warns that per-attempt semantics do not imply whole-workflow exactly-once.
  <https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/>
- AWS's Builders' Library recommends explicit idempotency identity and reconciliation when an
  acknowledgement is lost; payload similarity alone is not proof of original intent.
  <https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/>

## Decision log

- **2026-08-07 — Issue #22 merge and stack repair**: Squash-merged PR #24 after green CI and explicit
  user approval. Retargeting PR #26 exposed the expected ancestry conflict; replayed Issue #23 and
  Issue #25 onto the squash commit with unchanged tree hashes and published both using explicit
  force-with-lease guards.
- **2026-08-07 — Architecture selected**: User approved Gate 4 typed reconciliation. Selected a
  distinct recovery event with callback-under-lock publication and retained fail-closed open-node
  behavior.
- **2026-08-07 — RED/GREEN implementation**: Added strict reconciliation schema/replay invariants,
  ordered application publication, bounded filesystem observation, foreground and detached
  production composition, real JSONL recovery, and public contract updates. Each new behavior began
  with a focused failing test before implementation.
- **2026-08-07 — Adversarial review cycle 1**: Independent skeptic and verifier reviews agreed on
  three P2 filesystem gaps; a separate runtime review found one unchallenged P2 detached-state gap,
  and the skeptic found one P3 cross-process assertion gap. The disposition-only challenge round
  agreed with all paired findings. All five were fixed and independently reverified; no findings
  were dropped or escalated.

## Adversarial review cycle 1

Stage 1 mapped all eight Issue #28 acceptance criteria to the verification table above. Stage 2
produced the following consolidated findings:

| ID | Priority | Finding and evidence | Confidence / disposition | Resolution |
| --- | --- | --- | --- | --- |
| F1 | P2 | `src/infrastructure/fs/hash-anchored-edit.ts` used an unbounded `readFile()` after its initial size check | HIGH / consensus | Replaced with position-based 64 KiB hashing bounded to the initially observed size; added deterministic growth coverage |
| F2 | P2 | Platform-specific socket and `EIO` open failures escaped bounded non-regular/unreadable classification | HIGH / consensus | Added pre-open `lstat`, portable type classification, and bounded Node I/O-error mapping with real Unix-socket and injected-`EIO` tests |
| F3 | P2 | A deleted parent prevented sibling-lock creation before `target_missing` could be published | HIGH / consensus | Added a missing-ancestry-only fallback under the target queue; any observable target still fails without publication |
| F4 | P2 | Detached resume stored a generic failed worker even though authoritative run replay remained `running` | MEDIUM / unchallenged | Persisted a typed recovery code with replayed run status and taught admission release to preserve `running` without relabeling it failed |
| F5 | P3 | Callback ordering test proved only the in-process queue, not cross-process lock retention | HIGH / validated | Asserted the sibling lock exists during publication and disappears only after acknowledgement |

<!-- FLOW_REVIEW_CYCLE:1 FINDINGS:[F1|P2|resource-bound|src/infrastructure/fs/hash-anchored-edit.ts:423|resolved|HIGH|consensus,F2|P2|correctness|src/infrastructure/fs/hash-anchored-edit.ts:383|resolved|HIGH|consensus,F3|P2|correctness|src/infrastructure/fs/hash-anchored-edit.ts:132|resolved|HIGH|consensus,F4|P2|correctness|src/supervisor/worker.ts:215|resolved|MEDIUM|unchallenged,F5|P3|tests|test/unit/infrastructure/fs/hash-anchored-reconciliation.test.ts:265|resolved|HIGH|validated] -->
<!-- FLOW_RESOLUTION_CYCLE:1 RESOLVED:[F1,F2,F3,F4,F5] ESCALATED:[] -->

## Final verification evidence

- `npm run check`: format, lint, typecheck, 48 files / 584 tests, clean build, and 3 files / 20
  compiled runtime tests passed on the final PR #27 + Issue #28 stack.
- `npm run test:coverage`: statements 82.83%, branches 74.57%, functions 91.34%, lines 83.12%; all
  configured floors passed.
- `npm run pack:check`: a clean consumer installed `synaptiai-flow-harness-0.0.0.tgz`, executed the
  packaged CLI, initialized a project, and validated its effective policy digest.
- `npm audit --omit=dev --audit-level=low`: zero production dependency vulnerabilities.
- Focused reconciliation, supervisor, CLI, and public-document regression set: 9 files / 115 tests
  passed after adversarial fixes.
- PR #27 base CI at `ff905c9`: hosted `quality` and `dependency-audit` jobs passed before Issue #28
  publication.
