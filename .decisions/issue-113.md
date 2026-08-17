# Decision Journal: Issue #113 — Composable reviewed harness states

**Issue**: #113 | **Branch**: `codex/issue-113-effective-harness-states` | **Started**:
2026-08-17

---

## Context

Flow can evaluate, activate, inspect, execute, and roll back three Gate 7 candidate forms. These
forms cover prompts, one existing Agent Skill package, and one generated Agent Skill package. Each
activation artifact is a complete mutually exclusive selection for one workflow.

The current union preserves each individual activation safely. It does not preserve two reviewed
improvements in sequence. A prompt activation followed by an Agent Skill activation selects the
skill artifact and loses the prompt improvement for later runs. More sibling artifact kinds would
repeat this behavior for memory, sub-agent, and routing candidates.

Issue #113 introduces a composition contract before those later surfaces. It keeps evaluation,
activation, rollback, recovery, policy, and execution authority explicit.

## Current evidence

- `CapabilitySnapshot` permits at most one adaptive activation proof.

- One activation head selects one immutable artifact for each workflow.

- Active loading reconstructs a capability snapshot from only the selected artifact.

- Prompt and Agent Skill artifacts carry different complete workflow and package selections.

- Current candidate generation accepts a filesystem baseline. It does not accept the exact active
  harness state as a distinct baseline source.

- A run copies the selected workflow and capability snapshot into durable admission state. Later
  execution and recovery do not need the mutable activation head.

## User, operator, and system flows

### Sequential activation

1. The operator selects the current activation as a candidate baseline.

2. Flow captures one exact complete effective state and its current head identity.

3. Flow admits one supported candidate against that exact state.

4. Paired evaluation compares the complete baseline and candidate states under equal controls.

5. Preview returns content-free before and after identities plus one declared surface change.

6. Apply rechecks the complete current-head identity under mutation ownership.

7. Flow publishes the complete candidate state and advances the one workflow head.

8. Later execution uses the complete selected state without folding live deltas.

### Rollback

1. The operator selects one retained complete state.

2. Preview binds the exact current head and target.

3. Apply rechecks both identities and appends one transition.

4. Later runs load the target's exact workflow and non-policy packages.

5. Current operator policy is applied after state selection.

### Compatibility

1. Flow reads an existing activation without rewriting its bytes, digest, or public identity.

2. Flow preserves the existing execution result for that activation.

3. Flow identifies whether the legacy activation still needs a live package source.

4. A live-dependent activation must capture and revalidate its complete package state before it can
   become a composition baseline.

5. A new transition may use the closed legacy state while retaining old artifacts and history.

### Crash recovery

1. Flow publishes immutable dependencies before any authoritative head change.

2. A pre-head failure leaves the old head authoritative.

3. A post-boundary failure reopens exact durable state and reports settled or commit-uncertain.

4. A missing or contradictory retained dependency invalidates the store and fails closed.

## External standards evidence

- [ACP](https://github.com/agentclientprotocol/agent-client-protocol) standardizes communication
  between an editor or client and a coding agent. It does not define evaluated local activation or
  rollback authority.

- [A2A 1.0](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) defines remote agent
  discovery, messages, tasks, status, and artifacts. It treats the remote agent as opaque. It does
  not define an internal harness-state composition contract.

- [Agent Spec](https://github.com/oracle/agent-spec) defines portable agents, flows, and multi-agent
  composition. It can inform future vocabulary. It does not bind Flow evaluation evidence,
  activation heads, policy, or rollback.

- [OCI descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) use
  digests as content identifiers. This supports Flow's content-addressed manifest model. Flow does
  not adopt OCI media types because this state is not a registry exchange format.

- [OCI manifests](https://github.com/opencontainers/image-spec/blob/main/manifest.md) separate one
  content-addressed manifest from referenced content. Flow reuses that architectural property with
  its existing canonical JSON and SHA-256 contracts.

## Architecture alternatives

The comparison uses six dimensions. They are authority safety, compatibility, composition,
offline durability, simplicity, and standards fit. Scores are ordinal design judgments from one to
five. They are not runtime or product measurements.

| Approach | Safety | Compatibility | Composition | Offline | Simplicity | Standards | Balanced |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A. Complete effective states | 5 | 5 | 5 | 5 | 3 | 4 | 4.50 |
| B. Ordered delta chain | 3 | 3 | 5 | 4 | 2 | 4 | 3.50 |
| C. Independent surface heads | 2 | 3 | 5 | 3 | 2 | 4 | 3.17 |
| D. More sibling artifacts | 3 | 5 | 1 | 3 | 4 | 3 | 3.17 |

An exhaustive non-negative weight grid used 20 units across the six dimensions. It evaluated
53,130 weight combinations. Approach A won 51,731 combinations, or 97.37%. Approach D won the
1,140 simplicity-heavy combinations. The remaining 259 combinations tied.

The sensitivity result tests robustness to priorities. It does not make the input scores
empirical.

### A. Complete effective states — selected

Every head selects one complete evaluated state. The state binds exact workflow bytes and the full
non-policy package closure needed for execution. A new candidate starts from the selected complete
state and produces another complete state.

- **Strengths**: execution, recovery, inspection, and rollback read one immutable state. Sequential
  composition is explicit. Evaluation compares complete states. No runtime delta merge exists.

- **Costs**: the first slice must add a state encoding and close legacy live dependencies. It must
  also extend candidate baselines and preserve old activation identity.

- **Decision**: selected by the user on 2026-08-17 after the policy and legacy-closure refinements.

### B. Ordered delta chain — rejected

Store surface-specific changes and fold them in activation order.

- **Strengths**: small deltas and explicit history.

- **Failure**: order becomes behavior. Conflicts require a merge language. Replay must execute old
  projection code. A missing delta or changed merger can change historical execution.

### C. Independent surface heads — rejected

Keep separate prompt, skill, memory, sub-agent, and routing heads.

- **Strengths**: independent administration and small surface-specific artifacts.

- **Failure**: execution can combine heads that were never jointly evaluated. Cross-surface
  rollback and stale-state checks become ambiguous.

### D. More sibling artifacts — rejected

Continue adding one mutually exclusive activation kind for every candidate surface.

- **Strengths**: smallest immediate change and strongest compatibility with the current union.

- **Failure**: a later activation still loses prior improvements. This does not satisfy Issue #113.

## Selected architecture

One workflow head continues to select one immutable artifact. New artifacts select a complete
effective harness state rather than one isolated surface state. Execution receives the complete
state. It never reconstructs a state by reading the current head again or folding a delta chain.

The rollbackable state contains exact workflow bytes and every immutable non-policy package needed
for execution. It excludes policy packages, credentials, provider transport, mutable catalogs, and
candidate sources. Current operator policy is applied after state selection and can reject a
historical state.

The baseline identity binds the project, workflow, generation, selected activation, last
transition, and effective-state digest. Apply uses this complete identity as a compare-and-swap
condition. A head that changes and later returns to the same artifact still rejects stale evidence.

State and transition identities use separate digest domains. An effective state does not contain an
activation object that refers to that same state. This prevents recursive authority and digest
cycles.

Flow publishes content-addressed workflow and package dependencies first. It then publishes the
effective-state manifest. The transition and head index are the final authoritative commit. This
slice performs no automatic garbage collection. Every retained rollback target stays physically
available.

## Specification

_Captured by specification-capture on 2026-08-17. Source: Issue #113 and user-approved refined
Approach A._

### Non-goals

- Define memory, sub-agent, routing, or automatic candidate semantics.

- Add automatic activation, conflict merging, rebasing, background polling, or traffic splitting.

- Rewrite, migrate, or delete existing activation artifacts, digests, locators, or history.

- Add distributed or multi-user write consistency.

- Make policy packages, credentials, provider transport, mutable catalogs, or candidate sources
  part of rollbackable harness state.

- Change ACP, A2A, MCP, A2UI, browser, terminal, remote-host, or package-distribution protocols.

- Add executable package code, model-selected authority, new tools, weaker policy, or a stronger
  isolation backend.

- Add automatic garbage collection for effective-state blobs or retained rollback targets.

### Failure modes

- **Timeouts** — no network timeout exists at the state-domain boundary. Filesystem and application
  operations keep existing bounded cancellation and deadline contracts. No retry creates
  activation authority.

- **Partial failures** — failure before head publication leaves the old head authoritative. Flow
  publishes dependencies before the manifest and publishes the head last. A failure after the
  commit boundary reopens exact state or reports commit-uncertain.

- **Invalid input** — malformed, duplicate, contradictory, redigested, oversized, stale,
  cross-project, cross-workflow, or source-drifting state rejects before mutation. Public errors are
  fixed and value-free.

- **Missing context** — a missing workflow, package, state, activation, transition, evaluation, or
  rollback dependency invalidates admission. Flow does not consult live catalogs, credentials,
  registries, or network sources as fallback.

- **Cancellation** — the exact caller reason wins before mutation ownership. After ownership, Flow
  completes settlement and reports the settled or uncertain activation result.

- **Resource exhaustion** — exact artifact, byte, history, depth, node, and enumeration bounds
  reject before unbounded retention or publication.

- **Legacy contradiction** — a legacy artifact that needs live resolution is not described as a
  complete offline state. Flow must close and revalidate the dependency set before composition.

- **Current-policy contradiction** — current operator policy can reject a selected or rolled-back
  state. Flow does not execute the state and does not restore its historical policy.

- **Missing retained blob** — an absent or digest-contradictory rollback dependency invalidates the
  store. Flow does not perform partial rollback or live recovery.

### Interface contracts

- `EffectiveHarnessState` is a strict, versioned, content-addressed encoding. It binds one project
  and one workflow identifier. It also binds exact source, compiled workflow, and complete
  immutable non-policy package identities.

- The state excludes nested adaptive activation objects and policy packages. Its digest uses an
  explicit effective-state domain and the existing canonical JSON and SHA-256 rules.

- `EffectiveHarnessHeadIdentity` binds project, workflow, generation, activation digest, last
  transition digest, and effective-state digest.

- A new transition binds exact previous and next state digests. It also binds candidate,
  evaluation, one declared adaptive surface, actor, reason, generation, and previous transition.

- Candidate admission accepts either an admitted filesystem baseline or the exact current active
  state. A mutable locator never becomes authority without the captured head identity.

- Candidate projection returns one complete candidate state and one bounded content-free surface
  delta. It cannot change unrelated workflow or package authority.

- Runtime admission receives only the selected complete workflow and non-policy package state. It
  combines current operator policy afterward.

- Existing prompt, Agent Skill resource, and Agent Skill package activation encodings and digest
  calculations remain unchanged.

- A deterministic compatibility reader identifies closed and live-dependent legacy artifacts. It
  never labels a live-dependent artifact as a complete offline state.

- Public projection omits workflow, prompt, skill, package, and evidence bytes. It retains bounded
  state, transition, candidate, evaluation, and surface identities.

- Publication writes and verifies dependencies, then the state manifest, then the transition and
  head. The head never names an unpublished dependency.

## Authority and trust boundaries

| Boundary | Untrusted or mutable side | Authority-bearing side | Required control |
| --- | --- | --- | --- |
| Locator to active state | `activation:<workflow-id>` name | Exact head tuple and state digest | Atomic capture plus revalidation |
| Candidate to baseline | Candidate and evidence files | Complete admitted baseline | Stable no-follow reads and exact digest binding |
| Legacy artifact to composition | Live package catalogs | Closed effective state | Detect live dependence, capture closure, reject drift |
| State to execution | Stored manifest and blobs | Durable run admission | Reopen, redigest, cross-bind, then copy |
| State to policy | Historical evaluation policy | Current operator policy | Apply current policy after state load |
| Preview to apply | Public proposal | Durable head mutation | Exact proposal digest and head compare-and-swap |
| Store publication | Temporary files | Authoritative head | Dependencies first and head last |
| Public output | Private workflow/package bytes | Content-free identity | Shape-aware projection and cause-free errors |

## Coupling analysis

| Consumer | Required change | Constraint |
| --- | --- | --- |
| Adaptation domain | Add effective state, head identity, and transition identities | No filesystem, CLI, supervisor, or policy imports |
| Legacy activation reader | Materialize or classify each existing activation form | Preserve old bytes, digests, views, and run behavior |
| Candidate admission | Add exact active-state baseline source | Filesystem baseline behavior remains unchanged |
| Candidate projections | Accept a complete baseline and return a complete candidate | Only one declared surface may change |
| Evaluation plan and store | Bind complete baseline and candidate state identities | Same controls and no live fallback |
| Activation preparation | Verify evaluation and state closure | No policy or package-install authority |
| Activation store | Publish state dependencies and one head transition | Preserve existing index and artifact compatibility |
| Runtime admission | Load complete non-policy state then current policy | No activation-store reads after durable admission |
| Supervisor and worker | Carry existing durable snapshot | No new mutable state or network dependency |
| Public output | Add bounded state and transition views | No private bytes or recursive key stripping |
| Documentation | Explain composition, rollback, policy, and compatibility | Do not claim later candidate surfaces are implemented |

## TDD implementation sequence

1. RED and GREEN strict effective-state parsing, digest domains, bounds, package closure, policy
   exclusion, and public identity.

2. RED and GREEN complete head identity, ABA rejection, transition cross-binding, and proposal
   identity.

3. RED and GREEN compatibility classification for every existing activation fixture.

4. RED and GREEN exact active-state baseline admission.

5. RED and GREEN one complete prompt or Agent Skill projection after a different activated
   surface.

6. RED and GREEN evaluation-plan and evaluation-store binding for complete before and after states.

7. RED and GREEN state publication, apply, idempotency, rollback, corruption, cancellation,
   settlement, and existing store compatibility.

8. RED and GREEN attached, detached, child, resume, recovery, replay, inspect, and export behavior
   with all live sources removed.

9. RED and GREEN current-policy re-admission and historical-policy non-restoration.

10. RED and GREEN public privacy, CLI compatibility, exact bounds, and dependency direction.

11. Update README and public documents. Run mapped, full, coverage, runtime, package, audit, and
    documentation gates before review.

## Acceptance-criterion verification map

Every row inherits the issue non-goals. Commands are planned before production implementation.

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1. Existing activation behavior | Contract | `npx vitest run test/unit/adaptation/effective-harness-state.test.ts test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/integration/cli/prompt-activation.test.ts test/integration/cli/agent-skill-activation.test.ts test/integration/cli/agent-skill-package-candidate-generation.test.ts` | Golden legacy bytes, digests, views, execution, and rollback remain exact | Migration or deletion of legacy artifacts |
| 2. Locator and live-dependency compatibility | Behavioral and error | `npx vitest run test/unit/adaptation/effective-harness-state.test.ts test/integration/cli/effective-harness-composition.test.ts` | Existing locator works, live-dependent legacy state is identified, and closed state composes | New locator syntax or automatic catalog migration |
| 3. Candidate against active state | Behavioral | `npx vitest run test/unit/application/prepare-effective-harness-candidate.test.ts test/integration/cli/effective-harness-composition.test.ts` | Prompt-after-skill and skill-after-prompt admission bind exact complete baselines | Memory, routing, sub-agent, or concurrent merge semantics |
| 4. Second activation retains first | Behavioral | `npx vitest run test/integration/cli/effective-harness-composition.test.ts` | Both activation orders preserve both observable improvements | Automatic activation or traffic splitting |
| 5. Stale baseline before mutation | Error and data | `npx vitest run test/unit/application/prepare-effective-harness-activation.test.ts test/unit/infrastructure/fs/local-prompt-activation-store.test.ts` | Changed head rejects with zero artifact, transition, or head publication | Distributed writers outside Flow's project lock |
| 6. ABA and substitution resistance | Error and contract | `npx vitest run test/unit/adaptation/effective-harness-transition.test.ts test/unit/infrastructure/fs/local-prompt-activation-store.test.ts` | Independent project, workflow, generation, transition, activation, and state mutations reject | Cryptographic security beyond existing SHA-256 assumptions |
| 7. Complete offline durable execution | Behavioral and data | `npx vitest run test/integration/cli/effective-harness-composition.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts` | Attached, detached, child, resume, recovery, replay, inspect, and export use frozen bytes after live-source traps | Remote multi-host execution or external artifact storage |
| 8. Complete rollback | Behavioral | `npx vitest run test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/integration/cli/effective-harness-composition.test.ts` | Every retained state restores exact workflow and package identities | Automatic rollback or garbage collection |
| 9. Missing and corrupt dependencies | Error and data | `npx vitest run test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/unit/adaptation/effective-harness-state.test.ts` | Missing, extra, changed, redigested, and cross-bound blobs fail closed without live reads | Repair of manually corrupted stores |
| 10. Content-free preview and output | Contract and error | `npx vitest run test/unit/cli/public-output.test.ts test/integration/cli/effective-harness-composition.test.ts` | Preview keeps exact public identity while recursive canary checks find no private bytes or causes | Encryption of local durable artifacts |
| 11. Failure, cancellation, and atomicity | Error and data | `npx vitest run test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/unit/application/prepare-effective-harness-activation.test.ts` | Pre-ownership exact reasons and post-boundary settled or uncertain results pass exact mutation checks | Distributed filesystem atomicity |
| 12. Immutable controls and one surface | Contract | `npx vitest run test/unit/application/prepare-effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-state.test.ts` | Independently redigested graph, model, tool, approval, budget, verifier, retry, sandbox, evaluator, and unrelated-package mutations reject | Semantics for future adaptive surfaces |
| 13. Policy outside state | Contract | `npx vitest run test/unit/adaptation/effective-harness-state.test.ts test/unit/application/run-workflow-capabilities.test.ts` | State parser rejects policy packages and exact state digest excludes no hidden policy selector | Policy-package feature changes |
| 14. Current policy after state load | Behavioral and error | `npx vitest run test/unit/application/run-workflow-capabilities.test.ts test/integration/cli/effective-harness-composition.test.ts test/integration/supervisor/worker.test.ts` | New run and rollback target fail current policy before execution while old admitted runs remain stable | Retroactive mutation of existing durable runs |
| 15. Public documentation | Documentation | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts && git diff --check` | README, roadmap, activation, recovery, architecture, and testing claims agree and pass STE | External standards certification |
| Dependency direction | Contract | `npx vitest run test/integration/package/dependency-boundaries.test.ts` | Domain and application layers retain allowed dependency direction | Unrelated package refactors |
| Full release gate | Configuration and runtime | `npm run format:check && npm run lint && npm run typecheck && npm test -- --maxWorkers=1 && npm run build && npm run test:runtime && npm run test:coverage && npm run pack:check && npm audit --omit=dev` | Every command passes and exact counts are recorded on the frozen tree | Unsupported platforms or unpublished packages |

## Verification evidence

Evidence is recorded only after the frozen tree runs each mapped command. Every criterion entry will
state untested paths, evidence limitations, and exact adversarial cases.

### Effective state and transition domain contract

- **RED**: the first state and transition selectors failed because their domain modules did not
  exist. A later semantic-head mutation failed because head derivation accepted a redigested
  surface contradiction.

- **GREEN and refactor**: the two new domain files passed 17 tests. The focused state, transition,
  and workflow-package admission selector passed 23 tests across three files. Typecheck and scoped
  Biome passed.

- **Closure coverage**: package-free, one Agent Skill, transitive workflow packages, and one
  packaged root recompile from exact embedded bytes. Missing a transitive package fails closed.

- **Authority coverage**: project scope, workflow, generation, activation, and previous transition
  identities are digest-bound. Current state, next state, candidate, surface, and evaluation
  identities are also digest-bound.

- **Adversarial coverage**: policy packages, unexpected packages, changed workflow bytes, and
  changed package bytes reject. Redigested scope substitution and stale ABA heads also reject.
  Mismatched candidate surfaces and invalid head derivation reject with cause-free errors.

- **Mutation check**: disabling the immutable workflow-package resolver made the transitive closure
  test fail at package resolution. Restoring the resolver returned the focused selector to green.

- **Not tested yet**: candidate projection, evaluation, publication, effective-state rollback,
  runtime execution, current policy, CLI, and public output.

- **Evidence limitation**: current tests exercise in-memory domain inputs. Filesystem no-follow,
  cancellation, atomic publication, and crash settlement remain later TDD cycles.

### Legacy closure and active-state baseline admission

- **RED**: the legacy closure selector first failed because its application adapter did not exist.
  The active-state selector then failed because neither its loader nor a combined head and snapshot
  store result existed.

- **GREEN**: prompt and Agent Skill activations form exact states from their embedded bytes. Agent
  Skill package candidate and baseline activations do the same. A valid legacy workflow can still
  need a tool package. Flow classifies that workflow as live-dependent. The workflow becomes a
  state only with its exact supplemental package.

- **Head coverage**: the local activation store now returns the validated head from the same index
  observation as the active blob. Candidate baseline admission binds its workflow, generation,
  activation, transition, project scope, and materialized state into one head identity.

- **Adversarial coverage**: missing, unrelated, duplicate, policy, cross-workflow, and mismatched
  head inputs reject with fixed cause-free stages. Pre-read and post-read cancellation preserves
  the exact caller reason. Pre-aborted input does not call the store.

- **Focused evidence**: the combined state, transition, compatibility, candidate projection, and
  local activation store selector passed 82 tests across five files. Typecheck and scoped Biome
  passed.

- **Evidence limitation**: supplemental package discovery is not implemented. The adapter accepts
  only an already captured immutable supplemental closure. Evaluation binding and store mutation
  remain later TDD cycles.

### Complete candidate projection

- **Cross-surface coverage**: prompt projection on a skill-bearing state preserves the exact skill.
  A later Agent Skill resource projection preserves the improved prompt while replacing only the
  evaluated skill package.

- **Current surface coverage**: each current candidate produces one complete next state. Prompt,
  Agent Skill resource, and generated Agent Skill package candidates also produce a content-free
  delta.

- **Immutable controls**: prompt projection normalizes only declared prompt replacements before a
  complete compiled-workflow comparison. Resource projection keeps workflow bytes exact. Package
  projection permits only one empty-to-selected skill change at the declared node and adds only
  that exact package.

- **Adversarial coverage**: a prompt candidate with redigested workflow and candidate identities
  still rejects when it also changes the cost budget. A no-op state, same-name package overwrite,
  unrelated package, wrong workflow, or inconsistent package capability identity rejects.

- **Evidence limitation**: these tests use already admitted candidate projections. Stable local
  candidate-file admission against an active baseline and durable evaluation-store cross-binding
  remain later cycles.

### Immutable candidate artifact and paired evaluation

- **RED and GREEN**: local evaluation admission initially rejected the new plan grammar. It now
  accepts two explicit selections from one effective-harness candidate artifact and rejects mixed
  pairing before schedule authority is created.

- **Offline evidence**: admission captures both complete states. It compiles each workflow through
  its embedded workflow-package resolver. It creates exact capability snapshots from the selected
  package closure. The admitted plan remains usable after the candidate file is removed.

- **Durable public identity**: evaluation headers retain the artifact, state, baseline-head,
  workflow, package, surface, and candidate digests. They omit workflow and package
  `contentBase64` values. The local evaluation store reopens and cross-binds the repeated public
  identities.

- **Activation evidence**: preparation aggregates the complete paired ledger. It accepts only a
  superior result whose two profiles match the exact candidate artifact. Independent authority
  substitutions reject. The matrix covers the artifact, both states, the baseline head, and the
  candidate digest.

### Effective transition and mutation store

- **Transition variants**: activation and rollback are distinct strict variants. Activation binds
  candidate and evaluation evidence. Rollback instead binds the retained target transition and
  cannot claim a new candidate evaluation.

- **Publication**: the new effective-harness store shares the existing project activation mutation
  lock. It publishes exact baseline state, candidate state, and candidate artifact blobs before an
  atomic effective index rename.

- **History**: one exact legacy head anchors the effective history. Index validation replays every
  transition from that origin and compares the derived complete heads. Active load reopens and
  revalidates the selected state blob.

- **Focused evidence**: the combined foundation selector passed 99 tests across 11 files.
  Typecheck passed. The new store tests bind dependency-before-head order, exact active-state load,
  retained-state rollback, and stale-proposal rejection before blob publication.

- **Settlement coverage**: an exact apply retry returns the existing settled head and transition
  without appending history. Failure before index rename keeps the prior head authoritative and
  permits an exact retry. Failure after index rename reopens the committed index and returns the
  settled activation.

- **Corruption and writer coverage**: missing selected state or candidate artifact blobs invalidate
  the store. A legacy activation apply cannot replace a workflow after an effective head exists.
  The focused effective and legacy store selector passed 59 tests across two files.

- **Evidence limitation**: rollback idempotency, cancellation at each mutation boundary, aggregate
  physical store limits, and exhaustive symlink/race cases remain pending.

### Durable effective runtime selection

- **Compact proof**: durable capability state now carries one strict effective runtime proof. It
  binds the head, workflow identity, optional root package, ordered non-policy package digests, and
  domain-separated runtime digest. Package bytes remain in the existing array. The
  proof does not duplicate them.

- **Closed reconstruction**: runtime validation reconstructs the effective state from the proof and
  package array. Missing, substituted, or ambient non-policy packages reject. A current policy
  package is permitted only as an overlay outside the rollbackable closure.

- **Execution and recovery**: `activation:<workflow-id>` prefers an effective head and falls back to
  legacy only on exact absence. A package-bearing effective workflow executes from its selected
  package. An approval-gated run also resumes after removal of the live effective store. Durable
  admission contains the exact workflow and package authority.

- **Public privacy**: run output retains the content-free head, workflow hashes, package identities,
  and runtime digest. It removes effective workflow `contentBase64` and Agent Skill file payloads.
  Tests reject both decoded and encoded private resource canaries.

- **Focused evidence**: the effective runtime and capability domain selector passed 18 tests across
  two files. The adjacent state, workflow admission, run capability, persistence, legacy CLI, and
  public-output selector passed 76 tests across ten files. The desktop sandbox returned `EPERM` for
  one Unix-socket-backed legacy test. Its socket-permitted rerun passed. Typecheck, scoped Biome,
  and diff checks passed.

- **Evidence limitation**: detached supervisor and worker execution remain later TDD cycles. Child
  runs, replay/export, current-policy rejection, runtime cancellation, CLI composition commands,
  and public effective head inspection also remain.

## Activity log

- 2026-08-17 — PR #112 merged. Post-merge CI passed. Main was clean at merge commit `893af804`.

- 2026-08-17 — Compared four architecture approaches. The user approved refined Approach A after
  explicit policy separation, legacy closure, ABA resistance, and retention refinements.

- 2026-08-17 — Created Issue #113 after open and closed duplicate searches. The branch starts from
  exact `origin/main`.

- 2026-08-17 — Captured the specification, flows, standards disposition, authority boundaries,
  coupling analysis, TDD sequence, and plan-time verification map before production code.

- 2026-08-17 — Completed the first RED, GREEN, and refactor cycle for effective state, exact head,
  and transition identities. Added transitive and root workflow-package closure evidence.

- 2026-08-17 — Completed legacy closure classification and exact active-state baseline admission.
  Preserved legacy index bytes while returning the selected head with the active artifact.

- 2026-08-17 — Completed all three current surface projections. Verified prompt-after-skill and
  skill-after-prompt retention in complete state objects.

- 2026-08-17 — Added one immutable candidate artifact and paired evaluation selection. Added
  durable content-free identity and superior-evidence preparation. Added explicit rollback
  transitions and the first shared-lock effective-state mutation store.

- 2026-08-17 — Added exact apply settlement, missing-blob rejection, and legacy-writer exclusion.
  Added the compact durable runtime proof, effective-first locator admission, package-closed
  reconstruction, content-free projection, and offline approval-boundary resume.
