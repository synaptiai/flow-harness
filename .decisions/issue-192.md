# Decision journal: Issue #192 — Add durable agent directory creation

**Issue:** #192  
**Branch:** `codex/issue-192-durable-agent-mkdir`  
**Started:** 2026-08-27

## Specification

_Captured by the specification-capture skill on 2026-08-27. Source: extracted from issue #192._

### Non-goals

- Do not create missing parents recursively.
- Do not remove, rename, move, chmod, or populate a directory implicitly.
- Do not add rollback deletion or claim that Git tracks an empty directory.
- Do not broaden the host-side agent sandbox or treat same-host locking as protection from a
  hostile operating-system user.
- Do not retry an open or uncertain directory effect automatically.

### Failure modes

- **Cancellation:** Cancellation before `mkdir` settles a prepared effect as not applied and leaves
  no target. Cancellation after `mkdir` records an unknown effect and retains the target.
- **Partial failure:** Failure after directory creation or before durable parent synchronization
  records unknown. Flow preserves the directory for inspection and blocks terminal success.
- **Invalid input:** An invalid, protected, outside-workspace, existing, symlink, or NUL-containing
  target is rejected without a committed effect.
- **Missing context:** A missing or non-directory parent fails before target mutation. Flow doesn't
  infer or create any ancestor.
- **Resource exhaustion:** Effect-limit exhaustion denies the call before prepare. Filesystem quota
  and permission failures settle not applied when `mkdir` didn't create the target.
- **Concurrent change:** Same-host Flow calls serialize on the exact target. Recovery returns
  unknown if the target changes while Flow observes it.

### Interface contracts

- The workflow selector is `mkdir` and the public model tool is `flow_mkdir`.
- The strict input is `{path: string}` with no additional properties.
- The tool uses `filesystem.write`, `write` authority, sequential execution, and the existing
  32-effect attempt ceiling.
- The durable effect kind is `filesystem.mkdir` under `flow.effects/v1`.
- The prepared state has an absent pre-state, the SHA-256 of the canonical empty directory listing,
  and mode `0755`.
- Success identifies the requested relative path and mode without exposing an absolute host path.

## Architecture decision

### Context

The second external field task must add a package directory. Flow's file-creation tool requires an
existing parent. Operator pre-provisioning would invalidate the autonomous execution claim, while
recursive parent creation would combine several authority-bearing effects in one request.

### Options

1. Pre-provision the empty directory outside Flow.
2. Make `flow_create` create all missing parents implicitly.
3. Add one explicit, exclusive, nonrecursive `flow_mkdir` effect.

### Decision

Use option 3. One tool request maps to one policy decision, one exact target, one prepare event, one
filesystem mutation, one settlement, and one recovery observation. The design composes with
`flow_create` without changing that tool's contract.

### Consequences

- Workflow schemas, public tool composition, effect recording, event replay, recovery observation,
  generated documentation, and field workflows gain one new discriminated kind.
- The canonical empty-directory state uses SHA-256 over zero bytes. This reuses the v1 receipt
  fields without claiming a hash for later directory contents.
- Recovery can prove an applied open effect only while the directory remains empty, unchanged, and
  mode `0755`. Every weaker observation is unknown.
- The implementation must synchronize the parent directory before committed settlement.

## Dependency and flow map

1. A workflow author selects `mkdir` on one agent node.
2. The compiler snapshots that exact tool authority.
3. The Pi composition exposes `flow_mkdir` only when an effect journal exists.
4. The broker authorizes one normalized target and operation digest.
5. The effect recorder durably prepares `filesystem.mkdir` before the syscall.
6. The filesystem adapter creates one directory, verifies its empty state and mode, synchronizes
   the parent, and settles the effect.
7. Terminal agent evidence contains the matching receipt.
8. Restart reconciliation inspects an unresolved prepared effect without rerunning the agent.

Dependency direction remains domain workflow and event contracts → application ports → Pi and
filesystem adapters → CLI composition. No domain module imports infrastructure.

## Verification map

| Criterion | Type | Command | Expected evidence | Doesn't promise |
| --- | --- | --- | --- | --- |
| Workflow and tool contract | Contract | `npm run test -- --run test/unit/workflow/compiler.test.ts test/unit/infrastructure/pi/workspace-mkdir-tools.test.ts` | Both suites pass; exact name and schema assertions pass. | No library API. |
| Exclusive durable creation | Behavioral | `npm run test -- --run test/unit/infrastructure/fs/exclusive-directory-create.test.ts` | Exclusive, mode, lifecycle, cancellation, concurrency, and uncertainty cases pass. | No recursive parents or deletion. |
| Replay and recovery | Data and error handling | `npm run test -- --run test/integration/fs/durable-effect-journal.test.ts test/integration/fs/durable-effect-reconciliation.test.ts` | JSONL reopens; applied and unknown states remain exact; executor isn't rerun. | No hostile-user isolation. |
| Public docs match production | Contract | `npm run docs:capabilities:check && npm run docs:style && npm run docs:links && npm run docs:ste` | Generated catalog is current and documentation gates pass. | No stable compatibility claim. |
| No regressions | Behavioral | `npm run check && npm run test:browser && npm run test:coverage && npm run pack:check` | Full project gates pass with required coverage. | Hosted Linux proof remains a separate gate. |

