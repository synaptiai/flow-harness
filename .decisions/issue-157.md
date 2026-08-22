# Decision journal: Issue #157 — Preserve portable model session context across safe recovery

**Issue**: #157
**Branch**: `codex/issue-157-portable-model-session-record`
**Started**: 2026-08-22

## Exploration

### User, operator, and system flows

1. **Start a model-backed node** — Flow creates the node's session record before it publishes the
   authoritative `node_started` event. An inert orphan record is safe if publication fails. A
   started node without its required session record is not safe.

2. **Prepare a provider request** — Flow commits a request identity before provider or network I/O.
   The identity binds the route, runtime, system instruction, tools, authority, history, surface,
   attempt, turn, and request.

3. **Record a completed turn** — Flow appends only completed primary user, model, tool, usage, and
   settlement events. It does not append streamed partials, credentials, provider response
   handles, hidden reasoning, encrypted thought signatures, or raw diagnostics.

4. **Recover an interrupted attempt** — Flow first applies every existing workflow, effect,
   command, approval, budget, and retry gate. If recovery is safe, it appends a typed interruption
   boundary to the session record and then archives the workflow attempt.

5. **Create fresh context** — Flow deterministically renders committed primary history as one new
   user turn in a new in-memory Pi session. A fixed instruction identifies historical content as
   untrusted data that cannot grant tools, policy, budget, or completion authority.

6. **Inspect a run** — An operator can inspect session identifiers, hashes, event counts, byte
   counts, source heads, and mismatch categories. Public output never includes private session
   content.

### Existing patterns

- `JsonlRunStore` owns the authoritative workflow ledger, per-run ownership, strict replay,
  durable append, and torn-tail handling.

- `NodeExecutionContext` already passes Flow-owned goal, memory, work-profile, effect, and command
  contracts from the application layer to model infrastructure. These contracts don't grant
  scheduler authority.

- `PiAgentExecutor` creates a new in-memory Pi session for every attempt. Pi publishes awaited
  lifecycle events in order. Its model stream function is the boundary immediately before provider
  I/O.

- `AgentEffectRecorder` and `AgentCommandRecorder` use separate durable write-ahead protocols.
  Their settlements remain the only evidence that external work was applied.

- Public projections already remove private capability and source bytes before CLI, ACP, browser,
  and terminal presentation.

### Dependency and coupling analysis

The domain session contract depends only on strict data validation and canonical hashing. The
application layer coordinates workflow and session durability through a session-store port. The
filesystem implementation owns local JSONL safety. Pi translates awaited provider lifecycle
events into the provider-neutral contract. CLI and presentation code consume only a public
summary. This direction preserves the repository rule:

`presentation and infrastructure -> application -> domain`

The session record does not import workflow replay, filesystem, Pi, ACP, MCP, A2A, or provider
types. The workflow ledger stores only a bounded reference to the session record. This prevents a
circular authority dependency and keeps provider details outside the domain contract.

### Research conclusions

- Anthropic Messages requests are stateless and send conversation history on every request. This
  supports a portable, caller-owned history rather than a provider continuation handle.

- OpenAI Responses and Conversations can retain provider-side state. Their response and
  conversation identifiers are provider-specific and have separate retention semantics, so they
  are not the portable durable source.

- Gemini thought signatures are opaque provider continuation values required for some stateless
  function-call continuations. Flow can hash the actual runtime surface for identity checks, but
  it must not persist signatures as portable history.

- MCP supplies portable user, assistant, and tool-result vocabulary and requires balanced tool
  results. It does not define workflow authority or durable execution settlement.

- ACP is useful for presenting and reopening client sessions. It does not replace Flow's workflow
  ledger or prove a tool side effect.

- A2A warns that streamed messages are not a reliable channel for critical information. Flow
  therefore commits complete events and excludes partial deltas.

- OpenTelemetry generative AI event conventions remain sensitive-data-aware and evolving. Flow
  uses a private durable record with an explicitly redacted public projection instead of treating
  telemetry as recovery authority.

## Decision

### Considered approaches

| Approach | Summary | Advantages | Disadvantages | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| A: Provider-native continuation | Persist response, conversation, or provider session handles and continue the original provider state. | Small request surfaces when a provider retains history. Preserves provider-specific continuation features. | Locks recovery to one provider and retention policy. Persists opaque state. Cannot independently validate portable history. | Medium | High |
| B: Flow-owned bounded portable record | Persist admitted provider-neutral completed events, record a write-ahead request identity, and render a new untrusted-data turn for safe recovery. | Provider-neutral, inspectable, fail-closed, and compatible with existing workflow authority. Avoids opaque continuation state and recursive summaries. | Re-sends bounded context. Cannot preserve hidden reasoning or an interrupted stream. Requires explicit size admission and a new durable store. | Large | Low |
| C: Full provider transcript snapshots | Persist each provider's complete native request and response objects, then translate them on recovery. | Highest native fidelity. Can support provider-specific replay tools later. | Retains sensitive and unstable private fields. Translation is lossy across providers. Record growth and schema drift are difficult to bound. | Large | High |

**Approved approach**: B, a Flow-owned bounded provider-neutral session record.

The record is append-only and belongs to one run and model-backed node across attempts. Flow
creates it durably before `node_started`. A deterministic hash-derived session identifier avoids
using a node identifier as a filesystem path. Per-node records avoid concurrent append conflicts.

Before every provider call, Flow appends `model_request_prepared`. That event binds the provider,
model, API adapter, thinking setting, and runtime version. It binds the exact system-instruction
bytes and digest. It also binds tools, authority, portable history, runtime surface, and request
coordinates. Provider-only opaque state contributes only to the runtime-surface digest.

The record stores primary user messages, completed model messages, observed tool calls, completed
tool results, bounded usage, request settlement, attempt settlement, and typed interruption
boundaries. It does not store streamed partials. A failure to commit a model message stops Pi
before tool execution. A failure to commit a tool result or turn settlement stops the next
provider request. Effect and command records continue to decide external-work safety.

Recovery creates a new in-memory Pi session and supplies one deterministic canonical JSON resume
capsule as its user turn. The capsule is derived only from primary events plus typed interruption
boundaries. Flow stores only the capsule digest, encoded byte count, render version, and source
head. It never appends the generated capsule as primary history, which prevents recursive or
exponential growth.

### Bounds

- One encoded event, including its newline, is at most 2 MiB.

- One committed record is at most 16 MiB.

- One record contains at most 1,024 events.

- One rendered resume surface is at most 1 MiB and must also fit the selected model.

- Request admission reserves 16,384 output tokens and 16,384 safety tokens.

- Request admission includes the UTF-8 bytes of the system instruction, tool catalog, authority,
  portable history, and runtime request surface.

- A missing or invalid model context capacity fails before provider I/O.

The 2 MiB event limit is necessary because the workflow schema permits a 262,144-code-unit agent
prompt. JSON encoding 262,144 control characters requires about 1,572,880 bytes before the event
envelope. A 1 MiB event would reject valid admitted workflow input.

For the currently pinned models, the context capacity after the fixed reserves and before exact
system and tool subtraction is:

| Model | Context tokens | Capacity after 32,768-token reserve |
| --- | ---: | ---: |
| `claude-sonnet-4-5` | 1,000,000 | 967,232 |
| `gpt-5.4` | 272,000 | 239,232 |
| `gemini-3.1-pro-preview` | 1,048,576 | 1,015,808 |

The selected model determines the actual cap. The 1 MiB global ceiling does not override a smaller
model-aware limit.

### Consequences

- A safe retry retains completed portable context without continuing an interrupted provider
  stream.

- Provider switching remains possible only when the exact current request identity passes its
  declared compatibility rules. Flow reports fixed mismatch categories without private values.

- A crash after a final model response but before authoritative node settlement still starts a new
  attempt. Session content cannot infer workflow success.

- Large admitted prompts might be non-resumable for a smaller-context model after system and tool
  overhead. Flow fails closed before provider I/O. Later compaction work can improve this case.

- Record byte and event ceilings are both required. Byte limits bound memory and storage. The count
  limit bounds zero-length and small-event fan-out.

## Specification

_Captured by the specification-capture skill on 2026-08-22. Source: Issue #157 and the
user-approved Approach B._

### Non-goals

- This slice does not continue provider-native streams, conversations, or response handles.

- This slice does not persist credentials, hidden reasoning, encrypted thought signatures, raw
  diagnostics, or provider-native request and response objects.

- This slice does not make the session record authoritative for scheduling, success, side
  effects, approvals, budgets, retries, or completion.

- This slice does not synthesize a successful tool result for an interrupted or orphaned tool
  call.

- This slice does not add lossy history compaction, semantic retrieval, cross-run memory, or ACP
  session ownership.

- This slice does not relax existing recovery eligibility or resource-accounting gates.

### Failure modes

- **Timeouts** — An interrupted request gets no partial model event. Existing deadline handling
  aborts Pi. A later safe recovery appends an interruption boundary and starts a new provider
  request.

- **Partial failures** — Flow durably records request preparation before network I/O. A recorder
  failure after a model response stops tool execution. A failure after a tool result stops the next
  request. Authoritative effect or command settlement remains available independently.

- **Invalid input** — Strict parsing rejects unknown fields, illegal order, attribution mismatches,
  noncontiguous sequences, and invalid digests. It also rejects unbalanced tool history and content
  above any limit.

- **Missing context** — Recovery fails when a started model node has no required session record.
  Missing prompts, corrupt prefixes, missing capacity, or incomplete request identity also fail
  before provider I/O.

- **Dependency outage** — Provider failure settles the prepared request as failed when possible.
  It never becomes a model response or workflow success.

- **Resource exhaustion** — Flow rejects an append that exceeds the event, record, or count limit.
  It rejects an oversized global surface or selected-model request before provider I/O.

- **Torn write** — A final unterminated JSONL record is uncommitted and can be truncated by the
  recovered owner. Corruption inside the committed prefix blocks recovery.

- **Concurrent access** — One workflow owner controls a run. Each model-backed node uses a
  separate record and serialized appends. Live ownership conflicts fail closed.

- **Identity drift** — Replay returns one stable change category. Categories cover the route,
  runtime, system, tools, authority, history, and runtime surface. Replay doesn't disclose compared
  private values.

### Interface contracts

- A session record has version 1 and one deterministic session identifier. It binds one run,
  workflow, and node. A contiguous sequence and cryptographic head bind canonical event bytes.

- Session creation precedes authoritative `node_started` publication for model-backed nodes.

- Every provider call requires a committed `model_request_prepared` identity for its exact
  attempt, turn, and request sequence.

- Only complete primary user, model, tool-call, tool-result, usage, settlement, attempt, and
  interruption events enter portable history.

- The resume capsule is canonical JSON rendered as a new user turn. Its fixed instruction marks
  embedded history as untrusted data. History cannot grant tools, policy, budget, scheduling,
  approval, or completion authority.

- A resume-capsule preparation event stores only render version, source head, digest, and encoded
  byte count. It never stores the generated capsule content.

- Public session output contains identifiers, versions, heads, digests, event and byte counts,
  interruption state, and stable mismatch categories only.

- Session summaries referenced by workflow events cannot decide or imply node success.

## Criterion verification map

All criteria inherit the non-goals above.

| Criterion | Type | Verification command | Expected evidence |
| --- | --- | --- | --- |
| Durable portable history and privacy | Data and security | `npx vitest run test/unit/run/model-session.test.ts test/integration/fs/jsonl-model-session-store.test.ts` | Legal completed events replay identically across attempts; private and opaque fields, oversized events, oversized records, excess counts, invalid order, corrupt prefixes, path attacks, and unsafe ownership are rejected. |
| Write-ahead request identity | Contract and behavior | `npx vitest run test/unit/run/model-session.test.ts test/unit/infrastructure/pi/pi-agent-session.test.ts -t 'request identity|before provider|mismatch'` | The request identity is committed before the stream function runs; all identity dimensions are bound; mismatch output uses stable categories and contains no private values. |
| Recovery safety | Recovery and authority | `npx vitest run test/unit/application/run-workflow-model-session.test.ts test/unit/application/run-workflow-reconciliation.test.ts` | Recovery appends the session interruption before the workflow disposition and retains every existing effect, command, approval, budget, and attempt gate. No missing or corrupt session reaches an executor. |
| Fresh bounded resume capsule | Behavioral and error | `npx vitest run test/unit/run/model-session.test.ts test/unit/infrastructure/pi/pi-agent-session.test.ts -t 'resume capsule|request capacity|partial|tool result'` | The fresh request contains deterministic nonrecursive primary history and the untrusted-data instruction; partial streams and invented tool results are absent; global and selected-model limits fail before provider I/O. |
| Privacy-safe inspection | Public contract | `npx vitest run test/unit/cli/public-output.test.ts test/integration/cli/main.test.ts -t 'model session'` | Run and event inspection exposes only approved metadata and cannot reveal conversation, system, tool, credential, signature, or diagnostic canaries. |
| Public documentation | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste` | Architecture, recovery, workflow, testing, status, and roadmap documents use one exact contract and pass all documentation gates. |
| Complete package remains releasable | Regression | `npm run check && npm run test:coverage && npm run test:browser && npm run pack:check && npm audit --omit=dev --audit-level=low` | Static, complete, coverage, browser, runtime, package-consumer, and dependency gates pass without model credentials. |

## Implementation plan

1. Add the strict session event, replay, hashing, request-identity, capsule, and admission domain
   contracts with RED boundary and adversarial tests.

2. Add the per-node durable JSONL store with RED durability, ownership, torn-tail, permission,
   path-safety, byte, and count tests.

3. Create records before model-node starts and pass one bounded session channel through the
   application port. Add RED recovery-order and safety-gate tests.

4. Wrap Pi's provider boundary with write-ahead request preparation and translate awaited
   complete model and tool lifecycle events. Add RED partial-stream and recorder-failure tests.

5. Render and admit a deterministic fresh-turn resume capsule. Add RED identity mismatch,
   nonrecursive history, privacy, and selected-model capacity tests.

6. Add the public session summary and update the canonical documentation and architecture diagram.

7. Run mapped selectors, full and coverage suites, runtime checks, browser checks, and documentation
   gates. Run package verification, dependency audit, and adversarial review. Merge only when the
   review has no P1, P2, or P3 findings.

## Research references

- [Anthropic Messages examples](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)

- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

- [Gemini thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)

- [MCP sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)

- [ACP protocol schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)

- [A2A protocol specification](https://a2a-protocol.org/dev/specification/)

- [OpenTelemetry generative AI events](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md)
