# Decision Journal: Issue #46 — Bounded accept-best optimization loops

**Issue**: #46 | **Branch**: `codex/issue-46-bounded-optimization-loops` | **Started**: 2026-08-08 | **Status**: Implemented and verified

## Outcome and flows

### Author flow

1. The author publishes one unconditional typed baseline result before the optimization node.
2. The author declares a numeric metric pointer and direction, exact invariants, a finite candidate
   bound, a finite stagnation threshold, a rollback policy, and one embedded candidate workflow.
3. The author places the optimization as an explicit graph barrier: every other top-level node is
   ordered before or after it rather than remaining an unordered sibling.
4. Flow rejects the root workflow before creating a run when the baseline and candidate result
   schemas differ, a pointer is invalid or type-incompatible, a source is conditional or not
   awaited, a bound is missing, the barrier is incomplete, or the candidate workflow violates
   child-run limits.
5. Each candidate starts from the current best parent workspace, executes in a separately-ledgered
   isolated workspace, and publishes the declared typed result.
6. Flow recomputes the candidate metric and invariants from canonical result evidence. Rejected
   candidates are discarded without changing the parent.
7. A strict valid improvement is captured as a bounded candidate delta and promoted only while its
   affected parent preimages still match.
8. The controller stops at the candidate bound or stagnation threshold and leaves the parent at the
   best accepted state.

### Operator flow

1. The operator inspects the parent run and sees baseline identity and metric, every candidate child
   run, metric and invariant observations, accept/reject reason, delta and promotion identity,
   stagnation count, stopping reason, and aggregate resources.
2. Cancelling the root prevents new candidates. A candidate already running receives the same
   cancellation signal and cannot begin promotion afterward.
3. If the process stops during promotion, resume reconciles the durable promotion transaction before
   starting any other node.
4. A reconciled committed promotion is acknowledged once; a reconciled incomplete promotion is
   compensated to the previous best; an unprovable path state blocks the run and retains artifacts.

### System flow

1. Compilation expands `maxCandidates` into a finite sequence of candidate child nodes and
   optimization-check nodes plus one controller. No runtime node or edge is invented.
2. Compilation proves the source optimization node is ordered with every other top-level node. The
   first candidate depends on the author dependencies. Every later candidate is guarded by the
   previous durable check's `continue` decision.
3. A candidate child uses the existing child ledger and workspace identity, but successful candidate
   mode retains the workspace for its paired check instead of discarding it immediately.
4. The paired check evaluates the baseline/candidate typed results. Rejection durably records the
   decision before idempotent discard.
5. Acceptance captures a content-addressed delta, durably prepares rollback material, records a
   promotion prepare event, and applies entries in deterministic order under one cooperating
   workspace lock.
6. A promotion settlement and candidate decision become the paired check's terminal evidence. The
   next candidate may start only after that evidence is durable.
7. The controller derives its best candidate and stopping reason exclusively from durable checks.

## Research evidence

- OMP isolates tasks with a platform abstraction, captures staged, unstaged, untracked, binary, and
  nested-repository deltas, and supports patch or branch/cherry-pick integration. Its source also
  demonstrates the complexity of dirty baselines, shared Git metadata, stashes, nested repositories,
  and partial restore warnings. Flow adopts the separation of isolation, capture, and integration,
  but not the Git-only authority model:
  <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md> and
  <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/task/worktree.ts>
- Autoresearch succeeds with a direct commit/measure/keep-or-reset loop because it fixes one editable
  file, one metric, one branch, one evaluator, and one time budget. Those constraints are valuable
  design evidence but are not valid assumptions for a general repository harness:
  <https://github.com/karpathy/autoresearch> and
  <https://github.com/karpathy/autoresearch/blob/master/program.md>
- Prime Agent keeps the base prompt immutable, makes refinements small and evidence-backed, and
  records snapshots for rollback. It also explicitly distinguishes lifecycle isolation from a
  security sandbox. Flow applies the immutable-baseline and reviewable-candidate principles to
  workspace state: <https://github.com/PrimeIntellect-ai/prime-agent>
- Git documents that `git apply` normally refuses the whole patch when a hunk cannot apply and that
  binary/full-index patches are supported. Git worktrees share repository metadata and retain
  incomplete submodule support, so neither contract alone covers Flow's dirty, non-Git, nested-run,
  or provider-neutral workspace boundary: <https://git-scm.com/docs/git-apply>,
  <https://git-scm.com/docs/git-diff.html>, and <https://git-scm.com/docs/git-worktree.html>
- RFC 6901 defines deterministic pointer syntax and failure on unresolved values. RFC 8785 supplies
  the canonical JSON and I-JSON number constraints already used by typed results:
  <https://www.rfc-editor.org/info/rfc6901/> and <https://www.rfc-editor.org/rfc/rfc8785.html>
- Saga guidance treats completed local effects and their compensations as explicit workflow steps.
  This matches a multi-path filesystem promotion, which cannot honestly claim one portable atomic
  commit: <https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-patterns.html>

The user-supplied Earendil article URL currently returns no retrievable page from the site index or
web fetch. No design claim depends on inaccessible content from that article.

## Architecture approaches

| Approach | Summary | Simplicity | Portability | Dirty baseline | Recovery | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. In-place commit/reset | Mutate the parent, run a metric, keep or reset as autoresearch does | High | Git-only | Fragile | Depends on Git state | Small | Critical: rejected work is visible; reset can destroy user state |
| B. Git patch/branch integration | Capture binary patches or commits and apply/cherry-pick them as OMP does | Medium | Git-only | Possible but complex | Git sequencer plus Flow ledger | Medium | High: stash/index/nested-repo conflicts and shared metadata |
| C. Whole-tree snapshot swap | Keep complete baseline/candidate trees and exchange the root | Medium | Backend-dependent | Exact | Strong with native snapshots | Large | High: open handles, mount points, cross-device roots, protected state |
| D. Content-addressed delta saga | Compare isolated candidate to its verified source snapshot, store bounded changed blobs, and promote with write-ahead compensation | Medium | Git/provider neutral | Exact while source digest matches | Flow-owned per-entry reconciliation | Large | Medium |

### Decision

Use **D, a content-addressed candidate delta and write-ahead promotion saga**, behind the existing
workspace-isolation port. Compile optimization into a finite static graph, reuse separate child
ledgers for candidate work, and add replay-validated candidate-check evidence plus promotion events
to the parent ledger.

This does not forbid a later Git-native or snapshot-native backend. Those backends may implement the
same candidate and promotion contracts when they can prove equivalent freshness, durability,
reconciliation, and evidence semantics.

### Why not a separate foundation-only issue

A public delta API without a metric/invariant consumer would add a powerful mutation primitive with
no safe user flow. The infrastructure is therefore built as a layer inside this issue and is first
exposed through the bounded optimization contract. This keeps every component traceable to an
author or operator flow.

### Rejected assumptions

- A better numeric result does not imply invariants still hold.
- A typed result is not necessarily an objective evaluator; optimization requires a deterministic
  result provenance rather than an agent's unsupported self-score.
- A Git repository is not guaranteed, and a clean Git index is not equivalent to the user's working
  tree.
- A text patch does not cover binary files, modes, symlinks, type changes, or untracked content.
- Multiple per-path renames are not one atomic filesystem transaction.
- A write-ahead event alone cannot restore bytes; bounded rollback content must be durable before
  the prepare event permits parent replacement.
- The latest candidate is not necessarily the best candidate.
- An unrelated external parent edit after delta capture need not invalidate promotion, but a changed
  affected preimage must.
- Cancellation is not permission to abandon a half-applied promotion; reconciliation remains
  mandatory.
- Repeating a stochastic metric does not prove statistical improvement. The initial contract makes
  one deterministic observation per candidate and states that limitation.

## Specification

_Captured by specification-capture skill on 2026-08-08. Source: extracted from Issue #46 and
architecture research._

### Non-goals

- Does not implement unbounded optimization, dynamic fan-out, Bayesian search, population search,
  distributed trials, or statistical significance testing.
- Does not nest an optimization inside a loop body, candidate workflow, or another child workflow;
  multiple top-level optimizations must be explicitly ordered.
- Does not let a model select the winning candidate or bypass declared metric and invariant checks.
- Does not export a general-purpose patch/merge command outside the optimization flow.
- Does not preserve hard-link identity, sparse-file layout, ACLs, extended attributes, ownership,
  timestamps, sockets, devices, FIFOs, mount points, or submodule-specific semantics.
- Does not provide an externally atomic multi-file view to hostile or non-cooperating processes.
- Does not resolve semantic conflicts with concurrent human edits; it refuses changed affected
  preimages.
- Does not add package discovery, remote workflows, VM containment, provider-session continuation,
  dynamic agent-tool approval, or general failure retry.
- Does not inject previous metric history into candidate agent prompts; the candidate workflow owns
  its generation strategy and starts from the current best workspace.

### Failure modes

- **Timeouts** — candidate child timeouts use existing child terminal and resource rules. A timeout
  before promotion discards or retains only the isolated candidate; a timeout/cancellation cannot
  interrupt required promotion reconciliation once parent mutation may have started.
- **Partial failures** — every affected preimage and rollback payload is durable before the parent
  prepare event. A live apply failure compensates applied entries in reverse order. Recovery accepts
  a fully committed local transaction, compensates an incomplete transaction to the previous best,
  and marks any path matching neither expected side as unknown.
- **Invalid input** — schema, pointer, bound, source, invariant, and child-tree violations are
  structured compiler diagnostics before `run_started`. Invalid runtime canonical evidence fails the
  paired check without promotion.
- **Missing context** — missing baseline evidence, candidate result, workspace, delta manifest,
  rollback payload, promotion journal, or compatible production port fails closed and retains all
  available ledgers/artifacts.
- **Dependency outage** — provider, sandbox, or evaluator failure remains isolated to the candidate.
  A candidate workflow failure does not promote work; infrastructure corruption or uncertain effects
  fail the optimization rather than counting as ordinary stagnation.
- **Resource exhaustion** — compiled node/tree, workspace entry/byte, candidate delta entry/logical-byte/evidence-byte,
  run-start/token/cost/time, and event-size ceilings reject or exhaust deterministically. No
  unbounded manifest or blob is admitted.
- **Concurrent mutation** — optimization candidate/check waves are exclusive inside one Flow run.
  Compilation rejects any top-level node unordered with the optimization barrier. A cooperating
  cross-process workspace lock serializes promotions under the same run root. Every affected parent
  path and every unchanged directory ancestor is re-observed before replacement; a stable
  intermediate symlink is stale. A concurrent mutation triggers refusal, compensation, or an
  unknown fail-closed outcome. Per-component checks cannot eliminate a hostile same-user pathname
  race between the final check and filesystem operation.

### Interface contracts

- The public source node is `type: optimization`. It declares one upstream unconditional
  `baseline` source with field `result.value`, `metric.pointer`, `metric.direction`, an explicit
  `invariants` array, `maxCandidates`, `stagnation.maxConsecutiveNonImproving`,
  `rollback: previous-best`, and an embedded candidate workflow/result boundary.
- Baseline and candidate result schemas have the same digest. The metric pointer resolves to a
  number/integer schema. Each invariant pointer resolves to a scalar schema compatible with its exact
  expected JSON value. Pointers use RFC 6901 string form; an unresolved pointer is an error.
- Baseline and candidate result provenance is deterministic and unconditional. The initial contract
  refuses agent-authored or tool-enabled model-authored metric evidence.
- `maxCandidates` is 1–16. Stagnation is 1–`maxCandidates`. Candidate workflows retain existing
  child depth/source/tree limits, declare all child budgets, contain no human waits, and expose one
  unconditional terminal typed result. Nested optimization is rejected.
- Every top-level node must be an ancestor or descendant of the optimization source node. This makes
  the candidate/check chain a visible graph barrier instead of relying on hidden scheduler priority.
- Compilation generates deterministic durable candidate/check ids and one controller, and accounts
  for every expanded node and recursively repeated child tree before the run starts.
- A candidate child link records its optimization controller and candidate ordinal. Successful
  candidate evidence may retain exactly one candidate workspace; ordinary child success still
  requires discard.
- A candidate delta contains a version, workspace/source identity, baseline and candidate snapshot
  digests, sorted relative operations, per-entry before/after type/mode/content identity, bounded
  logical bytes, and a SHA-256 manifest digest. Changed regular-file payloads are content-addressed
  and hash-verified.
- Promotion has one deterministic id and a parent-ledger prepare/settle lifecycle. Settlement is
  `committed`, `rolled_back`, or `unknown`; only committed promotion can produce an accepted check.
- The rollback policy `previous-best` means an incomplete promotion is compensated to the exact
  parent state observed before that candidate. A later rejected candidate never requires rollback
  because it never enters promotion.
- Check evidence records recomputable baseline, previous-best, candidate metric, exact invariant
  observations, decision/reason, stagnation count, candidate child identity, optional delta and
  promotion identity, and cleanup disposition. The controller records best candidate and metric,
  completed candidate count, final stagnation count, and `max_candidates` or `stagnation` stop.
- Candidate cleanup occurs after a durable reject decision or promotion settlement. Cleanup failure
  remains retryable during same-attempt recovery; it cannot erase a committed promotion or turn a
  rejected candidate into an accepted one.

## Proposed authoring contract

```yaml
- id: optimize
  type: optimization
  dependsOn: [baseline]
  optimization:
    baseline: { nodeId: baseline, field: result.value }
    metric: { pointer: /score, direction: minimize }
    invariants:
      - { pointer: /testsPassed, equals: true }
    maxCandidates: 4
    stagnation: { maxConsecutiveNonImproving: 2 }
    rollback: previous-best
    candidate:
      resultNodeId: publish
      workflow: |
        apiVersion: flow.synapti.ai/v1alpha1
        kind: Workflow
        metadata: { id: candidate }
        budget:
          maxNodeStarts: 4
          maxModelTokens: 100000
          maxCostUsd: 1
          maxExecutionMs: 300000
        nodes:
          - id: improve
            type: agent
            agent:
              prompt: Improve the current workspace while preserving its tests.
              model: { provider: anthropic, id: claude-sonnet-4-6 }
              tools: [read, ls, edit]
          - id: measure
            type: command
            dependsOn: [improve]
            command: { executable: node, args: [scripts/measure.mjs] }
          - id: publish
            type: result
            dependsOn: [measure]
            result:
              source: { nodeId: measure, field: command.stdout }
              schema:
                type: object
                properties:
                  score: { type: number }
                  testsPassed: { type: boolean }
                required: [score, testsPassed]
```

## Component and dependency design

```text
workflow schema/compiler
  -> finite optimization expansion + pointer/schema proof
  -> control-graph projection
  -> run reducer (candidate/check/promotion invariants)
  -> application scheduler (exclusive candidate/check waves)
       -> workspace candidate/promotion port
            <- reflink-copy manifest/blob/compensation backend
       -> existing child run machinery
            -> existing Pi/command/verifier executors
```

- Domain code owns schemas, deterministic ids, pointer evaluation, metric comparison, replay
  invariants, and evidence shapes. It imports no filesystem, Git, Pi, or CLI code.
- Application code owns scheduling, child linkage, candidate evaluation inputs, event publication,
  cancellation gates, and recovery ordering.
- Infrastructure owns bounded traversal, no-follow entry observation, content-addressed blobs,
  staging, locks, per-entry apply/compensation, directory sync, and transaction inspection.
- CLI and detached worker continue to compose the same production port; neither owns optimization
  semantics.

The existing `run-workflow.ts` scheduler is already the central graph authority. The implementation
must extract focused optimization helpers rather than letting that file become the filesystem
transaction implementation. The infrastructure backend must reuse/refactor the current workspace
scanner rather than implement a second inconsistent traversal.

## Promotion recovery matrix

| Durable parent state | Local transaction/path observation | Recovery action |
| --- | --- | --- |
| No promotion prepare | No parent replacement allowed | Discard stale staging and re-evaluate the same check |
| Prepared, local commit marker present | Every affected path matches after identity | Append committed settlement and complete the check once |
| Prepared, no commit marker | Every path is before or known applied, rollback payload valid | Compensate applied entries in reverse, append rolled-back settlement, fail the check safely |
| Prepared, live apply fails | Previously applied entries remain classifiable | Compensate immediately, append rolled-back settlement, fail the check |
| Prepared or settled | Any path matches neither recorded before nor after identity | Append/retain unknown evidence, keep artifacts, block run recovery |
| Settled committed, node outcome missing | Parent after identities still match | Append only the missing node outcome; never reapply |
| Settled rolled back, node outcome missing | Parent before identities still match | Append only the missing failed outcome; never promote |

## Criterion verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Contract and compile-time bounds | Contract/error | `npm test -- --run test/unit/workflow/optimization-node-compiler.test.ts test/unit/result/optimization-result.test.ts` | Valid expansion and pointer comparison pass; invalid bounds, schemas, provenance, pointers, waits, ids, and tree sizes reject | Runtime filesystem durability |
| Candidate evaluation and accept-best semantics | Behavioral | `npm test -- --run test/unit/application/run-workflow-optimization.test.ts` | Baseline, improvement, invariant rejection, stagnation, bound, accounting, cancellation, and exclusive ordering pass | Real filesystem/syscall behavior |
| Durable replay and forged-event refusal | Behavioral/error | `npm test -- --run test/unit/run/optimization-reducer.test.ts` | Candidate/check/controller/promotion histories replay; forged metrics, links, deltas, decisions, settlements, and stop reasons reject | Maliciously rewritten storage with a valid external signature |
| Candidate delta fidelity and bounds | Integration/error | `npm test -- --run test/integration/fs/reflink-copy-candidate-delta.test.ts` | Text/binary/create/delete/type/mode/symlink/directory changes capture exactly; protected, special, stale, oversized, and mutated inputs reject | ACL/xattr/owner/time/hard-link preservation |
| Promotion, compensation, and crash recovery | Integration/error | `npm test -- --run test/integration/fs/reflink-copy-candidate-promotion.test.ts` | Accepted changes apply; stale preimages and stable intermediate symlinks refuse; injected failures at every entry boundary commit, compensate, or become unknown as specified | Externally atomic visibility or elimination of hostile same-user pathname races |
| Attached/detached production parity | Integration | `npm test -- --run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts` | Real JSONL parent/child histories, inspection, workspace result, and resume behavior match | Remote/distributed supervisors or unsupported hosts |
| Public contract and example | Documentation/config | `npm test -- --run test/scaffold/community-files.test.ts && node dist/cli/main.js validate examples/bounded-optimization.workflow.yaml` | Required documents and runnable credential-free workflow validate | Benchmark superiority or live provider quality |
| Full repository quality | Config/behavioral | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Formatting, lint, types, tests, build, runtime tests, coverage floors, package install, and audit pass | Operating systems and native filesystems absent from CI |

## TDD implementation order

1. RED/GREEN/REFACTOR RFC 6901 selection, schema compatibility, metric direction, invariant, and
   stagnation domain behavior.
2. RED/GREEN/REFACTOR optimization schema validation, finite expansion, ids, control graph, and
   recursive tree accounting.
3. RED/GREEN/REFACTOR candidate delta traversal, canonical manifest, content blobs, and bounds.
4. RED/GREEN/REFACTOR promotion prepare/apply/compensate/reconcile with injected crash boundaries.
5. RED/GREEN/REFACTOR run events and reducer invariants before scheduler integration.
6. RED/GREEN/REFACTOR application execution, exclusive waves, resource/cancellation behavior, and
   recovery.
7. RED/GREEN/REFACTOR attached/detached CLI composition and inspection.
8. Update every public document and example with scaffold tests, then run adversarial review and the
   full verification map.

## Implementation record

- The compiler expands each source optimization into bounded `--cN--candidate` and `--cN--check`
  nodes plus one controller, persists matching control metadata, rejects nested optimization, and
  requires a top-level graph barrier.
- Domain evaluation implements strict RFC 6901 resolution, typed numeric direction, exact scalar
  invariants, strict improvement, and bounded stagnation over canonical typed results.
- The reflink-or-copy backend captures sorted before/after identities and content-addressed blobs
  under 20,000-entry, 2 GiB logical-delta, and 128 KiB serialized-evidence defaults. Exact durable
  captures reopen idempotently after interrupted event publication. Promotion uses durable rollback blobs,
  deterministic steps, affected-path and removed-directory-closure freshness, a local journal,
  in-process queue, stale-owner cross-process lock, unchanged-ancestor symlink refusal, and
  mutation/crash-cleanup-boundary directory rechecks. Cleanup never recursively removes a staged
  path and skips a temporary whose unchanged ancestor is no longer a real directory.
- Parent events separate evaluation, prepare, settlement, cleanup, check, and controller
  completion. Evaluation persists invariant observations and complete delta entries; replay
  recomputes typed results and the delta manifest digest.
- Successful optimization children retain their workspace for the check. Failed, cancelled, and
  exhausted candidate runs are cleaned and count as rejection/stagnation while their resources are
  still charged. Ordinary child semantics remain unchanged.
- Resume progresses directly from durable check state: evaluated/no-prepare enters promotion,
  prepared/no-settlement reconciles, settled/no-cleanup retries idempotent cleanup, and completed
  boundaries are never repeated. Unknown affected-path state fails with uncertainty.

### Verification record

- Acceptance-focused domain, compiler, reducer, application, delta, and promotion suites: 65 tests
  passed before adversarial review; the expanded promotion suite passes 10 scenarios after review.
- Full host behavioral suite: 80 files and 1,079 tests passed.
- Coverage suite: 80 files and 1,079 tests passed; 83.83% statements, 77.65% branches, 93.31%
  functions, and 83.90% lines.
- Compiled runtime suite: 3 files and 20 process, sandbox, and crash-window tests passed after a
  stable sequential build.
- Type checking, lint, clean build, package installation/CLI execution, and the production
  dependency audit passed; the audit reported zero vulnerabilities.
- Adversarial review first demonstrated that an unchanged intermediate directory replaced by a
  symlink could redirect promotion outside the workspace. The fix validates unchanged ancestors
  before state proof and rechecks all directory ancestors at mutation boundaries.
- A second crash-recovery test demonstrated that staging cleanup could follow the same substituted
  ancestor and remove an external same-name file. Cleanup now verifies containment twice, accepts
  only file/symlink staging entries, uses non-recursive unlink, and leaves unsafe staging untouched
  so reconciliation resolves to unknown.
- The required Graphify refresh completed after the fixes. Its generated report remains the
  authoritative source for volatile node, edge, and community counts, and those generated graph
  artifacts remain outside the release commit.

### Deliberate limits

- The initial evaluator makes one deterministic observation per candidate; it does not estimate
  noise, significance, or confidence intervals.
- Promotion is a recoverable saga, not an externally atomic multi-file transaction. Non-cooperating
  readers may observe intermediate paths, and hostile same-user writers can race portable pathname
  checks despite stable symlink refusal and mutation-boundary revalidation.
- Only `rollback: previous-best` exists. Git-native and native-snapshot adapters may be added only
  behind the same freshness, evidence, and recovery contract.
- Ordinary child workflows never promote changes. Optimization candidates are compiler-generated
  and cannot be constructed by a runtime or provider.
