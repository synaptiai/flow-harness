# Manage supplemental-memory relationships

Use supplemental-memory relationships when you need to record why two reviewed memory entries are
connected for one exact agent. Flow stores the entries and their relationships in one immutable
effective harness state. A candidate can change one entry and only the relationships incident to
that entry as one atomic proposal.

This guide is for operators who author, review, evaluate, activate, and roll back relationship-aware
memory candidates. Complete the [supplemental-memory candidate workflow](../evaluation.md#supplemental-memory-candidates)
before you use this extension.

Supplemental memory is model-visible context. It is not a secret store, a truth database, or
workflow evidence. Flow validates that cited run events exist and match the target agent. You must
still decide whether those events justify the relationship claim.

## Before you begin

You need:

- An active effective harness with at least one reviewed supplemental-memory entry.
- A built or installed `flow` command and a configured project run store.
- One terminal `node_succeeded` or `node_failed` event with non-null evidence for each evidence
  locator.
- The current state, workflow, package-closure, entry, and prior-relationship digests that your
  candidate changes.
- A paired evaluation plan that selects the composed effective harness artifact.

Preserve the public JSON returned by `flow candidate validate`. It contains the ID and digest of
each added relationship. A later candidate must supply that exact digest to remove or rebind the
relationship. If you lose the prior identity, don't guess a digest or read private store files.
Use a retained reviewed identity or roll back to a retained complete state.

## Understand the relationship model

A relationship connects two exact entry versions in the same root workflow, child path, and agent.
An endpoint contains an entry ID and the SHA-256 digest of that entry's current bytes. A candidate
relationship is *incident* to the candidate entry when that entry is either endpoint.

Use only these predicates:

| Predicate | Meaning |
| --- | --- |
| `supports` | The source entry provides reviewed support for the destination entry. |
| `contradicts` | The source and destination express an unresolved conflict. Neither entry wins automatically. |
| `refines` | The source entry is a reviewed, more specific statement derived from the destination context. |
| `supersedes` | A replacement version points to the exact prior version of the same entry. |
| `derived_from` | The source entry was produced from the destination entry's reviewed context. |

These predicates record operator-reviewed claims. Flow doesn't infer transitive links, symmetric
links, confidence, truth, temporal validity, or a preferred side of a contradiction. `refines` and
`derived_from` relationships must remain acyclic. `supersedes` is narrower: its source must be the
candidate's replacement version, and its destination must be the exact prior version of the same
entry.

## Inspect the active state and evidence

Inspect the active state before you author a candidate:

```sh
flow activation inspect <workflow-id>
```

Use the returned state, workflow, and package-closure identities in the candidate. The active
relationship summary contains counts and set-level integrity digests. It doesn't expose memory
bytes, relationship evidence locators, or the private relationship catalog.

Inspect the run that supplies evidence:

```sh
flow inspect <run-id>
flow events <run-id> --after 0
```

Select one terminal event whose `nodeId` and `attempt` match the locator. The event must contain
evidence. For a root target, the event must belong to the root workflow. For an embedded-child
target, it must belong to the embedded workflow selected by `childPath`. The locator's `nodeId`
must equal the target `agentNodeId`.

Flow resolves the three-field locator to the event's durable sequence and a digest of the complete
parsed event. It doesn't copy the event payload into the relationship state.

## Add an entry and a relationship

Create one `SupplementalMemoryCandidate` that adds the entry and its incident relationship. Both
`remove` and `add` arrays are required when the `relationships` object is present:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: SupplementalMemoryCandidate
metadata: { id: reviewed-layout-support, version: 1.0.0 }
scope:
  kind: workflow-agent-memory
  workflowId: adaptive-workflow
  childPath: []
  agentNodeId: implement
  entryId: project-layout
baseline:
  stateDigest: <current-state-sha256>
  workflowDigest: <current-workflow-sha256>
  packageClosureDigest: <current-package-closure-sha256>
change:
  kind: add
  value: Use the reviewed package map when locating implementation owners.
relationships:
  remove: []
  add:
    - id: layout-supports-package-map
      predicate: supports
      from:
        entryId: project-layout
        entrySha256: <sha256-of-new-entry-value>
      to:
        entryId: accepted-package-map
        entrySha256: <current-destination-entry-sha256>
      evidence:
        - runId: package-review-42
          nodeId: implement
          attempt: 1
```

Calculate `entrySha256` over the exact UTF-8 bytes in `change.value`. Flow rejects a stale endpoint,
a cross-target endpoint, or an endpoint that doesn't resolve to the projected complete state.

## Replace an entry and rebind its relationships

When you replace an entry, explicitly remove every relationship incident to its prior version.
Add each replacement relationship against the new entry digest in the same candidate:

```yaml
change:
  kind: replace
  beforeSha256: <prior-entry-sha256>
  value: Use the reviewed package and ownership maps when locating implementation owners.
relationships:
  remove:
    - id: layout-supports-package-map
      beforeDigest: <prior-relationship-sha256>
  add:
    - id: layout-supports-package-map
      predicate: supports
      from:
        entryId: project-layout
        entrySha256: <sha256-of-replacement-value>
      to:
        entryId: accepted-package-map
        entrySha256: <current-destination-entry-sha256>
      evidence:
        - runId: package-review-43
          nodeId: implement
          attempt: 1
    - id: project-layout-revision
      predicate: supersedes
      from:
        entryId: project-layout
        entrySha256: <sha256-of-replacement-value>
      to:
        entryId: project-layout
        entrySha256: <prior-entry-sha256>
      evidence:
        - runId: package-review-43
          nodeId: implement
          attempt: 1
```

Flow applies the entry replacement, removals, and additions as one projection. It rejects the
candidate if an old incident relationship remains. It also rejects a relationship that is unrelated
to the candidate entry. A `supersedes` edge must point to the exact prior entry version.

When you remove an entry, list every incident relationship under `remove`. A removal candidate
cannot add relationships because the candidate entry has no active after-version.

## Validate and preserve the review identity

Validate the candidate and save its content-free public identity:

```sh
flow candidate validate memory-relationship.candidate.yaml \
  > memory-relationship.review.json
```

Validation is read-only. It reopens the current state and every cited run, resolves exact evidence,
and projects the complete state. It rejects invalid graph or authority changes before it returns.
Review these fields in the saved JSON:

- `scope`, `baseline`, `change`, and `projectedStateDigest`.
- `relationships.baselineAssessmentDigest` and `projectedAssessmentDigest`.
- Every content-free `relationships.removed` and `relationships.added` ID and digest.
- `candidateDigest` and the candidate source digest.

The output doesn't include memory bytes, evidence locators, absolute paths, or nested private
causes. Keep the review JSON with your change record so a later edit can cite prior relationship
digests without opening private state.

Compose the validated change against the exact current head:

```sh
flow candidate compose memory-relationship.candidate.yaml
```

Composition stages one immutable effective harness artifact. The candidate remains inert. It
cannot affect a run until a complete paired evaluation returns `superior` and an operator applies
the exact activation proposal.

## Evaluate and activate the complete state

Use the ordinary paired evaluation workflow in
[Reproducible harness evaluation](../evaluation.md#activation-gate). Configure both profiles with
the staged `effectiveCandidate`: one profile selects `baseline`, and the other selects `candidate`.
Keep tasks, fixtures, seeds, models, packages, budgets, network policy, retries, ordering, and
verification equal.

After the evaluation returns a complete `superior` verdict, preview activation:

```sh
flow candidate activate memory-relationship.candidate.yaml \
  --evaluation <evaluation-id> \
  --actor <operator-label> \
  --dry-run
```

Apply the exact proposal digest returned by the preview:

```sh
flow candidate activate memory-relationship.candidate.yaml \
  --evaluation <evaluation-id> \
  --actor <operator-label> \
  --expected-digest <proposal-sha256>
```

Activation rechecks the staged artifact, paired evaluation, current head, candidate identity,
complete state identities, relationship set, and assessment. It advances one complete-state head.
It cannot activate the memory entry without its relationship changes.

## Verify targeted execution

Start a new run from the active state:

```sh
flow run activation:<workflow-id> --run-id <run-id>
flow inspect <run-id>
```

Only the exact workflow, child path, and agent receive the relationship block. It contains entry
IDs, entry digests, predicates, and an explicit unresolved marker for `contradicts`. It doesn't
contain evidence locators or memory bytes. Unrelated agents receive no relationship block.

The run freezes the complete runtime in its capability snapshot. Attached and detached execution,
child runs, resume, recovery, and replay use that snapshot without reopening the candidate, active
head, review JSON, or run evidence source.

## Roll back a complete state

Inspect retained state digests before rollback:

```sh
flow activation inspect <workflow-id>
```

Preview a rollback to the selected retained state:

```sh
flow activation rollback <workflow-id> \
  --to state:<state-sha256> \
  --actor <operator-label> \
  --dry-run
```

Apply the exact rollback proposal:

```sh
flow activation rollback <workflow-id> \
  --to state:<state-sha256> \
  --actor <operator-label> \
  --expected-digest <proposal-sha256>
```

Rollback selects the retained entries and relationship sidecar together. It affects future runs
only. A run that already admitted a capability snapshot continues with its frozen state.

## Limits

Flow enforces these independent limits before staging:

| Item | Limit |
| --- | ---: |
| Relationships in one state | 32 |
| Incident relationships for one active entry | 4 |
| Relationship removals plus additions in one candidate | 8 |
| Durable evidence references for one relationship | 1–4 |
| Durable evidence references in one state | 128 |
| Serialized relationship metadata | 131,072 UTF-8 bytes |
| Model-visible relationship block for one target | 8,192 UTF-8 bytes |

The eight-change candidate limit supports replacing an entry with four incident relationships:
four removals and four rebound additions. The model-visible relationship limit is separate from
the supplemental-memory content limits and the complete-state limit.

## Handle failures safely

Use these recovery actions:

| Condition | Action |
| --- | --- |
| Evidence can't be resolved | Inspect the run, workflow, node, and attempt. Cite one terminal evidence-bearing event for the exact target agent. |
| An endpoint is stale or outside the target | Reinspect the active state. Recreate the candidate with current entry digests and the exact target. |
| An incident relationship is undeclared | Add its exact ID and digest to `remove`, then add a rebound relationship when the entry remains active. |
| A relationship digest is unavailable | Use the saved validation identity or roll back to a retained complete state. Don't guess or hand-edit durable state. |
| A contradiction exists | Preserve both entries and the unresolved relationship. Resolve it through a new reviewed candidate only when evidence supports that action. |
| Validation or composition is cancelled | Treat the operation as inert. Reinspect the active head before retrying. |
| Activation reports an uncertain settlement | Inspect the active head and history. Don't apply a second proposal until you determine whether the exact transition committed. |
| A run is interrupted after activation | Resume through the ordinary recovery path. Don't reconstruct relationship context from the candidate or current head. |

Historical states and candidates that omit `relationships` keep their prior version-1 shape,
digests, and model prompt bytes. Flow doesn't migrate or synthesize relationship state for them.

For the normative schema and lifecycle contract, read
[Supplemental-memory candidates](../workflow-spec.md#supplemental-memory-candidates). For ownership,
trust boundaries, and non-goals, read [Architecture](../architecture.md#adaptive-candidate-and-activation-layer).
