# Decision Journal: Issue #190 — Keep long model sessions within safe provider capacity

**Issue**: #190 | **Branch**: `codex/issue-190-rolling-context` | **Started**: 2026-08-27

---

## Context

Flow preserves completed model and tool history in a private append-only model-session record. Its
existing reference-first compaction is an evaluation mode: it projects large tool results to
artifacts and can create one process-local summary before the first provider request. That mode does
not provide threshold-driven production admission, exact provider token measurement, repeated
reductions, or restart reconstruction of an accepted summary.

The third digital-twin Issue #4 attempt exposed a separate defect. Flow subtracted token reserves
from a model context window and treated the result as bytes, so a valid request failed at 239,233
bytes even though its provider capacity was much larger. A byte bound can protect Flow's own
serialization and persistence, but it cannot establish provider-token safety.

Issue #190 adds an explicit production policy that measures the exact provider request before every
inference call, preserves all original events, and creates bounded durable rolling checkpoints only
under pressure.

## Research and existing evidence

- DeepSeek Harness keeps source history append-only and derives compacted state through a durable
  projection. Flow adopts that ledger/projection separation, but not provider-owned persistence.
- OpenAI Responses exposes `/responses/input_tokens`, which returns an input-token count for a
  filtered Responses request.
- Anthropic Messages exposes `/messages/count_tokens`. Anthropic documents the result as an
  estimate that can differ slightly from final usage, so Flow records the uncertainty and retains a
  fixed reserve.
- The pinned Pi runtime exposes a final payload observer and per-request `fetch` override. Flow can
  therefore observe the actual wire payload without maintaining a second provider serializer.
- With high reasoning inherited, the pinned Anthropic adapter serializes a nominal 4,096-token
  summary request as 20,480 `max_tokens`. Summary subrequests must explicitly disable reasoning and
  custom thinking budgets. Task requests keep their authored thinking level.
- The npm package exports only the `flow` executable and declares an empty JavaScript `exports` map.
  This issue extends the workflow and CLI contracts, not a supported in-process library API.

## Approved architecture

### Refined C3: exact admission with an append-only ledger and deterministic rolling projection

An agent opts in with this policy:

```yaml
contextCompaction:
  mode: rolling
  pressureThresholdPercent: 85
  protectedConstraints: []
```

Omission preserves current behavior. The compiler supplies the shown defaults only inside an
explicit `contextCompaction` declaration. The threshold is configurable from 50 through 95 percent.

The complete private primary-event log remains authoritative and unchanged. At admission time, Flow
derives a provider-neutral context, asks Pi to serialize the final provider request, intercepts that
request before network I/O, and calls the same-origin token-count endpoint. Flow then asks Pi to
serialize the inference request again and requires the endpoint and payload digest to match the
admitted copy before it permits inference.

At or above the configured pressure threshold, Flow first replaces eligible old oversized tool
results with verified artifact references. If pressure remains high, it may generate a bounded
untrusted summary of the older eligible range. The objective, current system instructions and tool
catalog, Flow-owned authority and budgets, approvals and effects, protected constraints, complete
tool-call/result pairs, and two most recent completed requests remain exact.

An accepted rolling settlement atomically stores the exact private summary surface and all replay
bindings. A later epoch receives the previous accepted summary plus only the newly eligible exact
range. The checkpoint covers the cumulative source range so replay can verify it against the
original append-only events.

### Fixed limits

| Control | Value |
| --- | ---: |
| Default pressure threshold | 85% |
| Threshold range | 50%–95% |
| Safety reserve | 16,384 tokens |
| Summary output attempts | 4,096, then 2,048 tokens |
| Minimum accepted reduction | 4,096 UTF-8 bytes |
| Exact recent tail | Two completed requests |
| Maximum rolling epochs | 8 |
| Maximum summary calls | 16 |
| Maximum accepted summary | 65,536 UTF-8 bytes |
| Maximum count response | 8,192 UTF-8 bytes |
| Count timeout | 15 seconds |

For each exact serialized request:

```text
usableInputTokens = contextWindowTokens - outputAllowanceTokens - safetyReserveTokens
absoluteSafe = measuredInputTokens <= usableInputTokens
underPressure = measuredInputTokens * 100 >=
                usableInputTokens * pressureThresholdPercent
```

All arithmetic uses non-negative safe integers and integer cross-multiplication. For the pinned
GPT-5.6 catalog entry, `272000 - 128000 - 16384 = 127616` usable input tokens, and the first token at
an 85% trigger is 108,474. For the pinned Claude entry, `1000000 - 64000 - 16384 = 919616`, and the
first token at the same trigger is 781,674.

### Provider-count boundary

| Pi API adapter | Measurement | Rolling behavior |
| --- | --- | --- |
| `openai-responses` | Same-origin `/responses/input_tokens`; `provider_exact` | Admit a valid bounded count; otherwise fail closed |
| `anthropic-messages` | Same-origin `/messages/count_tokens`; `provider_estimate` | Admit a valid bounded estimate with the fixed reserve; otherwise fail closed |
| Other adapters | None | Fail closed as unsupported when rolling is enabled |

This is an adapter-capability matrix, not a provider-name allowlist. A compatible proxy can work
only when its captured origin implements the matching count contract.

Flow copies only fields admitted by the count endpoint. It never sends streaming, storage,
cache-routing, or vendor-only fields unless the count contract permits them. Authorization headers
exist only for the transient same-origin count request. Flow rejects redirects, bounds the response,
and does not record credentials, raw provider error bodies, request bodies, or content.

Provider count calls are measurement I/O, not inference I/O. A rolling failure always occurs before
the corresponding task or summary inference request.

### Durable event protocol

Rolling mode adds three event families without changing the evaluation-only compaction events:

- `model_request_capacity_checked` records an ordered check identity, operation, adapter, payload
  identity, measurement method and uncertainty, capacity arithmetic, and decision.
- `rolling_context_epoch_started` records the epoch and generation attempt, cumulative and delta
  source ranges, reference surface, output allowance, policy digest, and replay bindings.
- `rolling_context_epoch_settled` records an accepted, rejected, or interrupted outcome. Only an
  accepted private settlement contains the recoverable summary surface.

A task admission must match the next `model_request_prepared` identity. Summary requests receive
their own capacity checks and usage attribution but cannot recursively start another epoch. Replay
enforces contiguous checks, requests, epochs, generation attempts, source ranges, and paired starts
and settlements.

### State and failure rules

- An accepted checkpoint becomes current only after its complete settlement event is durable.
- Rejected, invalid, interrupted, changed, unavailable, or insufficiently smaller candidates leave
  the prior checkpoint current.
- One task request can start at most one epoch. Each epoch makes at most two summary attempts.
- A session can start at most eight epochs and make at most 16 summary calls.
- If a rejected candidate leaves the previous surface below absolute capacity, Flow can admit that
  unchanged surface and try a later epoch on a later request.
- Summary usage is added to node and run token and cost budgets.
- Stable non-retryable failures are `pi_model_context_floor_exhausted`,
  `pi_model_context_epochs_exhausted`, `pi_model_context_measurement_unavailable`,
  `pi_model_context_capacity_exceeded`, and `pi_model_context_checkpoint_invalid`.
- An opted-in ACP-backed agent fails closed because ACP does not expose the exact serialization and
  token-count boundary.

### Public inspection

Public run inspection exposes only counts, active state, method and uncertainty, capacity arithmetic,
payload digests and byte counts, epoch outcomes, and content-free binding identities and mismatch
categories. It never exposes summary text, protected constraints, prompts, tool output, payloads,
credentials, provider error bodies, or private paths.

## Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Provider-native recallable compaction | Can reduce repeated transport and use provider state | Provider-specific, opaque replay semantics, remote retention and authority coupling | Deferred |
| Full-context threshold with local token heuristics | Simple and provider-neutral | Approximate counts can admit unsafe requests or reject safe ones; chars/4 is not a safety proof | Rejected |
| Provider plugin owns compaction and persistence | Small Flow core change | Splits authority, recovery, and audit state across plugins | Rejected |
| Exact admission with Flow ledger and rolling projection | Exact wire boundary, restart-safe, provider-neutral authority | More protocol and adapter code; count endpoint availability required | Approved |

## Non-goals

- No automatic opt-in, provider-owned history authority, or remote checkpoint store.
- No `characters / 4` admission fallback.
- No compaction of the objective, current authority, approvals, effects, budgets, tool definitions,
  protected constraints, incomplete tool pairs, or two-request exact tail.
- No activation of rolling mode in the three-mode evaluation schedule.
- No ACP approximation or unsupported-adapter best effort.
- No JavaScript library export, provider credential persistence, or summary trust elevation.
- No claim that Anthropic's estimate is an exact billed-usage value.

## Failure modes

- **Count unavailable or malformed** — Fail closed with a content-free measurement category before
  inference.
- **Serialization drift** — Reject when the admitted and inference endpoint or payload digest differs.
- **Absolute overflow** — Reduce once if possible, then fail before inference.
- **Irreducible floor** — Fail when protected exact content alone cannot fit.
- **Epoch exhaustion** — Fail when pressure requires a ninth epoch.
- **Candidate rejection or interruption** — Keep the prior checkpoint current.
- **Restart or torn tail** — Replay only complete durable settlements; existing store recovery owns
  torn final-line handling and single-writer enforcement.
- **Checkpoint, order, range, tool-pair, or binding drift** — Reject replay; never repair or guess.
- **Summary output expansion** — Explicitly disable summary reasoning and verify the serialized output
  allowance before inference.
- **Unsupported ACP or adapter** — Fail only the explicitly opted-in node before provider inference.

## Verification map

| Criterion | Verification | Passing evidence |
| --- | --- | --- |
| Opt-in contract | Workflow compiler and digest tests | Omission is unchanged; explicit defaults are immutable; invalid and unknown fields reject |
| Exact capacity | Pure boundary tests | Integer threshold boundaries, one-token overflow, reserve arithmetic, and stable decisions pass |
| Provider counting | Adapter tests | Closed body filtering, same-origin paths, auth preservation, redirects, timeout, bounds, and secret-free failures pass |
| Durable ledger | Model-session reducer and filesystem tests | Ordered admissions, cumulative ranges, two-request tail, tool pairs, eight epochs, atomic checkpoints, replay, and torn-tail recovery pass |
| Pi runtime | Session tests | No opt-in, threshold reduction, summary rejection, count failure, serialized drift, repeated epochs, restart, and no inference-before-admission pass |
| Runtime composition | Workflow and production-executor tests | Compiled policy reaches Pi; opted-in ACP fails closed; usage reaches run budgets |
| Public inspection | Domain, CLI, and generated-reference tests | Capacity and epoch metadata is present and content-free; all mismatch categories round-trip |
| Documentation | Style, link, clarity, structure, and architecture tests | Workflow specification, guide, recovery, architecture, status, roadmap, and docs hub agree |
| Full release gate | `npm run ci:local`, runtime, package, dependency, and hosted Linux x64 checks | Every applicable local and hosted gate succeeds |
| Field proof | Fresh pinned digital-twin Issue #4 replicate | Frozen controls, red holdout, Flow verifiers, independent checks, ledger inspection, diff review, and draft-PR gate all pass |

All digital-twin attempts remain in the denominator, including failed and incomplete attempts.

