# Complete the coding quick start

Use the coding quick start to prove one provider-backed read and edit through Flow. The workflow
creates a reviewed fixture, lets one agent make one exact change, and accepts the goal only after a
separate deterministic command runs. That command verifies every fixture byte.

This feature is available in Flow `0.1.0-alpha.3` and the current source tree.

## Understand the boundary

The coding quick start is a bounded product proof, not a general repository task.

- You must select coding mode, a provider, and a model explicitly. The target must be an existing,
  empty directory.
- Flow creates only `.flow/config.yaml` and `FLOW_QUICKSTART.md` before the run starts.
- The agent receives only the Flow-owned `read`, `ls`, and hash-bound `edit` tools.

The run keeps these restrictions:

- The agent cannot run commands, use a network tool, write `.flow`, or create another file.
- Flow does not retry a provider request or open a browser.
- A deterministic verifier, not the model response, decides whether the criterion passes.

The host-side Pi process still has the operating-system authority of the user who starts Flow.
Treat this preview as a developer tool, not as a hostile-workload or multi-tenant security
boundary. Read the [security policy](../../SECURITY.md) before unattended use.

## Before you begin

Install Flow by following [Install the Flow preview](install-preview.md). Confirm that this command
shows `flow quickstart`:

```sh
flow --help
```

Choose one supported preview provider and one exact model from the pinned Pi catalog:

| Provider | Credential environment variable | Example model in the pinned catalog |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-luna` |

Set the selected credential in the environment that starts Flow. Do not put the credential in a
Flow project file, workflow, command argument, shell history, or issue report. Follow the official
[Anthropic API setup](https://docs.anthropic.com/en/api/getting-started) or
[OpenAI API quick start](https://platform.openai.com/docs/quickstart) when you create or rotate a
credential.

The model examples describe the repository's pinned catalog at publication time. Provider
availability can change. Flow checks the exact selected provider, model, and configured
authentication before the first model request. It does not contact the provider during that
preflight.

## Estimate the provider cost

The workflow admits at most 8,192 reported model tokens and USD 0.25 of reported model cost. These
values are Flow accounting limits. They are not a provider reservation, prepaid amount, invoice
guarantee, or hard billing stop. One request that is already in progress can exceed a Flow limit
before the provider returns final usage.

Use the provider's current pricing page before every paid run:

- [Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing)
- [OpenAI API pricing](https://platform.openai.com/pricing)

For a model whose provider publishes per-million-token rates, estimate the request cost with this
formula:

```text
estimated USD =
  ((input tokens × input USD per million tokens) +
   (output tokens × output USD per million tokens)) / 1,000,000
```

Include the provider's cache, reasoning, tool, regional, or service-tier charges when they apply.
The durable Flow usage record is an adapter-reported observation. It might not match the final
provider invoice.

## Run the coding proof

Create and enter a dedicated empty directory:

```sh
mkdir flow-coding-preview
cd flow-coding-preview
```

Run one supported provider and exact model. For Anthropic:

```sh
flow quickstart . \
  --coding \
  --provider anthropic \
  --model claude-sonnet-4-6
```

For OpenAI:

```sh
flow quickstart . \
  --coding \
  --provider openai \
  --model gpt-5.6-luna
```

The complete grammar is:

```text
flow quickstart [directory] --coding --provider <provider> --model <model> [--run-id <id>]
```

`--coding` can occur once. `--provider` and `--model` are required in coding mode. The default run
identifier is `quickstart-coding`.

Flow performs these phases in order:

1. It validates the command grammar, compiles the workflow, and proves that the target is empty.
2. It creates `FLOW_QUICKSTART.md`, syncs it, and publishes `.flow/config.yaml` as the project
   marker without replacement.
3. It resolves the published project and checks the selected provider configuration.
4. The agent reads the fixture and submits one edit against the observed SHA-256 version.
5. Flow records policy decisions and the edit receipt before a sandboxed command verifies the
   complete fixture.
6. Flow records the criterion decision and returns a terminal result.

A successful result identifies the mode, fixture, run, evidence path, and tokenized follow-up
commands:

```json
{
  "version": 1,
  "mode": "coding",
  "project": {
    "publication": "created",
    "fixture": "FLOW_QUICKSTART.md"
  },
  "run": {
    "id": "quickstart-coding",
    "status": "succeeded",
    "evidence": ".flow/runs/quickstart-coding/events.jsonl"
  },
  "commands": {
    "inspect": ["flow", "inspect", "quickstart-coding"],
    "browser": ["flow", "web", "quickstart-coding", "--actor", "operator:quickstart"]
  }
}
```

The quick-start result does not include model output, command output, credentials, provider
responses, absolute paths, or nested failure causes.

## Inspect the evidence

Inspect the run before you delete the project or retry:

```sh
flow inspect quickstart-coding
```

Confirm these fields:

- `status` is `succeeded`.
- `goal.status` is `accepted`.
- `goal.criteria.fixture-is-exact.status` is `accepted`.

Confirm this node evidence:

- `nodes.implement.evidence.usage` contains bounded provider-reported usage.
- `nodes.implement.evidence.policyDecisions` contains allowed read and write decisions.
- `nodes.implement.evidence.effectReceipts` contains one committed edit with different
  `beforeSha256` and `afterSha256` values.
- `nodes.verify.evidence.driver` is `command` and its verdict is `accepted`.

The authoritative event ledger is
`.flow/runs/quickstart-coding/events.jsonl`. Hashes prove byte identity. They do not disclose the
fixture or provider response.

You can start the local browser view only after the run reaches a terminal state:

```sh
flow web quickstart-coding --actor operator:quickstart
```

## Cancel safely

Press Control+C once to request cancellation. Flow does not retry the provider.

- Cancellation before project publication leaves no published Flow project.
- Cancellation after publication returns a fixed recovery message and settles the run and edit
  journal before it returns.
- An in-flight provider request might finish and report usage while cancellation settles.
- Do not delete the directory while Flow is settling a run.

After cancellation, run `flow inspect quickstart-coding`. If no run exists, inspect
`.flow/config.yaml` and `FLOW_QUICKSTART.md` before you choose the next action.

## Recover from a failure

Use the fixed public code or terminal run state to select an action:

| Code or state | Meaning | Action |
| --- | --- | --- |
| `invalid_input` | The coding options, provider, model, directory, or run identifier are invalid. | Correct the command. Confirm that the target is empty before you retry. |
| `project_exists` | The target is not empty or already contains Flow configuration. | Do not replace it. Choose a new empty directory. |
| `provider_unavailable` | The exact provider, model, or configured authentication failed preflight. | Correct only the selected provider setup. Inspect the published project, then retry in a new empty directory. |
| `publication_failed` | Flow failed before it could prove a published project. | Correct directory access. Confirm the target contents before you retry. |
| `publication_uncertain` | Flow cannot prove whether fixture or configuration publication settled. | Inspect both reviewed files. Do not retry in that directory until you resolve their state. |
| `cancelled_after_publication` | Cancellation occurred after the project marker became visible. | Inspect the run and edit receipt before cleanup or retry. |
| Terminal `failed` with `pi_agent_*` | The provider, agent timeout, policy, tool, or edit path failed. | Inspect usage, policy decisions, and effect receipts. Private provider text is intentionally absent. |
| Verifier verdict `rejected` | The fixture bytes do not equal the package-owned expected bytes. | Treat the run as failed even if the model reported success. Inspect the receipt and fixture. |
| Verifier verdict `inconclusive` | Flow could not establish a trustworthy verifier result. | Inspect command evidence and sandbox availability. Do not infer success from the fixture alone. |

If the initiating process stopped unexpectedly, use the same inspection-first procedure. The event
ledger, not process memory or model prose, is authoritative. Do not edit `.flow` by hand.

## Clean up or retry

Keep the dedicated directory when you need its evidence. If you no longer need it, first complete
these checks:

1. Exit the directory.
2. Confirm that it is the dedicated directory that you created for this proof.
3. Confirm that no Flow process is still using it.
4. Save any event ledger that you need for a report.
5. Use your operating system's removal tool to delete only that dedicated directory.

Do not rerun `flow quickstart` in the published project. Use a new empty directory and, when you
need to distinguish attempts, an explicit new `--run-id`. Flow does not automatically delete a
failed or cancelled project because that would discard recovery evidence.

## Verify a live provider as a contributor

The default test suite uses no provider credential or network. To run only the opt-in coding proof,
set the same provider and model variables used by the other live Pi tests:

```sh
FLOW_LIVE_PI_PROVIDER=openai \
FLOW_LIVE_PI_MODEL=gpt-5.6-luna \
npm run test:live -- test/live/quickstart-coding.live.test.ts
```

Use `anthropic` and an exact Anthropic model identifier for the Anthropic path. The test skips when
the variables are absent or configured authentication is unavailable. A selected invalid model,
provider failure, tool failure, verifier failure, or unexpected run state fails the test.

## Continue with Flow

- Read [Run and control workflows](run-and-control.md) before you run a workflow in an existing
  project.
- Read [Recovery and interruption safety](../recovery.md) for durable ownership and uncertain
  settlement rules.
- Read [Testing and evaluation](../testing-and-evaluation.md) for offline, runtime, and live test
  boundaries.
- Read [Architecture](../architecture.md) for the control, execution, and evidence ownership model.
