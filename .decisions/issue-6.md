# Issue #6: model tool policy broker

## Status

Implemented; verification complete locally, pending pull request.

## Outcome

Every model-requested Flow tool operation crosses a runtime-neutral, fail-closed policy boundary before its effect implementation runs. Each decision is attributable, bounded, durable with agent evidence, and independent of Pi/provider types.

## Interface contracts

### Policy operation

- `action` is a semantic Flow action, not an adapter tool name.
- `authority` is derived by Flow from the action and cannot be supplied by an adapter.
- `target` is a canonical or canonically resolved workspace resource.
- attribution contains `runId`, `workflowId`, `nodeId`, and `attempt`.
- `requestDigest` is SHA-256 over the exact versioned attribution, action, authority, and target.

Initial actions are classified as:

| Action | Authority |
| --- | --- |
| `filesystem.read`, `filesystem.list` | `read` |
| `filesystem.write` | `write` |
| `process.execute` | `execute` |
| `network.request` | `network` |
| `credential.read` | `credentials` |
| `filesystem.delete` | `destructive` |

Only `filesystem.read` and `filesystem.list` have effect implementations in this issue.

### Decision

- Outcome is `allowed` or `denied`.
- Reasons are bounded machine-readable values.
- Decisions have attempt-local contiguous sequence numbers.
- A denied operation is recorded and throws before the effect callback.
- The audit closes when the node executor settles; later authorization attempts fail closed.
- At most 64 decisions are retained per attempt.
- Targets are limited to 1024 UTF-8 bytes. Together with existing 64 KiB agent output, this keeps worst-case JSON escaping below the 1 MiB event limit.

### Workspace resolution

- Lexical traversal outside the canonical root is denied.
- Existing symlinks are resolved before authorization.
- For a missing leaf, the nearest existing ancestor is canonicalized so symlinked ancestors cannot escape.
- Canonicalization is broker-owned normalization. File contents or directory entries are not read until an allow decision exists.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Undeclared action | Record `operation_not_declared`; deny before effect |
| Lexical or canonical escape | Record `target_outside_workspace`; deny before effect |
| Oversized target | Record nothing; fail closed before effect because it cannot fit the audit contract |
| More than 64 operations | Fail closed before effect; preserve the first 64 decisions |
| Authorization after node settlement | Fail closed before effect |
| Runtime error after tool use | Preserve policy decisions in bounded agent evidence even when the node fails |
| Old ledger without policy decisions | Parse as an empty policy-decision list |

## Non-goals

- Approval acquisition or grant persistence.
- Write, shell, browser, network, credential, or destructive tool implementations.
- Treating path/process confinement as an operating-system security sandbox.
- Retrying uncertain side effects.

The workspace broker closes the adapter's normal path and symlink-escape cases, but it is not an OS security boundary. A concurrently hostile process can race pathname resolution and use. Untrusted work therefore still requires the later operating-system sandbox gate.

## Acceptance verification map

| Criterion | Verification |
| --- | --- |
| Every model read/list call crosses broker | Workspace-tool unit tests execute Pi definitions and assert ordered decisions |
| Denied effect executes zero times | Workspace broker tests use effect spies for undeclared and escaped targets |
| Exact attribution and digest | Domain broker unit tests compare fields and digest stability/sensitivity |
| Bounded records | Domain tests exercise target, count, and closed-audit limits |
| Durable ordered audit | Agent executor and run replay tests persist and replay policy decisions |
| Runtime independence | Dependency review and typecheck confirm policy domain imports only Flow/Node primitives |
| Source compatibility | Existing compiler and workflow tests remain unchanged and green |

## Implementation

- `src/domain/policy` owns semantic actions, authority classification, bounded decisions, request digests, denials, and audit lifecycle.
- `WorkspacePolicyBroker` owns canonical workspace-target resolution and invokes effects only after authorization.
- The embedded Pi executor creates one broker for each node attempt from the compiled tool allowlist.
- Flow-owned Pi read/list operations receive only broker-wrapped filesystem callbacks.
- Agent evidence carries the closed ordered decision list; replay defaults old ledgers to an empty list and verifies new records.

## Review dispositions

- Fixed a macOS `/var` to `/private/var` alias bug by canonicalizing absolute paths before boundary classification.
- Fixed mutable attribution by retaining a frozen defensive copy in the broker.
- Removed the old standalone path guard so production and tests have one authoritative workspace boundary.
- Centralized policy count and target-size constants between runtime and ledger schemas.
- Added failure-path evidence preservation and late-call denial tests.
- Documented the remaining pathname time-of-check/time-of-use race as part of the trusted-workspace boundary; closing it requires the later OS sandbox slice.

## Verification evidence

- Focused policy, Pi adapter, and replay tests pass.
- Full repository check passes with 132 tests and four compiled-process runtime tests.
- Coverage passes at 87.72% statements and 79.06% branches.
- The 86-file package tarball installs in an isolated project and its installed `flow --help` entrypoint runs.
- Production dependency audit reports zero vulnerabilities; workflow validation and diff integrity pass.
