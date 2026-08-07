# Decision Journal: Issue #16 — Hash-anchored edits with durable provenance

**Issue**: #16 | **Branch**: `codex/issue-16-hash-anchored-edit` | **Started**: 2026-08-07

---

## Context

Flow agent nodes currently receive only Flow-owned `read` and `ls` tools. That is a useful analysis
harness but not yet a coding harness: the model cannot implement a change. The first write capability
must preserve Flow's core distinction between the Pi agent loop, Flow policy, workspace effects, and
authoritative run evidence.

The installed Pi runtime includes an exact-replacement edit definition, pluggable filesystem
operations, and a same-file mutation queue. Its current implementation does not require a
model-supplied file version, uses a direct `writeFile`, and may fall back to fuzzy Unicode and
whitespace normalization. OMP's standalone Hashline package adds compact line hashes,
snapshot-backed stale recovery, and all-or-nothing multi-file preflight, but its current package is
coupled to OMP's Bun/native stack and its recovery semantics intentionally merge stale edits. SRT
can contain an external patch helper, but containment alone does not define edit conflicts,
authorization digests, atomicity, or durable evidence.

## Specification

_Captured by specification-capture skill on 2026-08-07. Source: extracted-from-issue and upstream
dependency analysis._

### Non-goals

- Creating, deleting, renaming, or moving files.
- Fuzzy matching, line-hash shorthand, stale-snapshot recovery, or automatic three-way merge.
- A multi-file transaction, patch language, shell/command tool, network tool, or approval UI.
- LSP diagnostics, automatic formatting, generated-file detection, or repository-wide validation.
- Hostile-workspace TOCTOU resistance equivalent to a VM or kernel-enforced agent sandbox.
- Importing OMP's Hashline package, native helpers, snapshots, or Bun runtime.
- Making Pi's built-in edit schema, matching rules, write implementation, or evidence authoritative.

### Failure modes

- **Stale version** — The full SHA-256 supplied by the model differs from the bytes read immediately
  before preflight. The target is unchanged; no recovery is attempted.
- **Invalid target** — Missing files, directories, non-regular files, invalid UTF-8, oversized files,
  outside-workspace paths, canonical symlink escapes, `.flow`, `.git`, environment files, key files,
  and caller-protected paths fail before mutation.
- **Invalid edit** — Empty, missing, duplicate, ambiguous, overlapping, no-op, oversized, or malformed
  replacements fail as one unit before a temporary file is created.
- **Pre-commit I/O failure** — Temporary-file creation, permission preservation, write, or file-sync
  failure removes the temporary file and leaves the original path unchanged.
- **Concurrent Flow edit** — Operations for one canonical file are serialized in-process and use a
  target-local exclusive owner record across same-host processes. A live owner fails with
  `target_busy`; an exited same-host owner is recoverable; incomplete, corrupt, or foreign-host
  ownership fails closed. Every admitted operation re-reads and revalidates its own expected hash.
- **Concurrent external edit** — The version check detects changes that happen before the final
  read. The owner record is cooperative rather than a security boundary: a hostile or non-Flow
  process can still race path operations after canonical authorization. This slice retains the
  documented trusted-workspace limitation.
- **Post-rename failure** — Abort or directory-sync failure after atomic rename records an uncertain
  receipt and forces an uncertain node failure; it is never reported as side-effect-free.
- **Later agent failure** — If a write committed and the provider later errors, times out, is
  cancelled, or exceeds output bounds, node failure evidence retains the receipt and reports at
  least committed side-effect status.
- **Audit exhaustion/closure** — Policy/effect capacity is reserved before mutation. Closed or full
  audit state prevents a new effect rather than allowing an unrecorded write.

### Interface contracts

- Workflow YAML may declare `agent.tools: [read, ls, edit]`; tool names remain unique and bounded.
- Pi receives only corresponding `flow_read`, `flow_ls`, and `flow_edit` custom definitions. Ambient
  Pi tools remain disabled.
- `flow_read` preserves Pi's paging/truncation behavior and appends a full-file
  `sha256:<64-lowercase-hex>` version token derived from the exact bytes used by that read call.
- `flow_ls` performs one sorted, bounded directory read behind one logical policy authorization; it
  does not consume one audit decision per entry.
- `flow_edit` accepts one existing-file path, one expected SHA-256, and one to 32 exact
  `{oldText,newText}` replacements containing valid Unicode scalar values and matched against the
  same original UTF-8 content. Total input, target, and file sizes are bounded.
- Each edit authorizes `filesystem.write` for the canonical target. The policy decision binds an
  operation digest covering the exact public request without persisting replacement text.
- A committed or uncertain effect receipt records version, sequence, run/workflow/node/attempt,
  canonical target, operation digest, before SHA-256, after SHA-256, and outcome.
- Run replay validates receipt ordering, attribution, digest shape, and its matching allowed policy
  decision. Existing version-1 ledgers without operation digests or receipts still parse and replay.
- The editor uses a same-directory exclusive temporary file, preserves target mode, syncs file
  content, atomically renames, and attempts directory sync before reporting committed success.

## User and system flows

### Successful edit

1. The workflow compiler accepts an agent node that explicitly declares `read` and `edit`.
2. `flow_read` returns bounded content and the full-file SHA-256 version.
3. The model calls `flow_edit` with that version and exact replacements.
4. Flow canonicalizes and checks the target, reserves evidence capacity, binds the request digest to
   a `filesystem.write` policy decision, and enters the canonical same-file queue and same-host
   cooperative lock.
5. Flow re-reads the file, rejects stale or invalid input, creates and syncs a same-directory
   temporary file, renames it atomically, and syncs the directory.
6. The tool records the before/after receipt and reports the new SHA-256 to the model.
7. The executor closes policy/effect audits and persists them with the node outcome.

### Rejected edit

1. Flow records any attributable policy decision available before the rejection.
2. It fails before rename and removes a temporary file if one was created.
3. The model may correct a stale or malformed request within the same bounded node turn.
4. No effect receipt exists because no target mutation committed.

### Uncertain post-commit outcome

1. Rename commits the new bytes.
2. Abort or a durability acknowledgement fails before normal completion.
3. Flow records an uncertain before/after receipt.
4. The node fails with uncertain side-effect status even if the model later emits a terminal answer.

## Coupling analysis

- Workflow types own the declared tool vocabulary; they import no Pi or filesystem types.
- Policy owns semantic authority and authorization digests; it does not execute edits.
- Run evidence owns persisted receipt shape and replay invariants; it stores no edit payload.
- A Flow filesystem adapter owns exact matching, byte hashes, serialization, atomic replacement,
  path-local mutation queues, and same-host cooperative owner records.
- The Pi adapter owns TypeBox presentation, read-result version annotation, cancellation translation,
  and collection of effect receipts. Pi never writes through its built-in edit implementation.
- The application scheduler receives only the final node outcome and cannot be advanced by a tool.
- SRT remains the command-execution boundary. This edit runs in the host adapter and therefore keeps
  the existing trusted-workspace limitation explicit until agent/tool process isolation lands.

## Options considered

| Option | Simplicity | Flexibility/performance | Coupling and safety | Disposition |
| --- | --- | --- | --- | --- |
| Flow-owned hash edit presented through Pi's custom-tool API | Moderate implementation; one new direct TypeBox dependency | In-process and low overhead; exact Flow contract can evolve | Flow owns conflict, atomicity, policy, and evidence; trusted-host TOCTOU remains | **Chosen** |
| Pi `createEditToolDefinition` with Flow filesystem operations | Smallest adapter delta; reuses queue and diff code | Good interactive behavior | No public version anchor; fuzzy normalization and result shape are Pi semantics; direct-write default must be replaced | Rejected for authoritative path; retained as reference |
| Import OMP `@oh-my-pi/hashline` | Rich patching, snapshot recovery, multi-file preflight | Best compact-edit UX | Bun/native dependencies, short session hashes, and stale auto-merge conflict with first-slice guarantees | Deferred benchmark/reference |
| Execute a packaged patch helper through SRT | Reuses OS containment and process evidence | Process startup and payload transport per edit; portable helper packaging required | Still needs Flow-owned conflict/atomicity/evidence protocol; complicates iterative model turns | Deferred until agent tool isolation |
| Produce a patch artifact and apply it in a later command node | Simple audit separation and explicit graph boundary | Prevents iterative edit/test loops inside one agent node | Safest for batch workflows but too awkward as the only coding primitive | Retained as future workflow pattern |

## Decision

Implement a Flow-owned `flow_edit` custom Pi tool. Use a full SHA-256 of exact file bytes as the
optimistic-concurrency token; require exact unique replacements; fail closed on stale content;
coordinate cooperating same-host Flow processes; and atomically replace one existing regular UTF-8
file. Do not copy Pi or OMP source. Adopt their proven ideas—same-file serialization, preflight
before write, version anchors, and pluggable boundaries—as independently implemented Flow
contracts.

Add effect receipts distinct from policy decisions. A policy decision proves that an exact request
was authorized; a receipt proves whether bytes committed. Bind them with a shared operation digest
and validate the relationship during replay. This prevents the ledger from treating authorization
as evidence of execution.

## Consequences

- Flow becomes capable of implementing real coding changes without exposing shell or ambient Pi
  tools.
- Concurrent modifications fail visibly instead of being silently merged.
- A direct TypeBox dependency is required because custom Pi tool schemas use TypeBox; the version is
  pinned to Pi's installed version and recorded in third-party notices.
- The first edit surface is intentionally narrower than Pi and OMP; broader patching must earn its
  place through benchmarks and preserve the same policy/evidence contracts.
- Host-side path races remain an explicit limitation. Agent process containment is the next security
  slice before claiming untrusted-repository execution.
- Same-host owner records prevent concurrent Flow edits but are neither a distributed lease nor a
  defense against non-cooperating workspace processes.
- The durable event ceiling is 2 MiB. A 1 MiB ceiling was insufficient because JSON escaping can
  expand each bounded control byte sixfold when maximum policy, receipt, output, and error evidence
  share one failed-node record.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Schema explicitly declares edit | Contract | `npx vitest run test/unit/workflow/compiler.test.ts -t "edit"` | Valid edit compiles; duplicates/unknown tools fail | Approval grant |
| Read produces exact version token | Adapter | `npx vitest run test/unit/infrastructure/pi/workspace-read-tools.test.ts -t "version"` | Token equals SHA-256 of the exact read bytes, including paged output source | Whole-file display |
| Exact current edit commits atomically | Behavioral | `npx vitest run test/unit/infrastructure/fs/hash-anchored-edit.test.ts -t "commits"` | Target has complete new content, preserved mode, no temp file | Multi-file transaction |
| Stale/invalid/preflight cases do not mutate | Error handling | `npx vitest run test/unit/infrastructure/fs/hash-anchored-edit.test.ts -t "rejects"` | Before/after target bytes match for every rejection | Fuzzy recovery |
| Workspace and protected paths fail closed | Security | `npx vitest run test/unit/infrastructure/pi/workspace-read-tools.test.ts test/unit/infrastructure/policy/workspace-policy-broker.test.ts -t "edit|protected"` | Effect is not invoked; attributable denial exists | VM-grade hostile-path safety |
| Policy authorization is bound to effect receipt | Evidence | `npx vitest run test/unit/policy/broker.test.ts test/unit/run/reducer.test.ts -t "operation digest|effect receipt|side-effect status"` | Replay rejects tampering and accepts old receipt-free ledgers | Payload recovery from digest |
| Failure/cancellation reports committed or uncertain effects | Lifecycle | `npx vitest run test/unit/infrastructure/pi/pi-agent-executor.test.ts -t "edit receipt|active edit reservation"` | No post-write failure is classified side-effect-free | Automatic reconciliation |
| Public contracts are accurate | Documentation | `npx vitest run test/scaffold/community-files.test.ts test/unit/workflow/compiler.test.ts` | README/docs/examples align with executable schema | Future tools |
| Complete project remains releasable | Regression | `npm run check && npm run test:coverage && npm run pack:check` | All local CI-equivalent gates and package inspection pass | Live provider availability |

## Adversarial review dispositions

| Finding | Disposition | Evidence |
| --- | --- | --- |
| A failed agent event could claim a committed effect without a receipt | Fixed | Replay now rejects the inconsistent event and retains old receipt-free ledger compatibility |
| One allowed write decision could authorize multiple receipts | Fixed | Replay consumes each matching write decision exactly once |
| A write operation digest was optional at the broker boundary | Fixed for new authorization; compatibility retained only in historical event decoding | The domain write variant requires the digest and runtime validation rejects omission |
| Nested sensitive names and lexical symlink aliases could evade a narrower protected-name check | Fixed | Both lexical and canonical targets are checked; nested `.git`/`.flow`, environment files, and private-key names are covered |
| A malformed UTF-16 surrogate could be rewritten as a replacement character | Fixed | Edit input rejects non-scalar strings before target access |
| A large listing could exhaust the per-attempt decision budget | Fixed | Flow-owned `flow_ls` uses one logical authorization and bounded sorted output |
| Timeout cleanup could close evidence while an edit reservation was still active | Fixed | Executor cleanup waits for the runner and effect recorder; unresolved cleanup is classified uncertain |
| Same-process serialization did not coordinate two Flow processes | Fixed within the trusted same-host scope | Target-local owner records block live owners and recover exited owners; hostile external races remain a documented non-goal |
| Maximum bounded agent evidence could exceed the old serialized-record ceiling after JSON escaping | Fixed | Event ceiling is 2 MiB and the maximal escaped event persists and replays |
| Package builds could retain deleted files in `dist/` | Fixed | Build removes `dist/` first and package inspection rejects stale modules |
| The SDK integration proved session composition but not a real custom-tool turn | Fixed | Deterministic real Pi integration performs `flow_read`, consumes its marker, calls `flow_edit`, and completes |

## Implementation tasks

1. Extend workflow and policy contracts with edit authority and operation-digest binding.
2. Add versioned effect receipts and replay integrity rules with backward-compatibility tests.
3. Implement and test the bounded exact-edit and atomic-replacement filesystem primitive.
4. Present enhanced read and edit definitions through the Pi adapter; add protected-path checks.
5. Thread receipt lifecycle through timeout, cancellation, output-limit, error, and success outcomes.
6. Add an executable example and update every public status/boundary/testing document.
7. Run local CI, coverage, runtime, package, clean-consumer, dependency audit, and adversarial review.

## Research references

- Pi custom tool API and extension model: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi edit implementation: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/edit.ts>
- OMP Hashline protocol: <https://github.com/can1357/oh-my-pi/blob/main/packages/hashline/README.md>
- OMP package/recovery release history: <https://github.com/can1357/oh-my-pi/releases>
- Anthropic Sandbox Runtime architecture and limits: <https://github.com/anthropic-experimental/sandbox-runtime>
