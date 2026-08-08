# Decision Journal: Issue #52 — Enforce durable run-wide artifact budgets

**Issue**: #52 | **Branch**: `codex/issue-52-artifact-budgets` | **Started**: 2026-08-08
**Base dependency**: PR #51, commit `4d9ae7d`

---

## Context and mapped flows

Flow already makes step starts, model tokens, execution time, child runs, and child resource
reservations replay-authoritative. It also bounds individual executor outputs. It does not yet cap
the cumulative command, agent, verifier, and child output retained in one run tree. A workflow can
therefore stay within every per-node cap while accumulating an unbounded durable evidence payload
across retries, concurrency waves, detached work, and nested children.

### Author: declare one portable run-wide limit

1. The author sets `budget.maxArtifactBytes` on the root workflow.
2. Every child workflow declares its own positive artifact ceiling alongside its existing four
   required child ceilings.
3. Compilation validates safe integer bounds and freezes the exact value into the compiled budget.
4. The canonical workflow digest and durable `run_started` event bind the configured limit.

### Operator: inspect deterministic consumption

1. Each terminal node outcome contributes bytes from its retained primary executor payload.
2. The reducer derives the total from durable evidence; no side counter is authoritative.
3. Inspection reports the configured limit, consumed bytes, remaining bytes, and the artifact
   exhaustion dimension through the existing resource view.
4. Recovery replays the same ledger and reconstructs the same result without contacting an
   executor, provider, or artifact service.

### System: settle work at the limit

1. A successful or failed outcome is appended with its bounded evidence.
2. Replay adds its artifact bytes with checked safe-integer arithmetic.
3. Equality or overshoot produces the existing terminal `resource_exhausted` settlement.
4. No later node or wait begins. An already-active concurrency wave quiesces, and all of its
   declaration-ordered retained outcomes remain charged.

### System: reserve and reconcile nested runs

1. Before a child starts, its declared artifact ceiling is reserved from the parent's remaining
   capacity with the other child ceilings.
2. Concurrent sibling reservations cannot collectively exceed the parent ceiling.
3. The child outcome imports the child's verified `resources.artifactBytes` exactly once.
4. The resulting total naturally rolls up through each ancestor's own child evidence.

## Research and challenged assumptions

- OMP exposes live host RPC and approval-mode controls, but its protocol resolves an in-memory
  request/response promise; it is not a durable same-call continuation or replay ledger. Its output
  spilling is useful future storage precedent, not a substitute for run-wide accounting. See
  <https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md>,
  <https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md>, and
  <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>.
- Prime Agent separates daemon, worker, kernel, and session lifecycles and marks uncertain effects
  during recovery. That supports deriving accounting from committed durable outcomes rather than
  executor-local counters. See
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
  and <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>.
- Pi's session tree and SDK demonstrate durable message histories and branchable sessions, while
  the pinned nested `pi-agent-core` harness persistence surface is still stubbed. Provider session
  persistence therefore cannot be treated as the resource ledger for this slice. See
  <https://pi.dev/docs/latest/sessions>, <https://pi.dev/docs/latest/sdk>, and
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md>.
- An OCI-style content-addressed descriptor could later separate logical artifact identity from
  physical storage, but adding a store, spill, download, retention, and garbage-collection protocol
  now would combine two independently valuable capabilities and obscure the budget invariant. See
  <https://github.com/opencontainers/image-spec/blob/main/descriptor.md>.
- Charging JSONL bytes initially looked replay-friendly, but it would make resource use depend on
  serialization details and would charge policy metadata and derived projections. The stable unit
  is the UTF-8 byte length of retained primary executor payloads.
- Charging verifier `reason` or typed result projections would double-charge information derived
  from raw executor output. The budget intentionally excludes them.

## Specification

_Captured by specification-capture on 2026-08-08. Source: user-confirmed Issue #52 design._

### Non-goals

- Does not add an artifact store, content-addressed storage, spill-to-disk behavior, download API,
  garbage collection, retention policy, or physical disk accounting.
- Does not raise individual executor output caps or recover bytes already truncated by an
  executor.
- Does not add Pi/provider session persistence, dynamic tool approval, or durable same-call tool
  continuation.
- Does not add CPU, memory, disk, network, monetary, or prepaid billing quotas.
- Does not change sandbox policy, workspace snapshots, candidate-delta bounds, or existing timeout,
  cancellation, and committed-settlement precedence.

### Failure modes

- **Timeouts** — Existing node timeouts remain authoritative. Artifact consumption settles only
  when the terminal retained evidence is durably committed.
- **Partial failures** — Committed failed evidence is charged. A rejected event append cannot mutate
  a hidden counter. Recovery after a committed outcome reconstructs the same exhaustion result.
- **Invalid input** — Unknown budget fields and empty, zero, negative, fractional, unsafe, or
  overflowing values fail closed with bounded typed errors.
- **Missing context** — An omitted root artifact budget remains unbounded for compatibility. A child
  missing its artifact ceiling fails compilation. Legacy child events without `artifactBytes`
  replay as zero.
- **Dependency outage** — No external storage or provider call participates in accounting; durable
  evidence remains the sole source of truth.
- **Resource exhaustion** — Equality is terminal, matching existing settlement dimensions. An
  active concurrency wave may overshoot through its complete bounded outcomes; no later work or
  wait starts.
- **Concurrency** — Outcomes append in declaration order. Concurrent child ceilings are reserved
  before launch and aggregated with overflow-safe admission arithmetic. Actual child use, including
  bounded overshoot, is charged to ancestors with checked replay arithmetic.
- **Cancellation** — Existing committed settlement takes precedence over a later cancellation.
  Cancellation observed before terminal evidence settles retains its existing authority.
- **Tampering or overflow** — A claimed child total inconsistent with its event tree, or any
  arithmetic beyond a safe integer, rejects replay rather than wrapping or saturating.

### Interface contracts

Workflow authoring and compiled form:

```yaml
budget:
  maxSteps: 20
  maxModelTokens: 50000
  maxExecutionMs: 600000
  maxChildRuns: 2
  maxArtifactBytes: 1048576
```

`budget.maxArtifactBytes` is an optional positive safe integer on a root workflow and is preserved
unchanged in `CompiledRunBudget`. Every child workflow must provide all five ceilings. The canonical
compiled-workflow digest and exact recovery-budget comparison include the field.

The typed resource projection adds `artifactBytes` to `RunResourceConsumption`, remaining-resource
views, child resource reports, reservation arithmetic, and the exhaustion-dimension enum. New
events always serialize the field. The event parser supplies zero only for historical child outcome
resources that predate the field.

For one terminal evidence value `e`, the accounting function is:

```text
artifactBytesForEvidence(e) =
  command:          utf8(stdout) + utf8(stderr)
  agent:            utf8(text)
  model verifier:   utf8(raw)
  command verifier: utf8(nested command stdout) + utf8(nested command stderr)
  child:            e.resources.artifactBytes
  missing evidence: 0
```

The function excludes verifier reason/verdict, typed result canonical values, approvals, hashes,
policy/effect/sandbox metadata, and all other derived or control metadata. A failed outcome follows
the same rule when its evidence is present and committed. A fresh retry is not charged until a
terminal evidence event exists.

Run consumption is the checked sum of this function over every committed terminal node outcome.
Child evidence imports an independently verified tree total exactly once. The application may
reserve child ceilings for admission, but replayed evidence—not reservation state—is the
authoritative consumed total.

## Coupling analysis

```text
workflow YAML -> strict budget schema -> compiled immutable budget -> run_started / recovery
                                                               |
terminal node evidence -> UTF-8 payload accounting -> reducer resource projection -> inspection
                                                               |
child ceiling -> scheduler reservation -> child tree -> verified child total -> ancestor reducer
```

- Workflow domain owns author validation, child completeness, immutability, and digest coverage.
- Run domain owns the accounting formula, checked aggregation, legacy event normalization,
  remaining projection, and terminal exhaustion dimension.
- Application scheduling owns only admission/reservation and dispatch precedence; it cannot mutate
  an authoritative consumption counter.
- Child orchestration transports the fifth ceiling and verified actual total through existing
  typed contracts.
- CLI and detached workers serialize the existing run projection and therefore require no separate
  artifact-budget state machine.

## Approaches considered

| Approach | Simplicity | Replay stability | Future storage flexibility | Effort | Disposition |
| --- | --- | --- | --- | --- | --- |
| Charge physical JSONL/event bytes | High initially | Low: serialization and metadata dependent | Low | Low | Rejected |
| Charge logical retained executor payload bytes | High | High: evidence-derived and provider-neutral | High: storage can change independently | Medium | **Selected** |
| Introduce CAS plus OMP-style spill immediately | Low | High if fully specified | Very high | Very high | Deferred |
| Keep per-executor mutable counters | Medium | Low: detached/recovery drift | Medium | Medium | Rejected |

## Decision

Implement a fifth replay-authoritative run budget over logical retained primary executor payloads.
Derive consumption exclusively from committed terminal evidence with checked arithmetic. Preserve
root compatibility, require explicit child ceilings, reserve child capacity before launch, and
import verified child totals once. Use the existing terminal settlement and inspection models.
Keep physical artifact storage and dynamic approval as separate future roadmap capabilities.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict root/child author contract, digest, immutability | Contract | `npx vitest run test/unit/workflow/artifact-budget-compiler.test.ts` | Valid safe limits compile; invalid values reject; root omission works; child omission rejects | Runtime storage |
| Deterministic UTF-8 accounting, failures, replay, legacy events, overflow | Domain/adversarial | `npx vitest run test/unit/run/artifact-budget-reducer.test.ts` | Every evidence kind follows the formula; equality exhausts; mutation and overflow reject; legacy child field defaults to zero | Bytes truncated before evidence |
| Scheduler settlement, concurrency overshoot, retry/cancel precedence, recovery | Application | `npx vitest run test/unit/application/run-workflow-artifact-budget.test.ts` | No later work/wait after settlement; active wave quiesces; committed settlement outranks later cancellation; recovery is identical; fresh retry is not pre-charged | Pausing an active executor at an exact byte boundary |
| Child reservation, sibling admission, actual roll-up | Application/domain | `npx vitest run test/unit/application/run-workflow-child.test.ts test/unit/run/artifact-budget-reducer.test.ts` | Fifth ceiling reserves safely and verified actual totals roll up exactly once | Distributed prepaid quota service |
| Attached/detached/CLI transport and inspection | Integration | `npx vitest run test/integration/cli/main.test.ts -t "artifact exhaustion" && npx vitest run test/integration/supervisor/worker.test.ts -t "artifact budget"` | Public projections and worker recovery preserve configured and consumed values | Hosted UI |
| Public contract and examples | Docs/scaffold | `npx vitest run test/scaffold/community-files.test.ts test/unit/workflow/compiler.test.ts` | README, roadmap, architecture, authoring guidance, and examples match the exact boundary | CAS/spill/download/retention claims |
| Complete regression | Release | `npm run check && npm run test:runtime && npm run test:coverage && npm run pack:check && npm audit --audit-level=high` | Format, lint, typecheck, source/runtime tests, build, installed CLI, coverage, package, and audit pass | Hosted CI availability |

## Planned RED -> GREEN -> REFACTOR sequence

1. **Compiler RED/GREEN** — Prove root acceptance/rejection, child fifth-ceiling completeness,
   digest sensitivity, and frozen compiled values.
2. **Reducer RED/GREEN** — Prove multibyte accounting for all evidence kinds and failures, equality,
   legacy normalization, tamper refusal, and checked overflow.
3. **Scheduler RED/GREEN** — Prove equality/overshoot settlement, downstream blocking, active-wave
   quiescence, committed-settlement/cancellation ordering, retry neutrality, and recovery
   equivalence.
4. **Child RED/GREEN** — Prove reservation, concurrent sibling non-overcommit, actual ancestor
   roll-up, overshoot accounting, and legacy compatibility.
5. **Transport RED/GREEN** — Prove inspection plus attached/detached worker transport.
6. **REFACTOR/VERIFY** — Update all fixtures/examples/docs, remove only proven duplication, run
   mutation probes, full local CI, coverage, runtime/package/audit checks, graph refresh, and an
   adversarial acceptance/security/correctness review.

## Implementation tasks

1. [x] Extend and verify the root/child workflow budget contract.
2. [x] Add replay-authoritative artifact accounting and projections.
3. [x] Enforce scheduler settlement, retry, cancellation, concurrency, and recovery semantics.
4. [x] Reserve and reconcile nested artifact budgets exactly once.
5. [x] Complete CLI/detached integration and public inspection.
6. [x] Update every public document/example and complete triple/adversarial verification.

## Implementation record

- Compiler tests first rejected the unknown root field, invalid-value paths, incomplete child
  contract, and missing digest sensitivity. Production then added one optional root limit and one
  mandatory fifth child ceiling without changing unbudgeted root behavior.
- Reducer tests first rejected the unknown durable limit/resource field and absent accounting.
  Production now derives checked UTF-8 bytes from the documented primary payloads, imports child
  totals, and supplies zero only while parsing historical child resources.
- Scheduler tests proved that generic event-derived settlement already handled equality, committed
  settlement precedence over later cancellation, downstream suppression, and declaration-ordered
  wave overshoot. The only new scheduler identity defect was recovery comparison omitting the
  field; it is now exact.
- Child tests first reproduced individual and concurrent artifact-ceiling overcommit. Admission now
  reserves the fifth dimension before materialization, while reducer evidence charges verified
  actual use—including a bounded child overshoot—once. Recovery recursively re-reduces each
  settled child ledger and compares its complete terminal projection before accepting any parent
  summary.
- Attached CLI and detached worker tests persist and inspect the same typed projection. The detached
  test requires a host-capable run because the outer development sandbox denies its local Unix
  control socket.
- README, architecture, workflow specification, recovery guide, testing guide, roadmap, and all
  child/optimization/budget examples now state the exact logical accounting boundary and avoid
  physical storage claims.

## Adversarial review and disposition

- A review probe found the durable exhaustion-event schema still capped the dimension array at
  four entries. The run domain now exports one canonical five-dimension tuple, and both the typed
  enum and event cardinality derive from it. A test commits all five simultaneous dimensions.
- Two independent probes showed that a settled parent child event could claim a plausible but
  forged resource projection during recovery. Recovery now recursively reads and reduces every
  settled child ledger and compares identity, compiled budget, terminal sequence, outcome, result,
  complete five-dimensional resources, duration, and workspace disposition before effects resume.
- A legacy-compatibility probe showed that deleting the new child ceiling from current durable
  identity could otherwise create a zero-valued escape hatch. Historical event parsing still
  defaults a missing child artifact total to zero, but recovery authorization requires the exact
  current compiled five-ceiling child budget.
- Holdout validation requested an exact committed-exhaustion recovery case and stronger public-doc
  guards. The added recovery test proves no executor rerun after a failed settlement append, while
  scaffold tests bind the recursive recovery rule, all five totals, focused test guidance, and
  example ceilings.
- A prose contradiction incorrectly suggested cancellation beat committed resource settlement. It
  was corrected to match the existing tested precedence contract.
- After those dispositions, the final independent skeptic reported zero P1/P2/P3 findings and the
  isolated holdout validator reported PASS with no claim-to-file conflicts.

## Verification evidence

- Clean-room `npm run check`: formatting and lint over 164 files, typecheck, build, 95 source test
  files with 1,215 passing tests, and 3 runtime test files with 20 passing tests.
- Clean-room `npm run test:coverage`: 1,215 tests passing; 84.04% statements, 78.02% branches,
  93.61% functions, and 84.07% lines.
- Clean-room `npm run pack:check`: packed installation and CLI smoke verification passed.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `actionlint .github/workflows/ci.yml`: passed with no findings.
- Focused RED/GREEN suites covered compiler contracts, every evidence kind, exact exhaustion,
  overflow, cancellation/retry/recovery, attached and detached transport, sibling reservations,
  recursive child tampering, and public documentation.
- The optional local graph refresh could not write its user-owned output because the host denied
  the operation. No graph output was modified, and this is not part of the product build or release
  contract.
