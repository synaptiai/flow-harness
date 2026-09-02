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

### Choose an OpenRouter provider route

OpenRouter supports dynamic model variants that change provider selection without changing the
base model. Flow recognizes these documented variants after it resolves the base model from Pi's
pinned offline catalog:

| Model identifier | OpenRouter routing behavior | Use when |
| --- | --- | --- |
| `z-ai/glm-5.3-flash` | OpenRouter's default routing with Auto Exacto for tool-calling requests | Start here for agent workflows unless measured evidence favors another route. |
| `z-ai/glm-5.3-flash:nitro` | Prefer providers with higher output throughput | Long responses are sensitive to provider speed or stream duration. |
| `z-ai/glm-5.3-flash:exacto` | Prefer providers with stronger tool-calling quality signals | Tool-call reliability matters more than lowest price. |
| `z-ai/glm-5.3-flash:floor` | Prefer lower-priced providers | A tolerant batch workload prioritizes cost. |

OpenRouter documents the [`:nitro` variant](https://openrouter.ai/docs/guides/routing/model-variants/nitro),
the [`:exacto` variant](https://openrouter.ai/docs/guides/routing/model-variants/exacto), and its
[provider-routing behavior](https://openrouter.ai/docs/guides/routing/provider-selection). Provider
availability and ranking can change after Flow admits a run.

Use the same complete model identifier for `doctor` and `run`. For example:

```sh
flow issue doctor https://github.com/example/widgets/issues/42 \
  --plan .flow/github-issue.plan.yaml \
  --provider openrouter \
  --model z-ai/glm-5.3-flash

flow issue run https://github.com/example/widgets/issues/42 \
  --plan .flow/github-issue.plan.yaml \
  --provider openrouter \
  --model z-ai/glm-5.3-flash \
  --command-id <uuid>
```

Flow checks the exact identifier first. If Pi's catalog doesn't contain that identifier, Flow
derives capabilities only for the three documented dynamic variants above. It derives those
capabilities only from a known OpenRouter base model. An unknown suffix or missing base model fails
admission before inference.
The selected suffix remains part of the frozen model and request identity.

## Review the data boundary

An OpenRouter run sends model context to OpenRouter, which can route the request to an upstream
inference provider. Model context can include the frozen issue, admitted repository content,
model-visible tool results, and prior model turns. Flow doesn't send the GitHub credential, give the
model a network tool, or put the OpenRouter credential in model context.

OpenRouter chooses among eligible upstream providers. Flow exposes the bounded dynamic model
variants documented above, but it doesn't expose arbitrary per-request routing fields such as a
provider allowlist, `data_collection`, or `zdr`. Apply required restrictions through OpenRouter
account or organization settings. Don't send sensitive repository content until those controls
and every eligible provider meet your policy.

OpenRouter documents [Zero Data Retention controls](https://openrouter.ai/docs/guides/features/zdr)
and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection). These are
external controls. Flow records the selected OpenRouter model route and provider-reported usage.
It doesn't certify the upstream provider's retention, region, or training policy.

## Bound provider responses and spending

Use three independent controls:

- Set `maxOutputTokens` on each agent and model verifier to bound one provider response.
- Set `maxModelTokens` and `maxCostUsd` in each Flow workflow to bound aggregate admitted work.
- Set a spending limit on the dedicated OpenRouter key or an organization guardrail.

For example, a long-running implementation node can use this workload-specific cap:

```yaml
agent:
  maxOutputTokens: 24576
```

This value isn't a Flow default or an OpenRouter recommendation. Choose it from preserved run
evidence for the exact model, route, node responsibility, and repository. Split a node that mixes
unrelated responsibilities before raising the cap. Model verifiers usually need less output
because they return bounded structured verdicts.

Flow's limits stop new work at durable boundaries. They aren't prepaid reservations.
`maxOutputTokens` asks the provider to end one response at the configured output boundary. The
other Flow limits don't stop a provider request that is already running. Provider-reported usage
arrives during or after the response and can differ from the final invoice. A provider-side key
limit can reject new requests after its own accounting reaches the configured threshold.

A settled output-limited response can qualify for Flow's configured fresh recovery when its durable
model session and effects are complete. A node timeout or lost active response can remain uncertain
and isn't automatically retryable. OpenRouter's
[response caching](https://openrouter.ai/docs/guides/features/response-caching) also doesn't make
duplicate simultaneous requests free. Inspect the existing run before starting a replacement.

Fresh recovery doesn't restore provider-private reasoning or a partial provider stream. It starts a
new request from the portable history that Flow committed before the limit. An output-limited
message with no text, tool call, tool result, or effect can therefore consume a charged attempt
without adding useful portable progress. Keep `recovery.maxAttempts` and the aggregate workflow
budget finite. Don't raise `maxOutputTokens` only to make a repeatedly empty response complete.
Review the route, prompt scope, and model suitability first.

For transient provider failures, declare `recovery.backoff` so a new Flow attempt doesn't begin
immediately after the request-level transport retries are exhausted. Choose an initial and maximum
window that fit the provider's expected recovery time and the node timeout. Flow uses deterministic
equal jitter within each exponential window and persists the exact deadline. The delay doesn't hide
or refund the failed attempt.

OpenRouter's dynamic route and Flow's response cap are independent. The default route applies
OpenRouter's [Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto) quality-aware
routing for tool calls. The `:nitro` variant instead prioritizes output throughput, which can help a
response settle before a long node timeout. Neither route guarantees a latency or completion
target. Don't pin one upstream provider from a transient endpoint snapshot. Availability, ranking,
and telemetry can change between requests.

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

1. Confirm that `--provider` is `openrouter` and `--model` is either the exact
   `z-ai/glm-5.3-flash` slug or that slug with one supported dynamic variant: `:nitro`, `:exacto`,
   or `:floor`.
2. Confirm that `OPENROUTER_API_KEY` is present in the process that starts Flow. Don't print it.
3. Confirm that the installed Flow version includes the model in its pinned Pi catalog. A model
   released after that package requires a Flow dependency update or a later Flow release.
4. Confirm that the key is active, has credits or an allowed payment route, and hasn't reached a
   provider-side limit.
5. Run `flow issue doctor` again. Don't bypass a failed diagnostic by changing to an unreviewed
   model or weakening the workflow budget.

Provider HTTP failures settle into fixed, secret-free categories:

| Flow failure code | Meaning | Retry behavior |
| --- | --- | --- |
| `pi_provider_authentication_failed` | The provider rejected the credential. | Stop. Correct or rotate the credential. |
| `pi_provider_quota_exhausted` | The account or key has no usable credit or quota. | Stop. Restore provider capacity. |
| `pi_provider_request_rejected` | The provider rejected the model, request shape, policy, or payload. | Stop. Inspect the pinned route and workflow bounds. |
| `pi_provider_rate_limited` | A 429 remained after the model transport's bounded retries. | A side-effect-safe workflow node can use its declared fresh-recovery attempts. |
| `pi_provider_unavailable` | A timeout or documented transient gateway/server status remained after bounded transport retries. | A side-effect-safe workflow node can use its declared fresh-recovery attempts. |

Flow doesn't publish the provider response body, credential, or private nested cause. Preserve the
run and inspect its bounded failure code before you retry. Reuse a command identifier only when the
original command response is lost or uncertain, as described in the
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
