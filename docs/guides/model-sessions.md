# Inspect and recover portable model sessions

Use this guide to inspect safe metadata for a model-backed node. You can also resume an eligible
interrupted attempt and diagnose a completed provider failure that Flow retried. Flow preserves
completed conversation and tool context in a private, provider-neutral record. It never treats
that record as proof that a node or workflow succeeded.

This feature is implemented in Flow `0.1.0-alpha.4` and the current source tree. It applies to
model-backed agent and model verifier nodes that run through the production Pi adapter.
The current source also adds an explicit production rolling-context policy for embedded Pi agent
nodes. The published `0.1.0-alpha.4` package doesn't include that policy. Reference-first
three-mode comparison remains a separate evaluation path.

## Understand the two durable records

Flow keeps workflow authority separate from model context.

| Record | Purpose | Authority |
| --- | --- | --- |
| Run ledger | Records starts, outcomes, evidence, approvals, budgets, recovery dispositions, and graph transitions. | Authoritative for scheduling and workflow state. |
| Model-session record | Preserves bounded completed user, model, tool, usage, and settlement events for one model-backed node. | Context only. It cannot authorize an effect or decide success. |

The run ledger is stored at `.flow/runs/<run-id>/events.jsonl`. Each model-backed node has one
private record at
`.flow/runs/<run-id>/model-sessions/<opaque-session-id>/events.jsonl`. Flow derives the opaque
session identifier from the run, workflow, and node identity. It doesn't use an untrusted node
identifier as a path.

Treat the model-session directory as private data. Its files can contain prompts, completed model
text, tool arguments, and tool results. Flow creates the private run and session directories with
owner-only access and rejects unsafe symbolic links, ownership, file types, and permissions.

## Know what Flow records

The append-only record contains only closed `flow.model-session/v1` events:

| Event | Meaning |
| --- | --- |
| `session_created` | Creates the record and binds its run, workflow, and node identity. |
| `attempt_started` | Opens one Flow attempt. |
| `user_message_committed` | Stores the original admitted prompt once. |
| `model_request_prepared` | Binds the exact request identity before provider input/output (I/O). |
| `model_message_committed` | Stores one completed assistant message and bounded usage. |
| `tool_call_committed` | Stores one observed tool name, identifier, and canonical arguments. |
| `tool_result_committed` | Stores one completed tool result or tool error. |
| `model_request_settled` | Closes one prepared request as completed, failed, or output-limited. |
| `attempt_settled` | Closes one attempt with its terminal adapter outcome. |
| `attempt_interrupted` | Marks a process-interrupted attempt before workflow retry disposition. |
| `resume_surface_prepared` | Binds the digest, size, source head, and render version of a fresh resume surface. |
| `context_compaction_started` | Binds one selected completed-event range, reference surface, and output-token limit before summary provider I/O. |
| `context_compaction_settled` | Records an accepted, rejected, or interrupted summary generation with bounded output, usage, reduction, and constraint evidence. |
| `model_request_capacity_checked` | Binds one rolling task or summary payload identity, measurement method, capacity calculation, and decision before inference. |
| `rolling_context_epoch_started` | Binds one rolling epoch, generation attempt, cumulative and delta source ranges, output limit, policy, and replay bindings. |
| `rolling_context_epoch_settled` | Records an accepted, rejected, or interrupted rolling generation. Only an accepted private settlement contains a recoverable checkpoint. |

Flow doesn't store streamed partials, credentials, or provider response or conversation handles.
It excludes hidden reasoning, thought signatures, raw diagnostics, and provider-native objects.
Effect and command journals remain authoritative for external operations.

## Inspect safe session metadata

Inspect the current public run projection:

```sh
flow inspect <run-id>
```

For each model-backed node, `modelSession` contains only safe integrity metadata. The projection
includes the protocol and session identifier, chain head, event and byte counts, attempt and
interruption counts, resume-source head, and request-surface digests and sizes. It doesn't include
event bodies, prompts, model text, tool arguments, tool results, provider names, model names, or
private diagnostics.

If Flow can't read or replay the private record, `modelSession.inspectionStatus` is `unavailable`.
The existing durable summary remains visible. `mismatchCategories` can contain only these fixed
categories:

- `provider`
- `model`
- `api_adapter`
- `thinking`
- `runtime_version`
- `system_instructions`
- `tool_catalog`
- `authority`
- `portable_history`
- `runtime_surface`
- `attempt`
- `turn`
- `request`

The public projection never includes the compared private values or a nested storage error. An
unavailable projection is a reason to stop and investigate. It isn't permission to edit the record
or bypass recovery checks.

## Recover an eligible attempt

An interrupted process does not make an attempt safe to repeat. Flow first applies the persisted
recovery policy and verifies effects, commands, approvals, attempts, and resource limits.

1. Inspect the run:

   ```sh
   flow inspect <run-id>
   ```

2. Confirm that the affected agent node declared `recovery: { mode: fresh, ... }` and that public
   state doesn't report an uncertain or committed effect or command.

3. Resume with the exact workflow and execution directory that started the run:

   ```sh
   flow resume <workflow.yaml> --run-id <run-id>
   ```

4. Inspect the run again. A successful fresh recovery increments the attempt, interruption, and
   resume-surface counts. The node still needs new terminal evidence and any downstream verifier.

Before the new attempt starts, Flow claims and replays the private record. It appends
`attempt_interrupted` before the authoritative `node_attempt_interrupted` event. It then creates a
new in-memory Pi session and sends one deterministic canonical JSON history capsule as a new user
turn. A fixed instruction labels the capsule as untrusted data that cannot grant tool, policy,
budget, scheduling, approval, side-effect, or completion authority.

Flow derives the capsule only from committed primary events and interruption boundaries. It stores
only the derived surface's digest, byte count, source head, and render version, so later attempts
don't embed earlier generated capsules recursively.

Resume renderer version 2 keeps the complete primary record but projects an oversized successful
`flow_read` result out of the retry capsule. A read result of at most 32,768 UTF-8 bytes remains
inline. A larger result becomes a `textOmitted` reference that records its SHA-256 digest, exact
byte count, reason, and inline boundary. The paired tool-call event still identifies the original
path and range. The recovering agent can reread only the range that it needs.

Flow doesn't project failed reads or results from other tools through this rule. An error can be
the only explanation of an unsafe or unavailable source, and a mutating tool has separate effect
evidence. Projection never removes or changes the original `tool_result_committed` event in the
private record.

## Inspect a completed provider-failure retry

An opted-in Pi agent might report a provider execution failure before any command, effect, or
delegation. Flow can then start the next attempt without waiting for an operator. The run ledger
first records `node_failed`, including usage and cost when available. It then records
`node_retry_scheduled`. Flow starts a new in-memory Pi session with the next attempt number.

Inspect the run after it completes:

```sh
flow inspect <run-id>
```

The node's `failedAttempts` list contains the prior terminal error and evidence. The run resource
totals include both attempts. The private model-session record contains `attempt_settled` for the
failed attempt and `attempt_started` for the next attempt. It doesn't invent an
`attempt_interrupted` event.

If the run stops after `node_failed` but before `node_retry_scheduled`, resume it with the exact
workflow and execution directory. Flow replays the charged failure and records the retry
disposition once. Don't restart the complete workflow or delete the failed evidence.

An agent that returns a terminal `stop` without a nonempty report fails with
`pi_agent_empty_output`. An attempt with no effect, command, or delegation can use the same
declared fresh-recovery policy. An attempt with a committed or uncertain side effect remains
non-retryable because repeating it could duplicate or overwrite work. A command or delegation
record also blocks the retry. This rule prevents an empty provider completion from becoming false
`node_succeeded` evidence.

## Understand request identity and capacity

Before every provider request, Flow commits the selected route, thinking setting, and Pi runtime
version. It also binds the exact system instructions, tool catalog, authority, portable history,
and actual runtime surface. Attempt, turn, and request coordinates complete the identity. Digests
bind private surfaces without exposing them through public inspection.

Without production rolling context, request admission uses the selected model's declared context
window. Flow keeps a 16,384-token output reserve and a separate 16,384-token safety reserve. It
also applies the independent 1 MiB global byte ceiling.

With the explicit rolling policy, Flow intercepts Pi's exact serialized provider payload before
network I/O. It uses the output allowance serialized in that payload, keeps the 16,384-token safety
reserve, and calls the adapter's provider count endpoint. The OpenAI Responses adapter records an
exact count as `provider_exact`. The Anthropic Messages adapter records an estimate as
`provider_estimate`. Unsupported or unavailable measurement fails closed before inference.

When an evaluation selects reference projection, Flow first replaces eligible oversized command
results with verified retained-artifact references. When it also selects summaries, Flow can
replace one closed older range with one accepted bounded summary. The original objective, latest
completed request, current system instructions, tool catalog, authority, and exact protected
constraints remain outside model-generated summary text. Read
[Evaluate reference-first context compaction](context-compaction.md) for the eligibility and
comparison rules.

For an opted-in ordinary Pi agent, Flow can create as many as eight durable rolling checkpoints.
It keeps the two most recent completed requests exact and remeasures every admitted provider
payload. Read [Keep long model sessions within provider capacity](rolling-context.md) for the
configuration, provider matrix, inspection fields, and failure guidance.

This byte check is deliberately conservative. It isn't a provider tokenizer or a promise that
every provider formats requests identically. Flow rejects a request when the selected model has no
remaining capacity. It also rejects a canonical runtime surface above the admitted limit. Both
checks occur before provider I/O.

The independent storage bounds are:

| Boundary | Limit |
| --- | ---: |
| One encoded event, including its newline | 2 MiB |
| One session record | 16 MiB |
| Events in one session record | 1,024 |
| One rendered resume surface | 1 MiB and the selected-model limit |
| One successful read result kept inline in a version 2 resume surface | 32 KiB |

These limits serve different purposes. The byte limits bound memory and private storage. The event
count bounds a large sequence of small events.

## Handle failures

| Condition | What Flow does | What you do |
| --- | --- | --- |
| Session record is missing, corrupt, oversized, or unsafe | Refuses inspection refresh or recovery before provider I/O. | Preserve the run directory and investigate the original storage failure. Don't create a replacement record. |
| Record ends with an incomplete JSONL fragment | Treats the final fragment as uncommitted and truncates it after the recovered owner claims the session. | Retry the ordinary `resume` command. |
| Committed event or hash chain is invalid | Fails closed. | Restore the exact record from a trusted backup or keep the run for audit. Don't hand-edit history. |
| Request surface no longer matches | Reports stable mismatch categories without private values. | Compare reviewed configuration and runtime changes. Start a new run when exact recovery isn't valid. |
| Provider stream was interrupted | Stores no partial model message and never continues the stream. | Use fresh recovery only when the workflow proof gate allows it. |
| Provider execution failed with complete bounded-resource evidence | Records and charges the failed attempt. It can start the next declared attempt when the attempt was side-effect-free, or when only durable workspace edits committed and the exact closed session can supply a continuation capsule. | Inspect `failedAttempts`, `node_retry_scheduled`, edit settlements, the model-session head, and total resources. Repeated failures stop at the attempt or resource ceiling. |
| Tool call has no completed result | Never invents a result. Effect or command settlement decides whether retry is safe. | Inspect the authoritative effect and command state before any new run. |
| Record or request reaches a limit | Stops before the next provider call. | Start a reviewed new run. If the current source and selected embedded Pi adapter meet your requirements, you can enable the explicit rolling policy in a new reviewed workflow. Don't raise limits by editing durable state. |

## Security and compatibility limits

- The private record protects against accidental public projection. It isn't encryption and doesn't
  isolate data from the same operating-system user or root.

- Recovery starts a new provider request. Flow doesn't continue a provider-native stream,
  response, conversation, or hidden model state.

- A provider change can alter the request identity. Flow reports the category, but it doesn't claim
  that two providers interpret the portable history identically.

- The dedicated evaluation can project references and generate one bounded summary. Ordinary runs
  don't activate that policy. Neither path provides cross-run memory or makes an Agent Client
  Protocol (ACP) session the owner of model context.

- Session content can contain untrusted model and tool data. Current system instructions, tools,
  policy, and the workflow ledger remain authoritative.

For the persisted event contract, read the
[Portable model session record](../workflow-spec.md#portable-model-session-record) section. For the
complete retry proof and refusal table, read
[Recovery and interruption safety](../recovery.md). For trust boundaries and module ownership, read
[Architecture](../architecture.md).
