# Decision journal: Issue #153 — Retain oversized artifacts by policy-controlled reference

**Issue**: #153
**Branch**: `codex/issue-153-artifact-references`
**Started**: 2026-08-22

## Exploration

### User, operator, and system flows

1. **Retain** — A Flow-owned tool produces output larger than its model preview. Flow stores the
   exact bounded bytes and returns only a preview plus an opaque reference.

2. **Read** — An agent with an explicitly selected artifact tool requests one bounded byte window.
   Flow checks the active run and records a policy decision. It verifies the complete blob and
   returns only the requested window.

3. **Inspect** — An operator inspects immutable provenance and current physical availability without
   loading the artifact contents.

4. **Release and retain** — An operator changes whether one immutable reference protects shared
   content from pruning. This action does not rewrite the producing run or artifact descriptor.

5. **Prune** — An operator first receives a deterministic plan. Applying that exact plan removes
   only content that has no retained references and no active reader.

6. **Recover** — Flow replays the artifact catalog and run ledger independently. Missing or changed
   content remains unresolved evidence. Recovery never reconstructs it from a preview or summary.

### Existing patterns

- The authoritative run ledger already records exact agent-command preparation and settlement.
- Command streams already have full-stream SHA-256 digests and bounded model-facing previews.
- The capability package store already demonstrates content-addressed bytes, exact descriptors,
  deterministic pruning, and safe opened-inode verification.
- The policy broker records attributed decisions for each selected agent tool.
- Public run projection already removes private capability and resource bytes.

### Research conclusions

- OCI content descriptors bind media type, digest, and raw byte count. Flow checks retrieved content
  against its digest and size.

- RFC 9530 distinguishes content integrity from representation metadata. Flow hashes exact raw bytes
  and treats previews as derived representations.

- Bazel Remote Execution stores and verifies blobs by digest and size. It supports bounded reads and
  explicit missing-blob state.

- W3C PROV distinguishes an entity from the activity and agent that generated it. Flow therefore
  records a producer tuple instead of treating the digest as provenance.

- Nix garbage collection protects content through roots rather than content identity alone. Flow
  similarly keeps retention authority separate from blob identity.

## Decision

### Considered approaches

| Approach | Summary | Advantages | Disadvantages | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| A: Run-scoped stores | Keep one content store and manifest below each run. | Simple authorization and deletion; no cross-run namespace. | Duplicates bytes; makes shared retention expensive; detached and child cleanup become fragmented. | Medium | Medium |
| B: Project content store with run-owned references | Deduplicate blobs project-wide. Keep immutable producer references in run evidence and mutable availability or retention in a separate catalog. | Exact provenance; deduplication; deterministic shared pruning; no run-history rewrite; matches Flow boundaries. | Requires careful two-record settlement and strict cross-run authorization. | Large | Low |
| C: Embed artifacts in the run ledger | Append chunk records directly to JSONL run history. | One durable source and simple replay. | Unbounded ledgers, expensive inspection, no practical deduplication or pruning, and greater public-projection risk. | Medium | High |
| D: Reuse the capability package store | Treat run artifacts as another package-blob family. | Reuses mature CAS and pruning code. | Conflates trusted installed capabilities with untrusted ephemeral outputs and gives them incompatible retention and authority semantics. | Small | High |

**Approved approach**: B, a project content store with immutable run-owned references and a separate
availability and retention catalog.

The digest is only a byte identity. A Flow reference is a separate canonical digest over the exact
descriptor, producer tuple, originating run, and retention class. Reads require both the reference
and the matching active run. The policy broker records an `artifact.read` decision before the store
opens any blob.

Agent-command stdout and stderr are the first retained producer family. The command executor keeps a
bounded exact capture in addition to the existing preview. It publishes an artifact only when the
stream exceeds the preview bound and remains within the 1 MiB command-capture bound. The generic
artifact object contract remains 16 MiB for producers that don't require in-memory command capture.
The durable command settlement embeds the resulting immutable reference. A failed command
settlement does not disclose the unpublished reference to the model.

The project catalog owns physical availability and the reference retention flag. The run ledger owns
producer provenance. Inspection joins these two facts but does not turn current availability into
historical provenance. Pruning requires an exact plan digest and serializes with reads, retention
changes, and publication under one local cross-process lease.

### Consequences

- Identical output bytes use one physical blob but keep independent run references and producers.

- Run history stays append-only when an operator releases, retains, or prunes content.

- A blob can be physically missing while its immutable reference remains valid unresolved evidence.

- Artifact reads add explicit read authority. Retention and pruning remain operator-only CLI actions.

- The existing artifact budget continues to count logical retained executor evidence. CAS capacity
  and per-artifact bounds are separate from the run budget.

## Specification

_Captured by the specification-capture skill on 2026-08-22. Source: user-approved Approach B and
Issue #153._

### Non-goals

#### Storage and authority

- This slice does not add remote storage, cross-project sharing, distributed garbage collection, or
  background pruning.
- A digest, storage path, preview, or public inspection response is not an authorization token.
- The model cannot retain, release, or prune artifacts.

#### Compatibility and recovery

- Flow-generated run, event, inspect, approval, presentation, and export fields do not embed retained
  blob bytes or local paths. An authorized agent can quote a byte window in its normal output.
- This slice does not resume partial uploads or reconstruct missing bytes.
- This slice does not replace the run artifact budget or claim a project disk quota.

### Failure modes

- **Timeouts and cancellation** — Each precommit asynchronous filesystem and policy boundary checks
  the caller signal. Cancellation before durable publication changes no catalog authority. After a
  commit boundary, Flow settles deterministically and returns the verified committed result without
  consulting the caller signal again.

- **Partial failures** — A blob becomes visible before its catalog reference. An unreferenced blob is
  an orphan eligible for deterministic pruning. A catalog append or directory-sync failure returns a
  fixed uncertainty error and never invents a clean success.

- **Invalid input** — Strict schemas reject unknown fields, invalid Unicode, and invalid media types.
  They also reject malformed references, unsafe identities, invalid offsets, and limit violations.

- **Missing context** — Artifact publication and reads require a Flow project root and exact run
  attribution. Missing or pruned blobs produce unresolved inspection and fixed read failures.

- **Concurrent operations** — One cross-process lease serializes blob publication, reference state,
  bounded reads, and pruning. An exact prune plan becomes stale after any catalog mutation.

- **Resource exhaustion** — Exact captures, previews, blobs, catalog records, and catalog bytes have
  fixed limits. Replay nodes, read windows, references, and prune plan entries also have fixed limits.
  Maximum workflow concurrency contributes at most 64 MiB of raw command capture. Normal buffer and
  publication overhead is additional.

- **Corruption** — Changed descriptors, producer metadata, sequence, blob bytes, or size fail closed.
  Non-regular files, extra links, path substitution, and unsafe directories also fail closed.

- **Cleanup uncertainty** — Lease-release or post-commit cleanup failure cannot be reported as a
  successful artifact operation.

### Interface contracts

- An artifact descriptor has version `1`, `sha256:<hex>` digest, exact non-negative byte count, and a
  canonical media type.

- A producer has kind `agent-command`, run ID, workflow ID, node ID, positive attempt, command ID,
  positive command sequence, and stream `stdout` or `stderr`.

- A public Flow reference has version `1`, an opaque `artifact:<sha256>` identifier, the descriptor,
  producer, retention class `run`, and canonical reference digest.

- `flow_artifact` accepts one reference, non-negative offset, and positive bounded byte limit. It
  returns base64 bytes plus descriptor and window metadata. It never returns a local path.

- `flow artifacts list`, `inspect`, `retain`, `release`, and `prune` are noninteractive operator
  commands. List returns catalog metadata without reading blobs. Prune is dry-run by default and
  requires `--apply --expected-plan-digest <sha256>` to mutate.

- Inspection reports immutable reference metadata, retention `retained` or `released`, and
  availability `available`, `missing`, `changed`, or `pruned` without reading contents into output.

- Command output within the preview bound remains unchanged. Oversized bounded output adds one
  reference line and keeps only the existing bounded preview in model context.

## Criterion verification map

All criteria inherit the non-goals above.

| Criterion | Type | Verification command | Expected evidence |
| --- | --- | --- | --- |
| Exact artifact identity and provenance | Contract and data | `npx vitest run test/unit/artifact/artifact-reference.test.ts test/unit/infrastructure/fs/local-artifact-store.test.ts` | Exact descriptors, independent producers, deduplication, strict schemas, and substitution negatives pass. |
| Bounded preview and opaque reference | Behavior and privacy | `npx vitest run test/unit/infrastructure/process/command-node-executor.test.ts test/unit/infrastructure/pi/agent-command-recorder.test.ts test/unit/infrastructure/pi/workspace-read-tools.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts` | Oversized stdout and stderr retain exact bytes and command provenance while model-facing results contain only previews, safe metadata, and opaque references. |
| Policy-controlled bounded reads | Security and behavior | `npx vitest run test/unit/infrastructure/fs/local-artifact-store.test.ts test/unit/infrastructure/pi/workspace-artifact-tools.test.ts test/unit/policy/broker.test.ts test/unit/policy/policy-package-admission.test.ts test/unit/workflow/compiler.test.ts` | Selected-tool, exact-run, offset, byte-bound, policy-package admission, policy denial, missing, changed, and cross-run cases pass. |
| Deterministic inspection and lifecycle | Behavior and error | `npx vitest run test/unit/infrastructure/fs/local-artifact-store.test.ts test/integration/cli/artifacts.test.ts` | List, inspect, retain, release, dry-run plan, exact apply, shared blobs, stale plans, and unresolved evidence pass. |
| Crash, cancellation, and filesystem safety | Error and concurrency | `npx vitest run test/unit/infrastructure/fs/local-artifact-store.test.ts` | Commit boundaries, torn tails, lease settlement, cancellation, symlink, hard-link, non-regular, path-race, bound, and reader/pruner cases pass. |
| Run replay and public privacy | Integration and privacy | `npx vitest run test/unit/application/run-workflow-agent-command.test.ts test/unit/application/run-workflow-child.test.ts test/unit/application/evaluation-adapter.test.ts test/unit/cli/public-output.test.ts test/integration/cli/artifacts.test.ts test/integration/supervisor/worker.test.ts` | Durable command references replay exactly; foreground, resumed, child, evaluation, and detached composition preserve the project store; public run and event projections contain no bytes or local paths. |
| Compatibility and documentation | Contract and documentation | `npm run typecheck && npm run build && npm run docs:style && npm run docs:links && npm run docs:ste` | Existing schemas remain compatible, artifact-budget wording stays accurate, and architecture, task, testing, and roadmap documents agree. |

## Implementation plan

1. Add strict domain descriptors, producer references, public inspection types, and digest functions
   with RED boundary and mutation tests.

2. Add the secure local CAS and catalog with RED publication, replay, concurrency, opened-inode,
   cancellation, retention, pruning, and uncertainty tests.

3. Capture bounded exact command streams and bind artifact references into durable command
   settlement with RED preview and replay tests.

4. Add the explicitly selected policy-controlled artifact read tool with RED run-substitution,
   policy, byte-window, corruption, and privacy tests.

5. Add operator inspect, retain, release, and exact-plan prune commands with RED CLI tests.

6. Update public architecture, tasks, testing guidance, roadmap status, and root README links. Run
   mapped and complete gates. Merge only after the adversarial review has no findings.

## Final evidence

Status: complete on 2026-08-22.

The final criterion map passed 304 tests across 16 files. The portable portion passed 302 tests
across 15 files:

```sh
npx vitest run \
  test/unit/artifact/artifact-reference.test.ts \
  test/unit/infrastructure/fs/local-artifact-store.test.ts \
  test/unit/infrastructure/process/command-node-executor.test.ts \
  test/unit/infrastructure/pi/agent-command-recorder.test.ts \
  test/unit/infrastructure/pi/workspace-read-tools.test.ts \
  test/unit/infrastructure/pi/workspace-artifact-tools.test.ts \
  test/unit/infrastructure/pi/pi-agent-executor.test.ts \
  test/unit/policy/broker.test.ts \
  test/unit/policy/policy-package-admission.test.ts \
  test/unit/workflow/compiler.test.ts \
  test/unit/application/run-workflow-agent-command.test.ts \
  test/unit/application/run-workflow-child.test.ts \
  test/unit/application/evaluation-adapter.test.ts \
  test/unit/cli/public-output.test.ts \
  test/integration/cli/artifacts.test.ts
```

The socket-backed worker composition passed two selected tests, with 26 unrelated tests skipped:

```sh
npx vitest run test/integration/supervisor/worker.test.ts \
  -t 'artifact store|preview-only'
```

### Repository-wide evidence

- Two deterministic serial full-suite shards passed 4,938 tests and skipped 4 tests across all 362
  test files. The commands used `--shard=1/2` and `--shard=2/2` with one worker. Sharding bounded host
  memory after the equivalent monolithic process was killed by the operating system.
- The same two shards ran with V8 coverage and separate JSON reports. Merging raw Istanbul counters
  produced 85.00% statements, 79.51% branches, 91.58% functions, and 85.24% lines. The aggregate
  exceeded the configured coverage thresholds.

### Runtime and packaging evidence

- `npm run test:runtime`: 44 tests passed and 37 environment-dependent tests skipped.
- `npm run pack:check`: clean installation and CLI execution passed for the packed tarball with
  installed policy digest `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

### Static and documentation evidence

- `npm run typecheck`, `npm run build`, and `npm run format:check` passed.
- `npm run lint` passed with one pre-existing informational notice in
  `src/application/external-harness-adapter.ts`.
- `npm run docs:style`, `npm run docs:links`, and `npm run docs:ste` passed.
- `git diff --check HEAD` passed.

The final adversarial review found no unresolved P1, P2, or P3 issue. The review covered policy
authority, cross-run access, public-output privacy, and cancellation. It also covered commit
settlement, strict catalog replay, filesystem substitution, and pruning idempotence. The final scope
included catalog capacity, producer provenance, and exact boundary behavior.
