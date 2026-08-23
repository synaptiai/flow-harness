# Evaluate and activate phase-aware model routing

Use this guide to assign exact models to planning, execution, verification, or escalation calls.
You can activate the assignment only after a paired held-out evaluation qualifies it.

Phase routing is an operator-authored control. A model cannot create a route, select a fallback, or
change the active profile during a run. Flow supports exact root and embedded-child targets. It
doesn't support a learned production router, silent fallback, provider discovery, or routing through
an Agent Client Protocol (ACP) executor whose provider calls are opaque.

## Understand the evidence boundary

A phase-routing candidate contains two complete profiles:

- The `before` profile reproduces every model-bearing route in the baseline workflow.
- The `after` profile preserves the same ordered targets and phase labels and changes at least one
  provider, model id, or `thinking` value.

Each assignment has one phase:

- `planner` identifies planning work.
- `executor` identifies implementation or action work.
- `verifier` identifies model-backed verification work.
- `escalation` identifies an explicit escalation route.

The phase label is metadata that you assign and review. It doesn't grant workflow authority or
change graph transitions. The target still identifies one exact model-bearing workflow node.

During execution, Flow resolves the exact target before provider I/O. The private model-session
journal records the selected profile digest, phase, target, route, selection result, fallback
result, escalation result, and decision digest with each prepared request. Flow records complete
cost and latency only when every prepared request has the required settlement and usage evidence.

## Check the prerequisites

Before you begin, confirm these conditions:

- The project has an active effective harness head for the target workflow.
- The baseline workflow is a stable local file.
- Every model-bearing root or embedded-child node has an assignment in both profiles.

- The workflow doesn't contain packaged child workflows. This version cannot resolve them during
  local phase-routing candidate admission.
- Expanded generated model nodes aren't present. They don't have stable source addresses.
- The evaluation suite contains filesystem-verified `holdout` tasks only.

- Both profiles use the same workflow budget, denied workload-tool network, and zero provider and
  harness retries.

Use an ordinary embedded Pi workflow. A phase-routing profile cannot select an ACP executor because
Flow cannot observe and bind each provider call inside that process.

## Author a candidate

Create a `PhaseRoutingCandidate` next to its baseline workflow. This example assigns one root agent
to the `executor` phase. Replace the placeholder hashes with the exact lowercase SHA-256 source hash
and compiled workflow digest.

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: PhaseRoutingCandidate
metadata: { id: specialize-execution, version: 1.0.0 }
scope: { kind: workflow-phase-routing, workflowId: coding-workflow }
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
profiles:
  before:
    selectionRule: exact-target-v1
    fallback: deny
    assignments:
      - phase: executor
        target: { workflowId: coding-workflow, childPath: [], nodeId: implement }
        route: { provider: anthropic, id: claude-sonnet-4-5, thinking: medium }
  after:
    selectionRule: exact-target-v1
    fallback: deny
    assignments:
      - phase: executor
        target: { workflowId: coding-workflow, childPath: [], nodeId: implement }
        route: { provider: openai, id: gpt-5.4, thinking: high }
```

For an embedded child, list the child node ids from the root to the target. For example,
`childPath: [delegate-review]` addresses a node inside the `delegate-review` child workflow. Keep
`workflowId` equal to the root workflow id.

The source is limited to 1,048,576 UTF-8 bytes. Identifiers, paths, routes, targets, profile order,
and unknown fields are validated strictly. Candidate and baseline reads don't follow symbolic
links, and Flow rejects either file if it changes during admission.

## Validate and compose the candidate

Validate the document and its baseline without changing the effective harness:

```sh
flow candidate validate phase-routing.candidate.yaml
```

The result includes the candidate digest and the computed `before` and `after` profile digests.
Record those two profile digests for the evaluation plan.

Compose the candidate onto the exact current effective head:

```sh
flow candidate compose phase-routing.candidate.yaml
```

The command stages one immutable effective-harness artifact and prints its project-relative path,
artifact digest, and candidate state digest. Composition doesn't activate the candidate. Direct
activation of the ordinary phase-routing document fails because it isn't bound to an effective
head.

## Create the paired evaluation plan

Create an `EvaluationPlan` that selects the same staged artifact twice: once as `baseline` and once
as `candidate`. Use `purpose: phase-routing-v1`, and copy the two exact profile digests from
validation.

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: qualify-phase-routing }
purpose: phase-routing-v1
suite:
  id: phase-routing-holdout
  version: 1.0.0
  tasks:
    - id: implement-heldout-change
      partition: holdout
      fixture: fixtures/implement-heldout-change
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - { kind: exists, path: RESULT.md }
profiles:
  - id: baseline
    adapter: flow-workflow-v1
    effectiveCandidate: <staged-effective-candidate-path>
    selection: baseline
  - id: candidate
    adapter: flow-workflow-v1
    effectiveCandidate: <staged-effective-candidate-path>
    selection: candidate
controls:
  model: { provider: test, id: deterministic, thinking: medium }
  phaseRoutingProfiles:
    - { profileId: baseline, profileDigest: <before-profile-digest> }
    - { profileId: candidate, profileDigest: <after-profile-digest> }
  budget:
    maxNodeStarts: 8
    maxModelTokens: 10000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 300000
    maxArtifactBytes: 1048576
  network: deny
  retry: { providerRetries: 0, harnessRetries: 0 }
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: baseline
  candidateProfileId: candidate
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
  minimumCostReductionRate: 0.1
  minimumLatencyReductionRate: 0.1
```

The shared `controls.model` field remains part of the version 1 plan shape. For this purpose, the
two exact phase profiles control model requests instead. `minimumEffect` must be `0`. Both
efficiency thresholds must be greater than `0` and own the routing decision.

Use enough independent held-out tasks and seeds for the intended claim. Two pairs satisfy the
minimum schema in this example, but a small or unrepresentative suite doesn't establish broad
quality or efficiency.

## Run and inspect the evaluation

Validate the complete plan before contacting a provider:

```sh
flow eval validate phase-routing.evaluation.yaml
```

Run the paired schedule, then inspect the offline report:

```sh
flow eval run phase-routing.evaluation.yaml
flow eval inspect qualify-phase-routing
```

The `report.qualification` verdict has one of these values:

| Verdict | Meaning |
| --- | --- |
| `qualified` | Every scheduled held-out pair is complete and environment-comparable, candidate quality is non-inferior, cost and latency meet their thresholds, and safety constraints pass. |
| `not_qualified` | Evidence is complete, but quality, cost, latency, or safety fails a declared threshold. |
| `insufficient_evidence` | A pair, environment match, verifier result, route decision, settlement, usage value, cost value, latency value, or positive quality observation is missing. |

Flow doesn't estimate missing cost or latency and doesn't convert missing evidence to zero. Inspect
`limitations` before using the totals. A `qualified` result applies only to the exact artifact,
profile digests, suite, controls, schedule, and recorded environment.

## Preview and apply activation

Use the staged effective-harness artifact from composition, not the ordinary phase-routing
document. Preview activation first:

```sh
flow candidate activate <staged-effective-candidate-path> \
  --evaluation qualify-phase-routing \
  --actor <operator-label> \
  --dry-run
```

Review the proposal, then apply its exact digest:

```sh
flow candidate activate <staged-effective-candidate-path> \
  --evaluation qualify-phase-routing \
  --actor <operator-label> \
  --expected-digest <proposal-digest>
```

Activation recalculates the report from the stored ledger and rechecks the artifact, effective
states, workflow identities, package closure, ordered profile controls, and qualification verdict.
A changed head, candidate, plan, report, record chain, or profile digest fails closed.

Use `flow activation rollback` with its normal preview and exact-digest procedure to restore a
retained earlier effective state.

## Recover from interruption

`flow eval run` resumes only the missing schedule suffix after it re-admits the exact plan. A
recovered unresolved trial records a harness failure with unavailable accounting. It doesn't infer
route evidence or retry an ambiguous provider request.

Ordinary run recovery reloads the phase profile from the immutable run capability snapshot. It
rechecks each prepared request identity and refuses provider, model, `thinking`, target, or routing
decision drift. Child runs preserve the root workflow id and durable child path.

If validation reports source drift, stop editing the candidate and baseline, then validate again.
If inspection reports `insufficient_evidence`, resolve the named limitation and create a new
evaluation rather than editing the stored ledger.

## Know the non-goals

This implementation doesn't:

- Select routes from task text, provider availability, price feeds, or model output.
- Retry through a different provider or silently use a default route.
- Route a workflow that contains a packaged child workflow.
- Route opaque provider calls inside an ACP executor.
- Route provider-generated context summaries. Use the reference-only compaction mode or a separate
  compaction experiment.

- Claim that lower cost or latency compensates for a quality regression beyond the declared bound.
- Generalize one qualified report to another workflow, model revision, provider environment, or
  task distribution.

For the complete executable contracts, read
[Evaluation plans](../workflow-spec.md#evaluation-plans) and
[Phase-routing candidates](../workflow-spec.md#phase-routing-candidates). For architectural
ownership and trust boundaries, read [Architecture](../architecture.md#evaluation-layer).
