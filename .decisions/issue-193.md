# Issue #193: Version-anchored whole-file replacement

## Outcome

An authorized agent can replace the complete content of an existing UTF-8 workspace file without
replaying the prior content. The operation is bound to the exact SHA-256 version returned by
`flow_read`, preserves the file mode, and uses the established durable edit effect protocol.

## Interface contract

- Workflows select the `replace` agent tool and receive `flow_replace`.
- Input contains only `path`, `expectedSha256`, and complete replacement `content`.
- The target must be an existing regular UTF-8 file inside the execution workspace.
- The expected digest must match the target immediately after the read and again before commit.
- Content is valid Unicode, bounded to 262,144 UTF-8 bytes, and must change the target.
- Success returns the exact before and after SHA-256 identities.

## Failure modes

- Invalid input, invalid target, invalid UTF-8, oversized files, stale versions, and no-op
  replacements fail before commit.
- Same-target operations share the in-process queue and cross-process lock with exact edits and
  creates.
- Cancellation or failure after durable preparation but before rename settles `not_applied`.
- Failure after rename settles `unknown`; restart reconciliation compares exact content identities
  and mode without retaining content.

## Alternatives considered

1. Increase the 64-decision policy limit. Rejected because it weakens a fixed audit bound and does
   not remove duplicated old-file context.
2. Add range-delete or truncate operations. Deferred because their positional semantics become
   stale under concurrent edits and do not directly express the desired final state.
3. Add a version-anchored complete replacement. Selected because it is one bounded desired-state
   operation and composes with the existing atomic replacement and recovery boundary.

## Non-goals

- Binary-file replacement.
- Append, patch, fuzzy matching, recursive directory changes, or permission-mode changes.
- Increasing policy, effect, model, or workflow budgets.
- Treating the tool result as proof that downstream behavior is correct; verifiers remain required.
