# Maintain a durable goal workspace

Use a goal workspace when an attached, detached, resumed, or child run needs the same bounded
long-horizon context. Flow stores complete immutable revisions in a project ledger. You select the
current revision explicitly for a new run.

A goal workspace provides context only. It doesn't grant a tool, change policy or budgets, advance
the workflow, or determine whether a goal or criterion passes. The deterministic workflow engine
retains that authority.

## Before you begin

You need:

- A Flow project with `.flow/config.yaml`.
- A built or installed `flow` command.
- A UTF-8 YAML or JSON workspace document that satisfies the [workspace schema](#workspace-schema).
- Existing durable run events for every evidence locator in `verifiedFacts`.

Don't put credentials, tokens, private evidence, or other secrets in workspace text. Selected
agents receive the objective and text entries. The `goal show` and `goal history` commands also
return those fields.

## Create a workspace document

Create `goal-workspace.yaml` with the complete initial state:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: GoalWorkspace
objective: Deliver the reviewed release candidate.
facts:
  - id: current-state
    text: The package build is reproducible.
invariants:
  - id: policy-authority
    text: Flow policy and deterministic criteria remain authoritative.
verifiedFacts:
  - id: package-tests
    text: The package verification node completed with durable evidence.
    evidence:
      - runId: release-candidate-42
        nodeId: verify-package
        attempt: 1
openQuestions:
  - id: hosted-proof
    text: Has the Linux x64 runtime proof completed?
nextAction:
  id: inspect-ci
  text: Inspect the hosted runtime proof.
```

Each entry ID must be unique across the document. Use IDs that remain meaningful when the text
changes in a later revision.

An evidence locator identifies one terminal `node_succeeded` or `node_failed` event with non-null
evidence. Flow resolves the locator to the event sequence and a digest of the complete parsed event
before it commits the revision. Flow doesn't copy the event payload into the goal ledger.

Flow verifies that the event exists. It doesn't infer that the event proves the natural-language
statement. Review the referenced event and keep workflow acceptance in deterministic criteria.

## Initialize the ledger

Initialize the project workspace from the document:

```sh
flow goal init goal-workspace.yaml
```

Flow returns revision `1` as JSON. Save its `revision` and `digest` values. An existing workspace
causes `goal workspace already exists`. Initialization doesn't replace it.

## Inspect current and historical revisions

Read the current revision:

```sh
flow goal show
```

Read up to 50 revisions after revision `0`:

```sh
flow goal history --after 0 --limit 50
```

`--after` defaults to `0`, and `--limit` defaults to `50`. The maximum page size is `100`.
History is ordered by revision.

Public workspace output includes the revision identity, text entries, and resolved evidence
references. It doesn't load or return the referenced run evidence.

## Update the workspace safely

Write the complete next state to a new document. Submit the revision and digest that you read:

```sh
flow goal update goal-workspace-next.yaml \
  --expected-revision 1 \
  --expected-digest <64-lowercase-hex-digest>
```

Flow resolves every evidence locator before it obtains the writer lease. Under that lease, Flow
replays the ledger and compares both expected values with the current revision. If another writer
committed first, Flow returns `goal workspace revision changed` and doesn't append your document.

Read the current revision, merge the intended changes into a complete new document, and retry with
the new identity. Don't reuse an old digest or edit `.flow/goal-workspace/events.jsonl`.

## Select the workspace for a run

Validate a workflow with the current revision:

```sh
flow validate workflow.yaml --goal-workspace
```

The validation summary reports `goal workspaces: 1` when selection succeeds.

Start an attached run with the same revision:

```sh
flow run workflow.yaml --goal-workspace --run-id implementation-42
```

Start a detached run when the submitting process must not own execution:

```sh
flow run workflow.yaml --goal-workspace --detach \
  --run-id implementation-42 \
  --command-id <uuid>
```

Flow freezes the complete selected revision into the run's capability snapshot. Agent nodes receive
a rendered block containing the revision identity, objective, facts, invariants, verified-fact
text, open questions, and next action. The block excludes evidence locators and event digests.

Child runs inherit the same frozen revision. Per-agent supplemental memory remains separately
targeted and appears after the goal context.

## Resume without live workspace state

Resume with the original workflow and run ID:

```sh
flow resume workflow.yaml --run-id implementation-42
```

`resume` doesn't accept `--goal-workspace`. It reconstructs the exact revision from `run_started`.
It doesn't read the current goal ledger or the original workspace document. Deleting or updating
the live workspace doesn't change an existing run.

Recovery doesn't continue work automatically. An operator or existing detached owner must start or
resume the run through the normal control boundary.

## Workspace schema

The source document contains these fields:

| Field | Requirement |
| --- | --- |
| `apiVersion` | Exact value `flow.synapti.ai/v1alpha1`. |
| `kind` | Exact value `GoalWorkspace`. |
| `objective` | One nonempty UTF-8 string. |
| `facts` | Bounded operator-reviewed context entries. |
| `invariants` | Bounded constraints that the agent must preserve. |
| `verifiedFacts` | Bounded statements with one or more durable event locators. |
| `openQuestions` | Bounded unresolved questions. |
| `nextAction` | Exactly one entry that describes the next intended action. |

Every entry has `id` and `text`. IDs use lowercase letters, digits, and internal hyphens, and start
with a letter. The parser rejects aliases, duplicate keys, unknown fields, duplicate IDs, duplicate
locators within one verified fact, invalid UTF-8, and every exceeded limit. Multiple facts can cite
the same immutable event.

## Limits

Flow applies these limits before it commits a revision:

| Surface | Limit |
| --- | ---: |
| Source document | 262,144 UTF-8 bytes |
| Canonical source or revision | 131,072 UTF-8 bytes |
| Objective | 16,384 UTF-8 bytes |
| One entry text | 4,096 UTF-8 bytes |
| Entries in each list | 32 |
| Evidence references for one verified fact | 8 |
| Revisions in one ledger | 256 |
| Complete ledger | 33,554,432 bytes |
| Revisions in one history page | 100 |

The ledger path is `.flow/goal-workspace/events.jsonl`. Flow creates private state directories and
uses one local writer lease for replay, compare-and-set validation, and append.

## Handle failures

Use this table to choose the next action:

| Message | Meaning and action |
| --- | --- |
| `goal workspace does not exist` | Initialize the project workspace, or remove `--goal-workspace` when the run doesn't need it. |
| `goal workspace revision changed` | Read the current revision, merge the document, and retry with its exact revision and digest. |
| `goal workspace clock moved backward` | Correct the host clock. Retry with the same current revision identity only after time is at or later than the current revision timestamp. |
| `goal workspace evidence is unavailable` | Inspect the referenced run, node, and attempt. Use one terminal event with durable evidence. |
| `goal workspace writer is busy` | Wait for the active local writer to settle, and then retry. Don't remove its lease while a writer is active. |
| `goal workspace ledger is corrupt` | Stop updates. Preserve the project state and inspect the committed ledger. Don't delete a committed line or invent a replacement. |
| `goal workspace commit is uncertain` | Run `flow goal show`. Retry only after you determine whether the exact prepared revision is current. |
| `goal workspace writer settlement is uncertain` | Treat the revision and writer lease as unresolved. Inspect the current revision and local writer state before another update. |
| `goal workspace storage is unsafe` | Stop and inspect file type, ownership, permissions, links, and local writer state. Don't follow or replace an unsafe path automatically. |

Flow ignores only an unterminated final ledger fragment during reads. The next writer truncates that
fragment under the writer lease before it appends a new revision. Invalid committed records fail
the complete replay.

For interruption and remediation rules, read
[Recovery and interruption safety](../recovery.md#recover-a-goal-workspace).

## Security boundary

### Protect private data

- Workspace text is model context and public review data. It isn't a secret store.
- Evidence references are auditable pointers. They don't grant access to raw evidence.
- Agent context escapes workspace text and omits evidence locators. Public run output uses an
  allowlist projection for workspace fields.

### Preserve Flow authority

- A model can't initialize, update, or select a revision through agent tools.
- The workspace can't add tools, packages, policy, approval, budgets, network access, filesystem
  access, transitions, or completion authority.
- A changed live workspace affects only a new explicit selection. Existing attached, detached,
  resumed, and child runs use their frozen snapshot.

Read [Architecture](../architecture.md) for ownership and data flow. Read the
[Workflow specification](../workflow-spec.md) for deterministic goal and criterion evaluation.
