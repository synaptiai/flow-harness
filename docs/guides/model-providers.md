# Configure model providers

Flow uses the provider and model that you select for a run. The embedded Pi runtime owns model
resolution, authentication, request serialization, and provider-reported usage. Flow keeps the
provider credential on the host and doesn't put it in workflow files, command arguments, model
context, public evidence, or workload-command environments.

This guide covers the provider routes documented for the current source tree. Read
[Complete the coding quick start](coding-quickstart.md) for a bounded first provider-backed run.
Read [Complete a GitHub issue with Flow](github-issue-lifecycle.md) when you are ready to use the
same route for implementation and independent review in another repository.

## Choose a provider

Select one exact provider and model for each command. Flow preserves support for existing OpenAI
and Anthropic routes while adding OpenRouter as another option.

| Provider identifier | Credential environment variable | Example model identifier |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | `gpt-5.6-luna` |
| `openrouter` | `OPENROUTER_API_KEY` | `z-ai/glm-5.3-flash` |

The examples identify models in Flow's pinned Pi catalog. They aren't aliases for the newest model.
Provider catalogs and availability can change independently of Flow. Flow resolves the exact
provider and model from the installed package without a network catalog refresh during admission.
If the installed package doesn't know a model, Flow stops before inference.

## Set up the routed provider

Use this procedure to run GLM 5.3 Flash through OpenRouter:

1. Create a dedicated key in [OpenRouter API keys](https://openrouter.ai/settings/keys). Give the
   key the smallest practical spending limit and an appropriate reset period.
2. Review the [OpenRouter provider logging policies](https://openrouter.ai/docs/guides/privacy/provider-logging).
   Set account or organization privacy controls before you transmit private repository content.
3. Put the key in a secret manager. Export it as `OPENROUTER_API_KEY` only in the environment that
   starts Flow. Don't paste the value into a workflow, issue, command argument, tracked file, log,
   or support report.
4. Confirm that the variable is present without printing its value:

   ```sh
   test -n "${OPENROUTER_API_KEY:-}"
   ```

OpenRouter uses an OpenAI-compatible Chat Completions transport. Pi identifies this transport as
`openai-completions`. The provider remains `openrouter`, and the model remains
`z-ai/glm-5.3-flash`. Don't select `openai` as the provider for an OpenRouter key.

### Prove the route with the coding quick start

Use an empty directory:

```sh
mkdir flow-openrouter-preview
cd flow-openrouter-preview
flow quickstart . \
  --coding \
  --provider openrouter \
  --model z-ai/glm-5.3-flash
```

Flow checks the exact model and authentication before the first model request. It then permits one
bounded read and edit and requires deterministic byte verification. Inspect the result before you
use the provider for a larger task:

```sh
flow inspect quickstart-coding
```

### Use the route for a GitHub issue

Run the read-only diagnostic first:

```sh
flow issue doctor https://github.com/example/widgets/issues/42 \
  --plan .flow/github-issue.plan.yaml \
  --provider openrouter \
  --model z-ai/glm-5.3-flash
```

Use the same route for the admitted run:

```sh
flow issue run https://github.com/example/widgets/issues/42 \
  --plan .flow/github-issue.plan.yaml \
  --provider openrouter \
  --model z-ai/glm-5.3-flash \
  --command-id <uuid>
```

The implementation and review workflows can use `provider: controller` and
`id: operator-selected` placeholders when the GitHub issue plan requires operator-selected routing.
The controller binds those placeholders to the command's exact OpenRouter route. Don't put the API
key in either workflow.

## Review the data boundary

An OpenRouter run sends model context to OpenRouter, which can route the request to an upstream
inference provider. Model context can include the frozen issue, admitted repository content,
model-visible tool results, and prior model turns. Flow doesn't send the GitHub credential, give the
model a network tool, or put the OpenRouter credential in model context.

OpenRouter chooses among eligible upstream providers by default. Flow doesn't currently expose
per-request OpenRouter routing fields such as a provider allowlist, `data_collection`, or `zdr`.
Apply required restrictions through OpenRouter account or organization settings. Don't send
sensitive repository content until those controls and every eligible provider meet your policy.

OpenRouter documents [Zero Data Retention controls](https://openrouter.ai/docs/guides/features/zdr)
and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection). These are
external controls. Flow records the selected OpenRouter model route and provider-reported usage.
It doesn't certify the upstream provider's retention, region, or training policy.

## Keep spending bounded

Use two independent controls:

- Set `maxModelTokens` and `maxCostUsd` in each Flow workflow.
- Set a spending limit on the dedicated OpenRouter key or an organization guardrail.

Flow's limits stop new work at durable boundaries. They aren't prepaid reservations or a hard stop
inside a provider request that is already running. Provider-reported usage arrives during or after
the response and can differ from the final invoice. A provider-side key limit can reject new
requests after its own accounting reaches the configured threshold.

Check the current [GLM 5.3 Flash model page](https://openrouter.ai/z-ai/glm-5.3-flash) before a paid
run. Price, routing, promotion, capacity, and availability data can change without a Flow release.
Don't copy a temporary promotional rate into a long-lived workflow assumption.

## Choose a compatible context policy

Rolling context is not supported for OpenRouter.

Don't declare `contextCompaction: { mode: rolling }` for an OpenRouter node. OpenRouter models use
Pi's `openai-completions` adapter, and OpenRouter doesn't provide the compatible preflight
input-token count contract that Flow requires for strict rolling-context admission. Flow fails
closed before inference instead of estimating a capacity proof.

Omit `contextCompaction` for the current OpenRouter route. Confirm that the complete bounded task
fits the model's pinned context window. Keep prompts and tool output focused. Split work into
smaller dependency-ordered nodes when needed. Don't remove rolling context from an existing
workflow without first reviewing its long-session bounds.

OpenAI Responses and Anthropic Messages retain their documented rolling-context support. Read
[Keep long model sessions within provider capacity](rolling-context.md) for the exact adapter and
token-count contracts.

## Troubleshoot provider admission

If Flow reports that the selected provider configuration is unavailable, check these conditions in
order:

1. Confirm that `--provider` is `openrouter` and `--model` is the exact
   `z-ai/glm-5.3-flash` slug.
2. Confirm that `OPENROUTER_API_KEY` is present in the process that starts Flow. Don't print it.
3. Confirm that the installed Flow version includes the model in its pinned Pi catalog. A model
   released after that package requires a Flow dependency update or a later Flow release.
4. Confirm that the key is active, has credits or an allowed payment route, and hasn't reached a
   provider-side limit.
5. Run `flow issue doctor` again. Don't bypass a failed diagnostic by changing to an unreviewed
   model or weakening the workflow budget.

Provider HTTP failures, rate limits, and exhausted credits settle as provider failures. Preserve
the Flow run and inspect its bounded evidence before you retry. Reuse a command identifier only
when the original command response is lost or uncertain, as described in the
[GitHub issue lifecycle operations runbook](../operations/github-issue-lifecycle.md).

## Continue with an existing route

Existing routes remain valid. Supply the matching credential and exact model:

```sh
flow quickstart . \
  --coding \
  --provider openai \
  --model gpt-5.6-luna
```

Changing the provider changes where model context is transmitted, how the provider bills usage,
and which adapter capabilities are available. It doesn't change the workflow's tools, write
boundary, verification commands, review authority, hosted-check gate, or explicit merge approval.
