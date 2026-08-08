# Decision Journal: Issue #44 — Isolated child workflow runs

**Issue**: #44 | **Branch**: `codex/issue-44-isolated-child-runs` | **Started**: 2026-08-08

## Outcome and flows

### User flow

1. An author declares a bounded child workflow and names its unconditional typed result.
2. Flow validates the complete run tree before starting the root run.
3. When the child node becomes ready, Flow durably links a deterministic child run identifier.
4. Flow creates a content-verified copy of the parent working tree in a private child workspace.
5. The child executes with the normal Flow compiler, scheduler, policy, ledger, and executors.
6. Flow discards the child workspace and imports the child's typed result and resource totals.
7. Existing graph consumers use the imported canonical result through `result.value`.

### Operator flow

1. The operator inspects the parent and discovers the child run identifier from durable node state.
2. The operator can inspect the child ledger independently with the existing CLI.
3. Cancelling the root worker propagates the same cancellation signal through active descendants.
4. A resumed root worker reopens the linked child ledger and workspace rather than spawning unrelated work.

### System recovery flow

1. A parent `node_started` event records the child identity before workspace materialization.
2. No child ledger means the linked attempt may safely recreate its workspace and start once.
3. A non-terminal child ledger requires the exact existing workspace and uses normal child recovery.
4. A terminal child ledger is authoritative even if cleanup completed before the parent outcome append.
5. Missing or divergent state fails closed; Flow never silently creates a replacement for an uncertain child.

## Research evidence

- Prime Agent assigns one worker process to a root session tree and every descendant. This avoids routing descendants back through supervisor capacity while containing a root-tree crash to one worker: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/daemon.md>
- Temporal child workflows use independent event histories and explicit parent-close semantics. Separate history is useful for recovery and workload partitioning, not merely code organization: <https://docs.temporal.io/child-workflows>
- OMP provides bounded typed subagent output, recursion limits, workspace isolation backends, and patch/branch integration. Its child sessions remain runtime-owned, so Flow adopts the mechanics but not the authority model: <https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md>
- Pi's subagent example launches separate sessions/processes for single, parallel, and chained tasks, but does not define Flow's durable graph, budget, or recovery semantics: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts>
- Argo WorkflowTemplates demonstrate reusable workflow definitions, but definition reuse alone does not provide an independent child history: <https://argo-workflows.readthedocs.io/en/latest/workflow-templates/>

## Architecture approaches

| Approach | Summary | Simplicity | Flexibility | Recovery | Runtime independence | Effort | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. Compile-time graph expansion | Inline every child node into the parent DAG | High | Low | One ledger is simple | High | Small | High: no isolated child identity/history; large parents |
| B. Supervisor-submitted child | Submit each child as another detached root job | Medium | High | Separate ledgers | High | Medium | High: parent can occupy the final worker slot and deadlock its child |
| C. Runtime subagent tool | Delegate to Pi/OMP task/subagent machinery | High | Medium | Runtime-specific session recovery | Low | Small | High: model/runtime owns spawn, policy, and completion |
| D. Root-tree child scheduler | Keep one worker per root tree; run independently-ledgered children inside it | Medium | High | Separate histories with deterministic parent linkage | High | Large | Medium |

### Decision

Use **D, root-tree child scheduler**.

The supervisor remains a capacity router for root trees. The existing application scheduler owns child
admission and recursively invokes the same Flow run machinery inside the root worker. Each child receives
an independent run identifier, ledger, isolated workspace, budget, cancellation signal, and typed result.
The parent persists only a bounded linkage and result/resource projection.

### Rejected assumptions

- A process boundary is not a security boundary when processes share the same operating-system user.
- A nested model session is not a child workflow unless the Flow graph and ledger own its lifecycle.
- A separate child budget is insufficient unless its actual resource totals are also charged to ancestors.
- A Git worktree at `HEAD` is not an exact snapshot of a dirty working tree.
- Automatically applying a child patch is not safe before candidate validation and rollback are implemented.

## Workspace approaches

| Approach | Dirty/untracked state | Git metadata | Portability | Performance | Decision |
| --- | --- | --- | --- | --- | --- |
| Detached Git worktree | No, without an additional overlay | Shared | High | High | Reject as incomplete |
| Reflink-or-copy working-tree snapshot | Yes | Independent copied metadata | High | Medium; fast on CoW filesystems | **Initial backend** |
| Native PAL (APFS/Btrfs/ZFS/overlay/ProjFS) | Yes | Backend-dependent | Medium | High | Future backend behind the same port |

The initial backend recursively snapshots the current working tree, excludes Flow's own state, attempts
copy-on-write file cloning, falls back to ordinary copying, preserves symbolic links without following
them, rejects special files, uses owner-only metadata, and materializes through an atomic rename.
Production composition stores identities beneath `<runs-dir>/.workspaces`. The snapshot request
therefore carries every protected path; the backend normalizes in-tree exclusions relative to the
canonical source, binds the sorted policy into its manifest and digest, and rejects recovery under a
different policy. This covers custom run directories rather than relying only on the `.flow` name.

## Interface contracts

- Authoring contract: a `child` node contains a bounded embedded workflow source and an explicit
  `resultNodeId`.
- The embedded source is compiled recursively with strict depth, source-byte, and total-tree-node limits.
- A child workflow must declare all resource ceilings, cannot contain human approval waits, and must name
  an unconditional terminal `result` node.
- The deterministic child run id is derived from the parent run id, parent node id, and attempt.
- The parent start event contains the child run id, child workflow id/digest, result node/schema identity,
  and isolation backend before any workspace mutation.
- A successful child evidence record contains the canonical result, child terminal sequence, resource
  totals, and cleanup disposition.
- Child resource totals are added to every ancestor; the parent's own child-node start is counted
  separately.
- Ready children may share a scheduler wave only with other children. This freezes the parent workspace
  while all snapshots in the wave are taken.
- The process-global SRT backend cannot host incompatible workspace sessions simultaneously. Its
  coordinator queues the second workspace outside the manager lock, honors cancellation, and
  initializes it only after the active session fully resets. Child scheduling remains concurrent;
  SRT-backed command phases serialize until a backend with independent sessions is selected.
- Child changes are discarded. Patch export, merge, promotion, and rollback are optimization-loop work.

## Coupling and dependency direction

```text
CLI / detached worker
        |
        v
application run scheduler ----> workspace-isolation port
        |                               ^
        v                               |
domain workflow + run events     infrastructure snapshot backend
        |
        v
existing command / Pi executors
```

The domain contains compiled child identity and replay validation but no filesystem or Pi types. The
application coordinates nested runs through existing ports. Infrastructure implements only materialize,
reopen, and cleanup mechanics.

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Invalid or oversized embedded workflow | Compilation rejects the root before any run event |
| Child ceiling exceeds parent remaining budget | Parent child node fails before workspace creation |
| Crash before child ledger creation | Recreate the linked workspace and start the deterministic child once |
| Crash with non-terminal child ledger | Reopen the exact workspace and resume the exact child |
| Missing workspace for non-terminal child | Fail closed with typed recovery error |
| Child reaches a human wait | Compiler rejection; runtime treats it as an invariant violation |
| Child fails or exhausts budget | Parent child node fails with linked evidence and imported resources |
| Parent cancellation | Same signal cancels descendants; no later child starts |
| Cleanup failure | Parent fails with a bounded cleanup error and records retained disposition |
| Corrupt or mismatched child evidence | Parent replay rejects it |
| Snapshot contains socket/device/FIFO | Snapshot creation rejects it before child execution |
| Snapshot resource exhaustion | Child fails without changing the parent workspace |
| Concurrent SRT commands use different child workspaces | Queue the incompatible session; never reject it or overlap SRT reset/initialize |

## Non-goals

- Does not apply, merge, or export child workspace changes.
- Does not provide interactive approvals inside children.
- Does not discover child workflows from packages or remote registries.
- Does not distribute descendants to other machines or supervisor workers.
- Does not claim VM-grade security isolation.
- Does not preserve opaque provider sessions across a process crash.

## Criterion verification map

| Criterion group | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Compilation and contract bounds | Contract/error | `npm test -- --run test/unit/workflow/child-node-compiler.test.ts` | Valid child compiles; invalid result, waits, budgets, depth, and sizes reject | Package refs or remote workflows |
| Replay and typed composition | Behavioral | `npm test -- --run test/unit/run/child-node-reducer.test.ts` | Link/evidence replay and all result consumers pass; forged projections reject | Maliciously signed ledgers |
| Execution, accounting, cancellation, recovery | Behavioral | `npm test -- --run test/unit/application/run-workflow-child.test.ts` | Separate ledger, inherited signal, resource import, exact recovery | Host reboot with missing storage |
| Filesystem isolation | Integration/error | `npm test -- --run test/integration/fs/reflink-copy-workspace-isolator.test.ts` | Dirty/untracked/symlink snapshot fidelity, parent unchanged, special-file refusal, cleanup | Native snapshot backends |
| Attached and detached CLI | Integration | `npm test -- --run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts` | Real JSONL parent/child histories and inspectable result | Remote supervisor |
| Full repository quality | Config/behavioral | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | All gates pass; coverage remains above project threshold | Other operating systems not exercised by CI |

## Implemented composition and recovery notes

- Foreground `run` and `resume` and detached workers construct the same production workspace
  isolator from the resolved run root.
- The child ledger is the execution commit marker. A durable parent start with no child event may
  clean a stale pre-ledger directory and recreate it because child execution begins only after
  `run_started` appends. Any child event switches recovery to exact reopen-only behavior.
- Terminal child failure, cancellation, and exhaustion remain terminal histories and import linked
  evidence; successful-only graph completion is not used as a proxy for run terminality.
- Live conditions/results/approvals and model-verifier inputs share one typed-result projection for
  both local result controls and imported child evidence.
- Attached and detached integration tests verify independent JSONL histories, typed import, and
  cleanup. A production sibling-SRT integration test is retained for an environment that permits
  the runtime's local Unix-domain sockets.

## Adversarial review corrections

- Cancellation after a child has durably succeeded and its workspace is discarded imports that
  success before terminalizing the parent as cancelled. Rewriting the child outcome would contradict
  its ledger and fail replay.
- Cancellation after the parent child-node start but before child materialization records
  `child_cancelled_before_start` with no evidence and no side effects. No workspace or child ledger
  exists in that window.
- Replay enforces the exact relationship between child outcome, cleanup disposition, and parent
  failure code. A retained workspace requires `child_workspace_cleanup_failed`; a discarded failed,
  cancelled, or exhausted child requires its matching `child_run_*` code.
