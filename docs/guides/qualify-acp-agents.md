# Qualify two local ACP agents

Use an ACP interoperability qualification to prove that two exact production agents can complete
the same prompt-only Flow workflow. The agents share the model, budget, retry, network, and
private-result controls. Flow records a qualification verdict beside the ordinary comparison
report.

This procedure qualifies only the two admitted executor identities, workflow digest, model
controls, and environment in the report. It doesn't certify another version, another model, every
ACP feature, or a broader tool-authority profile.

## Understand the qualification boundary

A qualification plan has this fixed profile and workflow shape:

- Set `purpose: acp-interoperability-v1`.
- Select exactly two `flow-workflow-v1` profiles with distinct `AcpAgent` identities.
- Use the same workflow source for both profiles.
- Use exactly one agent node whose `agent.text` supplies exactly one result node.

The plan also has these evidence constraints:

- Declare no tools, Agent Skills, tool packages, command approval, or model routes.
- Use an `agent-result-v1` private verifier for every task.
- Require complete model-token and reported-cost accounting from both manifests.

The ACP agents receive the task and ordinary workflow prompt. They don't receive the expected
result, verifier digest source, evaluation store, or the other agent's output. Flow verifies the
canonical typed result only after the underlying run settles.

Read [Local ACP v1 integration](../acp.md#run-a-local-acp-executor) before you create either
manifest. That document owns the executable identity, model mapping, credential, containment, and
single-executor contracts.

## Choose the two agents

Use independently implemented ACP agents that can report both token use and cost for the same
provider and model. Pin each executable or Node package closure to an exact version and hash. Don't
use a mutable `latest` selector or a wrapper that can resolve different code after admission.

[OpenCode](https://github.com/anomalyco/opencode) and
[Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp) are suitable first
candidates when you configure both for the same Anthropic model and reasoning level. This is a
candidate pairing, not a prequalified pairing. Their installed versions, exposed configuration
options, model catalogs, and usage events must satisfy Flow admission at the time of the run.

For each agent:

1. Install it outside the Flow project through its official distribution channel.
2. Record the exact version and executable or package-closure identity.
3. Confirm its ACP configuration identifiers for model and reasoning selection.
4. Confirm that its selected provider reports complete tokens and cost.
5. Create one manifest below `.flow/acp-agents/`.
6. Give the two manifests different metadata names and exact runtime identities.

Use one provider credential only for the selected provider authority. Don't copy credentials into
a manifest, workflow, task fixture, evaluation plan, or shell argument.

## Prepare a private task

Create a fixture directory next to the evaluation plan. Put its instruction in `TASK.md`. This
public example uses a deterministic arithmetic task:

```text
Return a JSON string that contains the decimal sum of 17 and 25. Return no other content.
```

For a meaningful production run, replace the operands and keep the task outside a public source
tree until the evaluation is complete. The agent must return a valid JSON string because the
workflow publishes a typed string result. Don't put the expected answer in `TASK.md`.

The verifier hashes the canonical JSON bytes, including the quotes. The example value has this
identity:

```text
sha256: 8334c554c7276f59674810b92fff5197cd46bf6ccbe872742f9b04ca31dfe3d1
bytes: 4
```

Recompute the values when you change the expected result. This Node.js command prints the
canonical value, byte count, and digest without writing a file:

```sh
node --input-type=module -e 'import {createHash} from "node:crypto"; const value=JSON.stringify(String(17+25)); console.log(JSON.stringify({canonical:value,bytes:Buffer.byteLength(value),sha256:createHash("sha256").update(value).digest("hex")}))'
```

Treat the expected result as holdout test data, not as a secret. Shell history and process
inspection can expose a value supplied on the command line.

## Create the qualification workflow

Save the following workflow next to the plan as `acp-qualification.workflow.yaml`. Replace the
provider, model, reasoning setting, and budgets with values supported by both manifests.

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: acp-qualification }
budget:
  maxNodeStarts: 2
  maxModelTokens: 2000
  maxCostUsd: 1
  maxExecutionMs: 120000
  maxArtifactBytes: 65536
nodes:
  - id: answer
    type: agent
    agent:
      prompt: Follow TASK.md and return only the requested JSON value.
      model: { provider: anthropic, id: <shared-model-id>, thinking: high }
      tools: []
  - id: publish
    type: result
    dependsOn: [answer]
    result:
      source: { nodeId: answer, field: agent.text }
      schema: { type: string, maxLength: 1024 }
```

Qualification admission rejects an extra workflow node or a result that reads another source.
This closed shape ensures that the report attributes the verified result to the admitted ACP
executor.

## Create the qualification plan

Save the following plan as `acp-qualification.evaluation.yaml`. Replace the manifest paths and
shared model control. If you changed the sentinel, replace its digest and byte count.

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
purpose: acp-interoperability-v1
metadata: { id: acp-interoperability }
suite:
  id: acp-qualification-suite
  version: 1.0.0
  tasks:
    - id: answer-contract
      partition: holdout
      fixture: fixtures/acp-answer
      instruction: TASK.md
      verifier:
        kind: agent-result-v1
        sha256: 8334c554c7276f59674810b92fff5197cd46bf6ccbe872742f9b04ca31dfe3d1
        bytes: 4
profiles:
  - id: first-agent
    adapter: flow-workflow-v1
    workflow: acp-qualification.workflow.yaml
    acpAgent: .flow/acp-agents/first-agent.json
  - id: second-agent
    adapter: flow-workflow-v1
    workflow: acp-qualification.workflow.yaml
    acpAgent: .flow/acp-agents/second-agent.json
controls:
  model: { provider: anthropic, id: <shared-model-id>, thinking: high }
  budget:
    maxNodeStarts: 2
    maxModelTokens: 2000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 120000
    maxArtifactBytes: 65536
  network: deny
  retry: { providerRetries: 0, harnessRetries: 0 }
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: first-agent
  candidateProfileId: second-agent
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
```

The baseline and candidate labels satisfy the shared evaluation format. Qualification doesn't
infer that either agent is better.

## Validate before provider use

Build Flow and validate the complete local identity without making a provider request:

```sh
npm run build
node dist/cli/main.js eval validate acp-qualification.evaluation.yaml
```

Confirm all of these fields before you run:

- `valid` is `true`.
- `purpose` is `acp-interoperability-v1`.
- Both profiles have the same `workflowDigest`.
- Both profiles have different `capabilitySnapshotDigest` values.
- `scheduledTrials` matches the intended tasks multiplied by profiles and seeds.

Validation fails if either manifest declares incomplete token or cost accounting. It also fails on
shared executor identity, workflow drift, model mismatch, unsupported node authority, or an
invalid private verifier.

## Run and inspect the qualification

An enabled run can contact the selected provider and incur cost:

```sh
node dist/cli/main.js eval run acp-qualification.evaluation.yaml \
  --evaluation-id acp-interoperability-run-1
node dist/cli/main.js eval inspect acp-interoperability-run-1
node dist/cli/main.js eval export acp-interoperability-run-1 \
  --output acp-interoperability-run-1.json
```

Use a new evaluation identifier when you change an agent, manifest, workflow, task, control, or
environment. Flow rejects a changed plan digest for an existing evaluation.

Read `report.qualification`, not `report.comparison`, for the interoperability decision:

| Verdict | Meaning | Next action |
| --- | --- | --- |
| `qualified` | Every scheduled pair has comparable environments, accepted private results, distinct exact agent identities, confirmed termination, zero tool or authority activity, zero policy violations, and complete token and cost observations. | Preserve the export and exact installed identities as the qualification evidence. |
| `not_qualified` | At least one committed trial proves a conformance failure, such as harness failure, rejected output, authority activity, policy violation, or unconfirmed termination. | Inspect the per-profile failures and underlying run evidence. Fix the agent or mapping, then use a new evaluation identifier. |
| `insufficient_evidence` | The records don't prove a conformance failure, but a trial, pair, comparable environment, observation, verification, or accounting dimension is incomplete. | Resolve the listed `limitations`, then rerun the exact plan to complete only its missing suffix. |

The report includes the shared workflow digest, each capability snapshot, and each agent digest. It
also includes result counts, latency, token and cost totals, failures, and plain-language
limitations. It never makes a compatibility claim from a skipped or incomplete run.

## Automate the live proof

The production-agent live test is opt-in and excluded from default tests. Set one absolute plan
path to enable it:

```sh
FLOW_LIVE_ACP_QUALIFICATION_PLAN=/absolute/path/acp-qualification.evaluation.yaml \
  npm run test:live -- test/live/acp-qualification.live.test.ts
```

The test uses the public `eval validate` and `eval run` commands. It requires a `qualified` verdict,
two distinct agent digests, and no report limitations. When the variable is absent, the test
reports a skip and makes no interoperability claim. When the variable is present but a credential,
runtime, model, accounting event, or provider call is unavailable, the test fails. It doesn't
substitute an agent or model.

Keep provider-backed live qualification out of untrusted pull-request workflows. Deterministic ACP
contract tests and hosted Linux x64 containment tests remain credential-free.

## Recover an interrupted evaluation

Run `eval run` again with the same evaluation identifier and exact plan. Flow validates the
committed prefix and starts only the missing suffix. It doesn't repeat a committed trial or resume
inside an ACP session.

If interruption left an unresolved adapter start, Flow records that schedule position as an
interrupted failure. Don't delete or edit the evaluation ledger to make the report complete. Keep
the report as evidence of that attempt, diagnose the underlying run, and start a new evaluation
identifier if you need a clean qualification claim.

Read [Recovery and interruption safety](../recovery.md#acp-qualification-evaluations) for the
durable-state rules.
