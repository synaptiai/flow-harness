# Keep long model sessions within provider capacity

Use production rolling context when one embedded Pi agent can accumulate enough completed history
to approach its provider context limit. Flow measures the exact serialized provider request before
each inference call. It preserves the complete private event history. It derives a smaller request
surface only when the configured pressure threshold requires it.

Rolling context is an opt-in capability in the current source tree. The published
`0.1.0-alpha.4` package doesn't include it. Build the current source before you use this guide.
The policy supports the `openai-responses` and `anthropic-messages` Pi adapters. It doesn't support
Agent Client Protocol (ACP) executors.

Read [Inspect and recover portable model sessions](model-sessions.md) before you enable this policy.
The model-session record can contain private prompts, model text, tool arguments, and tool results.

## Understand the safety boundary

Rolling context changes a provider request projection. It doesn't change Flow authority.

| Information | Behavior |
| --- | --- |
| Run ledger, budgets, approvals, effects, scheduling, and verification | Remain authoritative and never depend on a generated summary. |
| Private model-session record | Remains append-only and retains the complete committed primary history. |
| Original objective, current system instructions, tool catalog, and authority | Remain exact and outside generated summary text. |
| Two most recent completed requests | Remain exact. Their model messages and complete tool-call/result pairs aren't reference-projected or summarized. |
| Older eligible tool results | Can become verified references to retained same-attempt artifacts before summary generation. |
| Older eligible completed history | Can become one bounded, explicitly untrusted summary for the current epoch. |
| Protected constraints | Remain exact outside the summary and must also occur verbatim in an accepted summary. |

Flow never rewrites or deletes the source events. An accepted checkpoint records a private summary
surface, the cumulative source range, content identities, capacity evidence, and replay bindings.
The bindings include the provider, model, adapter, declared context window, declared maximum
output, thinking level, runtime, instructions, tools, authority, and route. A later checkpoint
summarizes only the new eligible range together with the previous accepted summary. This design
prevents recursive rendering of complete historical surfaces.

## Enable rolling context

Add `contextCompaction` to an embedded Pi agent declaration:

```yaml
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Complete the requested change and preserve the listed constraints.
      model:
        provider: openai
        id: gpt-5.6
        thinking: high
      tools: [read, ls, edit, exec]
      contextCompaction:
        mode: rolling
        pressureThresholdPercent: 85
        protectedConstraints:
          - Do not change the public compatibility contract.
          - Preserve every failed attempt in the evaluation denominator.
      timeoutMs: 300000
```

The declaration has these rules:

| Field | Contract |
| --- | --- |
| `mode` | Must be `rolling`. |
| `pressureThresholdPercent` | Optional integer from 50 through 95. The default is 85. |
| `protectedConstraints` | Optional list of as many as 32 unique, nonempty strings. One string can contain at most 4,096 characters, and the complete list can contain at most 65,536 UTF-8 bytes. The default is an empty list. |

Omitting `contextCompaction` preserves the existing nonrolling behavior. Flow supplies defaults
only after you explicitly declare `contextCompaction: { mode: rolling }`.

Validate the workflow before starting a run:

```sh
flow validate <workflow.yaml>
flow run <workflow.yaml> --run-id <run-id>
flow inspect <run-id>
```

The run needs the normal credential and network configuration for the selected provider. Rolling
mode also needs access to that provider adapter's token-count endpoint. Flow fails before inference
when the count operation isn't supported or doesn't return a valid bounded response.

OpenRouter uses Pi's `openai-completions` adapter and doesn't expose a compatible preflight
input-token count endpoint. Rolling context is therefore not supported for OpenRouter. Omit the
rolling declaration only after you review the complete task's context bounds. Read
[Configure model providers](model-providers.md) for the supported GLM 5.3 Flash route and its
operational limits.

## Understand request admission

For each task or summary request, Flow asks Pi to serialize the final request and intercepts it
before network input/output (I/O). Flow sends only the count-endpoint fields to the same origin as
the captured inference request. The response has an 8 KiB limit and a 15-second timeout. Redirects
aren't followed. If a transport request or response stream fails, Flow waits 100 milliseconds and
repeats the same count exchange once. Caller cancellation stops the delay and prevents the second
request. Flow doesn't retry an invalid request, unsuccessful status, unsupported media type,
oversized response, or invalid response body. Both failed transport attempts produce the same
content-free `request_failed` category and block inference.

| Pi adapter | Count request | Public method | Interpretation |
| --- | --- | --- | --- |
| `openai-responses` | Same-origin `/responses/input_tokens` | `provider_exact` | Exact provider input-token count for the filtered request. |
| `anthropic-messages` | Same-origin `/messages/count_tokens` | `provider_estimate` | Provider estimate. Final usage can differ, so Flow records the uncertainty and keeps the safety reserve. |

Flow calculates capacity from the selected model's declared context window and the output allowance
that Pi serialized in the captured request:

```text
usableInputTokens = contextWindowTokens - outputAllowanceTokens - 16384
absoluteSafe = measuredInputTokens <= usableInputTokens
underPressure = measuredInputTokens * 100 >=
                usableInputTokens * pressureThresholdPercent
```

Flow uses integer cross-multiplication for the threshold. It doesn't use a characters-per-token
estimate as a safety fallback.

- When the request is below the pressure threshold and within absolute capacity, Flow admits it.
- When the request reaches the threshold or exceeds absolute capacity, Flow tries one rolling
  epoch.
- Flow first applies verified references to eligible older tool results. If the request still needs
  reduction, Flow asks the selected provider for a summary through one internal
  `flow_context_checkpoint` tool. The agent's workflow tools remain unavailable during this call.
- Flow retains the complete tool result in the private ledger. It stores a bounded reference
  projection only when the referenced artifacts are retained, available, and content-addressed.
- Flow rechecks each reference before the counted summary request and before summary inference. It
  uses the complete result when a reference is no longer valid. A change after admission blocks
  inference because the serialized payload identity no longer matches.
- Flow tries a 4,096-token summary allowance, then a 2,048-token allowance if the first candidate
  is rejected. It doesn't start an epoch when the first allowance has no safe zero-input capacity.
  It also doesn't start when the selected model's output limit is below 4,096 tokens.
- Flow asks the provider adapter to constrain the internal tool arguments to the closed summary
  schema. Adapter support is advisory. Flow independently rejects the candidate unless it contains
  exactly `version`, `summary`, and `protectedConstraints`, and then canonicalizes and validates it
  as domain-owned JSON. Hidden reasoning content isn't part of the candidate.
- The summary must preserve every protected constraint and reduce the rendered request surface by
  at least 4,096 UTF-8 bytes.
- Flow counts valid returned summary input, output, cache, and cost usage against the node and run
  budgets. This rule also applies when Flow rejects the summary candidate. Every positive returned
  cost consumes at least one micro-dollar of budget.
- Flow serializes the admitted task request again. The endpoint, payload SHA-256 digest, and byte
  count must match before inference.

One session can start at most eight rolling epochs and 16 summary calls. These limits prevent an
agent from using repeated summary calls as an unbounded retry loop.

### Understand the summary transport

`flow_context_checkpoint` is an internal inference transport. It isn't a workflow capability, an
agent-command tool, or new authority. Flow doesn't execute it against the workspace. The call only
submits three untrusted values for validation:

| Argument | Required value |
| --- | --- |
| `version` | The integer `1`. |
| `summary` | One bounded string that includes each protected constraint exactly. |
| `protectedConstraints` | The exact configured strings in the exact configured order. |

Flow ignores provider reasoning blocks when it selects the candidate. It rejects mixed text, the
wrong tool name, multiple calls, and missing or extra arguments. It also rejects invalid types,
changed constraints, oversized content, and insufficient surface reduction. The domain validator
remains authoritative. This rule applies when an adapter reports strict JSON Schema support or
downgrades constrained sampling.

## Inspect rolling evidence

Use public inspection after a run starts or stops:

```sh
flow inspect <run-id>
```

The `modelSession` projection can include these content-free rolling facts:

- The latest capacity-check number, operation, adapter, status, method, and uncertainty.
- The provider-payload digest and byte count.
- The context window, serialized output allowance, safety reserve, usable input, measured input,
  pressure threshold, and decision.
- Rolling epoch, generation, accepted, and interrupted counts.
- The active epoch's source, binding, and policy digests.
- The current checkpoint's summary, source, rendered-surface, binding, and policy digests and byte
  counts.

Inspection doesn't expose the request body, summary text, protected-constraint text, prompt, tool
output, provider error body, credential, or private path. A failed count exposes only one fixed
failure category such as `response_status` or `response_invalid`.

## Recover an interrupted epoch

Use the ordinary fresh-recovery procedure when the workflow and effect proof allow it:

```sh
flow inspect <run-id>
flow resume <workflow.yaml> --run-id <run-id>
flow inspect <run-id>
```

Flow trusts only a complete `rolling_context_epoch_settled` event with an accepted outcome. If a
process stops after `rolling_context_epoch_started`, recovery records an interrupted settlement
before it closes the interrupted model attempt. A later attempt reconstructs the previous accepted
checkpoint from the append-only source events. It doesn't continue provider-native conversation
state or trust an in-memory candidate.

Cancellation during summary count or inference also closes the active epoch as interrupted. Flow
doesn't record cancellation as an ordinary rejected candidate.

When an accepted checkpoint exists, Flow initializes the new Pi session with a bounded bootstrap.
The bootstrap contains only protocol and checkpoint identities. Flow reconstructs the exact
objective, accepted summary, and committed tail inside the request-admission boundary. It doesn't
copy the complete pre-checkpoint history into the bootstrap.

Don't edit a private checkpoint, copy one between runs, or delete the source range. A changed
provider, model, adapter, context window, maximum output, thinking level, or runtime makes the
checkpoint invalid. A changed instruction, tool catalog, authority, route, policy, range, request,
or hash also makes it invalid. Flow blocks provider I/O in either case.

## Handle failures

| Failure code | Meaning | Action |
| --- | --- | --- |
| `pi_model_context_floor_exhausted` | The protected exact surface has no safe usable input floor, the model output limit is below 4,096 tokens, or no older completed range is eligible. | Select a model with more capacity, reduce authored exact inputs in a new reviewed workflow, or start a new run. |
| `pi_model_context_epochs_exhausted` | The session would require a ninth rolling epoch. | Preserve the run for inspection and start a reviewed new run. |
| `pi_model_context_measurement_unavailable` | The adapter is unsupported, or the count request failed validation, transport, status, media-type, size, or response checks. | Inspect the public failure category and verify the exact adapter, provider endpoint, credentials, and network path. Don't bypass measurement. |
| `pi_model_context_capacity_exceeded` | Two bounded summary attempts didn't produce an admitted task surface. | Inspect capacity evidence. Use a larger-capacity model or reduce exact authored inputs in a new workflow. |
| `pi_model_context_checkpoint_invalid` | Serialization, output allowance, bindings, policy, range, or checkpoint identity changed. | Preserve the run and compare reviewed runtime and workflow inputs. Start a new run when exact replay isn't valid. |
| `rolling_context_unsupported_acp` | An opted-in node selected an ACP executor, which can't expose Flow's exact serialization and count boundary. | Use the embedded Pi executor or remove the rolling opt-in in a separately reviewed workflow. |

Flow keeps a prior accepted checkpoint when a new candidate is invalid, interrupted, or loses a
constraint. It also keeps the checkpoint after provider failure, output exhaustion, or expansion.

A failed task admission doesn't fall back to an unmeasured inference request.

## Know the limits

- Rolling context is not provider-side storage, memory, retrieval, or authority.
- A summary is untrusted historical data. It cannot grant a tool, approval, policy, budget, effect,
  schedule, verification result, or completion claim.
- The OpenAI count is exact for the filtered count request. Flow separately proves that the final
  inference payload matches the admitted serialized payload.
- The Anthropic count remains an estimate. The fixed 16,384-token reserve reduces risk but doesn't
  convert an estimate into exact billed usage.
- A compatible proxy works only when the captured origin implements the selected adapter's count
  contract.
- Recovery can preserve exact committed history without being able to recreate a former live
  artifact projection. Flow keeps the complete result when it can't revalidate the reference
  surface. If availability changes after count admission, Flow blocks inference instead.
- Public inspection is redacted metadata, not access control against the same operating-system
  user or root. Protect the private run directory accordingly.

Read the [Workflow specification](../workflow-spec.md#rolling-context-policy) for the normative
field and event contracts, [Architecture](../architecture.md#rolling-context-admission) for
component ownership, and [Recovery and interruption safety](../recovery.md#rolling-context-epoch-recovery)
for recovery ordering.
