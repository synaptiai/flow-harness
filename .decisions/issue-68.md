# Decision Journal: Issue #68 — Prompt-candidate activation and rollback

**Issue**: #68 | **Branch**: `codex/issue-68-prompt-activation` | **Started**: 2026-08-09

---

## Context

Issue #66 added prompt candidates that bind changes to tuning evidence. Flow can evaluate each
candidate against an exact baseline. Flow cannot activate a candidate after a superior result.

This issue adds the operator boundary between evaluation and use. The boundary must keep the
baseline unchanged. It must also keep each active run on its admitted source.

## External evidence


- [Pi autoresearch](https://github.com/davebcn87/pi-autoresearch) records experiments and explicit
  keep or revert decisions. Flow keeps the explicit decision boundary and durable history.

- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) separates a base prompt from
  adaptive prompt state. Flow keeps this separation and adds an evaluation gate.

- [Continual Harness](https://arxiv.org/abs/2605.09998) reports that adaptive harness state can
  improve results. It also shows that model capability affects the result. Flow therefore requires
  operator approval after a declared evaluation.

- [OCI descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) bind
  content to a digest and byte count. Flow uses the same content-addressed principle for activation
  artifacts.

- [Kubernetes rollout undo](https://kubernetes.io/docs/tasks/run-application/update-deployment-rolling/)
  changes the selected revision for later work. It does not rewrite an earlier revision. Flow uses
  the same rule for rollback.

## Architecture choice

### A. Change the baseline workflow — rejected

Flow could replace the baseline file with the projected candidate source.


- This choice gives simple run commands.

- It destroys the immutable baseline contract.

- A crash can leave an unclear partial change.

- Recovery can read a different source than the source used at run start.

### B. Read a mutable candidate pointer during each run and resume — rejected

Flow could store one active candidate path for each workflow.


- This choice gives small metadata.

- A later activation or rollback can change recovery input.

- A deleted or changed source can stop recovery.

- A path can cross the trust boundary after an earlier review.

### C. Store the activated source as a root workflow package — rejected

Flow could convert the projected source to a normal workflow package.


- This choice reuses package locators and package storage.

- The compiler includes the root package identity in the compiled workflow digest.

- The resulting digest differs from the candidate digest that the evaluation used.

- The package would not prove execution of the evaluated projection.

### D. Add an immutable activation snapshot and an atomic active index — selected

Flow stores two content-addressed artifacts for each approval. One artifact contains the evaluated
candidate source. The other artifact contains its exact baseline source. An atomic index selects
one artifact for each workflow.

New runs read the current index. The run then stores the exact activation snapshot in its capability
snapshot. Resume and detached execution use this durable snapshot. They do not read the current
index.

This choice preserves the evaluated workflow digest. It also uses the existing capability snapshot
path through run history, child runs, detached jobs, and recovery.

## Falsification checks

### Recovery state model

Let the live pointer have three values: baseline, candidate 1, and candidate 2. Let the admitted run
use any one of these values.

There are nine admitted and current-state pairs. A recovery design that reads the live pointer fails
in six pairs. A design that reads the durable snapshot fails in zero pairs.

### Coupling check

Graphify reports that `RunEvent` has 147 graph connections. It reports 118 connections for the
workflow compiler. A new run-event field would affect a large replay surface.

`CapabilitySnapshot` already reaches `RunStartedEvent` in one graph edge. The CLI also copies it to
detached job records. The selected design extends this existing path.

### Digest check

The workflow digest includes the compiled source-package identity. A root package changes this
identity. An activation snapshot does not change the compiled workflow.

The run compiler decodes the saved projected source as an inline workflow. The compiled digest must
equal the digest in both the candidate identity and activation identity.

## Operator flows

### Activate a candidate


1. Complete an evaluation with a candidate profile.

2. Inspect the evaluation report and candidate identity.

3. Request an activation preview with an actor label and optional reason.

4. Review the candidate, evaluation proof, current selection, and proposal digest.

5. Apply the exact proposal digest.

6. Inspect the active selection and transition history.

### Run an active workflow


1. Select `activation:<workflow-id>` as the workflow locator.

2. Flow reads and validates the current activation index.

3. Flow reads the selected immutable artifact.

4. Flow compiles the saved source as an inline workflow.

5. Flow verifies the evaluated workflow digest.

6. Flow stores the exact activation snapshot with the run.

### Roll back an activation


1. Inspect the current selection and available versions.

2. Preview a change to an earlier candidate artifact or the current lineage baseline artifact.

3. Review the current selection, target selection, and proposal digest.

4. Apply the exact proposal digest.

5. Start new runs with the new selection.

The rollback does not change an active run. It does not delete an activation artifact.

## Domain contracts

### Activation identity

The activation identity has version 1. It contains these fields:


- the workflow scope.

- the complete prompt-candidate identity.

- the evaluation id and plan digest.

- the final trial-record digest.

- a digest of the complete evaluation report.

- the baseline and candidate profile ids.

- the declared release criteria.

- the comparison result and its `superior` verdict.

- the selection role: candidate or baseline.

- the selected source digest and compiled workflow digest, and

- one activation digest over all prior fields.

The comparison result contains aggregate values only. It contains no task text, fixture path,
verifier assertion, holdout identity, run id, or trial record.

### Activation snapshot

The activation snapshot contains the activation identity and exact selected source. It records the
source byte count, SHA-256 digest, and canonical base64 content. Candidate selection binds the
projected workflow identity. Baseline selection binds the baseline workflow identity.

Validation performs these checks:


- The source byte count and digest match the decoded content.

- The source digest matches the selected candidate or baseline identity.

- The workflow digest matches the candidate and activation identities.

- The candidate identity is canonical and self-consistent.

- The evaluation is complete.

- The comparison verdict is `superior`.

- Each declared comparison constraint has the value `true`.

- The activation digest is correct.

The admission path compiles the decoded source. It requires the exact evaluated workflow digest.

### Activation proposal

An activation proposal contains these fields:


- action: activate or rollback.

- workflow scope.

- current generation and current activation digest.

- target role and activation digest.

- the baseline artifact digest for an activation proposal.

- actor label and optional reason, and

- proposal digest.

The proposal does not contain a timestamp. This rule makes a preview stable before apply.

Apply rebuilds and validates the proposal while it holds the mutation lock. Apply requires the exact
proposal digest. A changed current selection produces a stale-proposal error.

### Activation transition

Each successful change appends one transition to the index history. A transition records the actor,
reason, time, generation, old selection, new selection, prior transition digest, and transition
digest.

An exact retry after an unclear commit returns `already_active` when the current target matches. A
conflicting retry fails.

## Store contract

Flow stores activation state below the project `.flow` directory.

The store has these parts:


- immutable activation blobs addressed by activation digest.

- one strict activation index.

- one cross-process mutation lock, and

- temporary files that use exclusive creation.

The index contains sorted activation entries and sorted workflow heads. It also contains an ordered
hash-chained transition history. Each head identifies one exact activation digest.

The store uses this commit order:


1. Validate the candidate, baseline, and complete evaluation.

2. Build and validate the complete next index.

3. Check the physical artifact count and byte total.

4. Publish and sync the candidate and baseline blobs.

5. Write and sync a temporary index.

6. Replace the index with one rename.

7. Sync the index directory.

8. Release and sync the mutation lock.

A known failure before index replacement removes new unindexed blobs. A failure after index rename
and before directory sync returns `commit_uncertain`. Flow keeps the blobs after an uncertain
commit.

The mutation lock stores a version, host, process, and random token. Flow retires the lock only when
the same host reports that the process does not exist. A live, foreign, changed, or invalid owner
fails closed.

Flow removes old index and blob temporary files only while it holds the mutation lock. It checks
each strict name, file type, size, and stable identity before removal. A new lock temporary name
contains the host and process identity.

Flow can remove an empty or partial lock temporary file only
when its name identifies this host and a process that does not exist. It can also remove a complete
legacy lock temporary file when its valid content identifies this host and a process that does not
exist. Linked, changed, contradictory, foreign, live, malformed, or excessive temporary state fails
closed.

Flow treats a temporary file that disappears before observation as concurrent cleanup. Flow does
not treat this result as an unsafe replacement.

New child workspaces use a private project-sibling collection named `.<project-name>.flow-workspaces`.
A hash of the canonical physical run-store path separates workspace groups.
Filesystem aliases for one run store select one workspace group.
The project workspace, project `.flow` directory, and run store do not contain this collection.
Attached runs use the canonical configured project root.
Detached jobs save the same optional root in their immutable identity.

For an old job without these fields, Flow can infer the root from the durable `.flow/runs` ancestor.
It accepts the root only when the job directory is in that project.
Flow rejects linked collection and owner directories.

The broker denies reads and writes for each historical `.flow-workspaces` or named
`.<name>.flow-workspaces` path segment.
Before command spawn, SRT scans at most 200,000 execution-root entries.
It adds each existing private collection as a literal protected path.
It rejects linked or indirect collections.

For a child, SRT denies reads from every ancestor collection but permits writes in the selected
workspace. Thus, a child cannot read a sibling workspace at any nesting level.
The snapshot copier omits these collections.
On Linux, Flow rejects a command root that strictly contains the configured project root.
Linux SRT cannot protect a matching path that does not exist when the sandbox starts.

Recovery can find a workspace in the old run-store location. Flow validates the old manifest with
the old exclusion identity. For a nested child, it translates the moved parent path to the old
parent path.

Flow moves and syncs the complete identity directory to the private
collection when both locations use one filesystem. Across filesystems, Flow makes a bounded staging
copy. It verifies stable source and target hashes, syncs the copy, publishes it with one rename, and
removes the old identity last.

Flow reopens the moved workspace. Its first recovery event records the old and new paths in
`run_resumed.workspaceRelocation`. A parent records this event before it starts recovery in that
child. The broker and SRT
derive the local `.flow` protection from the child workspace.

Version 1 does not delete blobs. This rule keeps saved run sources available.

## Bounds


- A projected prompt-candidate workflow is at most 8 MiB.

- Activation source content uses the same 8 MiB limit.

- The complete capability snapshot is at most 16 MiB.

- Non-activation capability packages keep their existing 512 KiB aggregate limit.

- A run event is at most 20 MiB.

- An activation index is at most 4 MiB.

- An activation store contains at most 128 immutable artifacts.

- The index contains at most 128 workflow heads.

- The index contains at most 2,048 transitions.

- Stored activation blobs use at most 256 MiB in total.

- Each index or lock recovery scan permits at most 128 temporary files and 8 MiB of temporary data.

- Blob recovery permits at most 128 temporary files and 256 MiB of temporary data. Each file is at
  most 16 MiB.

- An actor label is at most 128 characters.

- A reason is at most 1,024 characters.

- CLI and schema error messages are at most 16 KiB.

All byte limits use UTF-8 bytes or decoded binary bytes. Tests accept an exact 8 MiB source and
reject an 8 MiB plus one byte source.

The complete valid activation fits in the 16 MiB capability snapshot and 20 MiB run-event
envelopes. Smaller component limits make the complete envelope values unreachable for one valid
activation. Tests prove the exact 8 MiB source boundary.

Tests also cover exact actor, reason,
artifact, head, transition, temporary-file, and physical-store limits. Negative tests cover 129
temporary files, aggregate index and blob temporary bytes, and a blob temporary file that is one
byte above its limit.

Crash tests cover empty and partial lock files, pre-link blob files, post-link
blob files, and a maximum-source blob file.

## CLI contract

```text
flow candidate activate <candidate.yaml> --evaluation <id> --actor <label> --dry-run
flow candidate activate <candidate.yaml> --evaluation <id> --actor <label> --expected-digest <sha256>
flow activation list
flow activation inspect <workflow-id>
flow activation rollback <workflow-id> --to <candidate-id>@<version>|baseline --actor <label> --dry-run
flow activation rollback <workflow-id> --to <candidate-id>@<version>|baseline --actor <label> --expected-digest <sha256>
flow run activation:<workflow-id>
flow resume activation:<workflow-id> --run-id <id>
```

Evaluation commands use the configured evaluation directory. Activation state requires a Flow
project root. Read-only list and inspect commands need no model credentials.

The resume command treats the locator as a scope assertion. It reconstructs the source from durable
run history. It does not use the current project index.

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Evaluation is missing, incomplete, corrupt, or not superior | Reject activation and change no state |
| Candidate identity differs from the evaluation candidate | Reject activation and change no state |
| Baseline or projected workflow identity differs | Reject activation and change no state |
| Candidate source changes between preview and apply | Reject the stale proposal |
| Candidate id and version already name different content | Reject the identity conflict |
| Exact activation repeats | Return the existing artifact or active state |
| Another operator changes the head | Reject the stale proposal |
| Blob publication fails | Keep the old index |
| Index rename succeeds but directory sync fails | Return `commit_uncertain` and require inspection |
| Index, blob, history, or head is malformed | Reject the store as unsafe |
| Selected blob is missing or changed | Reject new run admission |
| Live index changes after run start | Continue with the durable run snapshot |
| Live index or source disappears before resume | Resume from the durable run snapshot |
| Durable activation snapshot changes | Reject replay or recovery |
| Rollback selects an unknown version | Reject the request and keep the current head |
| Transition limit or byte limit is reached | Reject the change and keep the current head |

## Security and privacy boundaries


- Only an operator command can change activation state.

- A workflow or model tool cannot call the activation store through a declared capability.

- Activation does not change workflow tools, policy, graph, model routing, budgets, or verifiers.

- The durable snapshot includes prompt text. Operators must treat run ledgers as sensitive data.

- Activation artifacts contain aggregate evaluation proof. They do not contain evaluation task data.

- SHA-256 values provide content identity. They are not signatures.

- A trusted same-user project owner can replace and re-digest project state. This threat remains out
  of scope.

## Non-goals


- Automatic candidate generation.

- Model-authorized activation or rollback.

- Changes to active runs.

- Skill, memory, subagent, routing, tool, policy, verifier, budget, or graph adaptation.

- Remote activation registries.

- Multi-user signatures or approval quorum.

- Blob deletion or history compaction.

- Traffic splitting or staged rollout.

- A claim that one declared evaluation proves general superiority.

- Native Pi, OMP, or Prime adapters.

## Acceptance-criterion verification map

| Criterion | Verification | Expected evidence |
| --- | --- | --- |
| Exact preview and apply | Focused activation-domain and CLI tests | Apply accepts only the reviewed proposal digest |
| Complete superior evaluation | Activation-admission tests | Incomplete and non-superior reports fail without writes |
| Baseline and active-run stability | Run and activation integration tests | Baseline bytes and active run digest do not change |
| Deterministic active locator | CLI and locator tests | New runs select the exact current artifact |
| Complete activation identity | Domain schema tests | All identity fields bind to one digest |
| Idempotency and version conflict | Store tests | Exact repeats pass and conflicts fail |
| Concurrent or stale change | Store race tests | One writer commits and stale writers fail |
| Rollback to version or baseline | CLI and store tests | Future heads change without blob deletion |
| Active-run isolation | Run replay tests | A later pointer change does not change the run |
| Detached and resume recovery | Supervisor and CLI tests | Recovery uses only the saved snapshot |
| Bounded invalid-input errors | Schema, store, and CLI tests | Invalid data fails with bounded diagnostics |
| Model-context isolation | Agent-executor tests | No evaluation or operator data enters model input |
| Full failure matrix | Unit, integration, runtime, and mutation tests | All stated failures have negative tests |
| Public documentation | Community-file and prose checks | All changed documents match the contract and STE rules |

## TDD sequence


1. Add failing tests for activation identity, proof, source, and digest checks.

2. Add the minimum domain code that passes those tests.

3. Add failing store tests for publish, index, history, races, crashes, and limits.

4. Add the minimum local store code that passes those tests.

5. Add failing tests for activation capability snapshots and workflow binding.

6. Add the minimum capability and recovery code that passes those tests.

7. Add failing CLI tests for preview, apply, list, inspect, rollback, run, and resume.

8. Add the minimum CLI code that passes those tests.

9. Add detached supervisor and model-context isolation tests.

10. Update public documents in Simplified Technical English.

11. Run focused tests after each green step.

12. Run format, lint, type, full test, coverage, build, runtime, package, audit, and action checks.

13. Run independent specification, security, test, and holdout reviews.

14. Fix each P1, P2, and P3 finding. Repeat review until no finding remains.

## Documentation rule

All new or changed repository documentation uses ASD-STE100 Simplified Technical English. Sentences
use active voice where possible. Procedure sentences use no more than 20 words. Narrative sentences
use no more than 25 words.
