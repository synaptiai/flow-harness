# Decision Journal: Issue #133 — Generate reviewed supplemental-memory candidates from tuning evidence

**Issue**: #133 | **Branch**: `codex/issue-133-model-suggested-memory` | **Started**:
2026-08-20

---

## Context

Flow already stores one immutable, bounded supplemental-memory catalog inside a complete effective
harness state. A hand-authored candidate can add, replace, or remove one entry for one existing root
or embedded-child agent. Composition, paired evaluation, activation, detached execution, recovery,
replay, inspection, export, and rollback all use content-addressed durable state.

Flow also has three model-assisted generation paths. They cover prompt replacements, Agent Skill
resource replacements, and one inert Agent Skill package. Each path uses one exact model tuple and
one turn. Each path also uses zero tools, bounded JSON, tuning evidence, stable admission, and
no-replace publication. Supplemental memory has no equivalent generation path.

Issue #133 adds a model-suggested memory proposal without adding model-owned state authority. The
operator fixes the effective state, target, entry ID, and add-or-replace operation. The model can
return only one bounded content value. The output remains an ordinary inert memory candidate and
cannot affect execution before the existing evaluation and activation gates succeed.

## Current evidence

- One effective state binds workflow, package, memory, and state identities.
- One state admits 16 entries, 16,384 bytes per target, and 65,536 total memory bytes.
- Existing generation contracts admit 16 evidence packets, 1 MiB input, and 65,536 response bytes.
- They also admit 8,192 output tokens, one candidate, and one model turn.
- Candidate publication has stable reads, currentness checks, no-replace commit, and explicit
  uncertainty outcomes.
- Public projections remove raw memory bytes and keep content-free byte identities.

## User, operator, and system flows

### Generate and publish one proposal

1. The operator selects one workflow, agent target, entry ID, and add or replace operation.
2. Replace also binds the exact prior entry digest. Add requires the entry to be absent.
3. Flow reopens the evidence and resolves the complete current state through stable admission.
4. Flow builds one canonical request with the admitted context, evidence, model, and limits.

### Execute and publish the proposal

1. One zero-tool agent turn returns one JSON object with one `value` string.
2. Flow verifies provenance, activity, effects, usage, grammar, bounds, target, and digests.
3. Flow revalidates every admitted source and the current effective head.
4. Flow publishes one inert candidate through the existing no-replace boundary.

### Review, evaluate, activate, and roll back

1. `candidate validate` reopens the generated source and reconstructs its generation provenance.
2. `candidate compose` binds it to the exact current effective head and stages one complete state
   pair.
3. Paired evaluation holds tasks, fixtures, seeds, provider controls, packages, budgets, network,
   retries, ordering, and verification equal.
4. Explicit activation requires a complete superior result and the existing digest-bound preview.
5. Attached and detached runs, child workflows, resume, recovery, and replay use only the retained
   activated state.
6. Rollback selects an earlier complete state and never invokes generation or reopens evidence.

## External standards and research evidence

- [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) define
  application-driven URI content and remain a future acquisition boundary.
- [OpenAI Agents SDK multi-agent guidance](https://openai.github.io/openai-agents-js/guides/multi-agent/)
  distinguishes code-directed orchestration from LLM-directed delegation.
- [ACP v2](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx)
  is a client-to-agent session protocol, not a memory authority.
- [A2A](https://a2a-protocol.org/latest/specification/) addresses independent remote-agent tasks,
  messages, artifacts, identity, and settlement.
- [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) shows that more context does not
  guarantee better information use.
- Persistent-memory poisoning research treats model-authored cross-session state as delayed
  authority.

## Architecture alternatives

The scores are ordinal design judgments from one to five, not runtime measurements.

| Approach | Product value | Existing seam | Safety | Replay | Standards | Actionable now |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A. Reviewed model-suggested memory | 5 | 5 | 5 | 5 | 3 | 5 |
| B. Frozen MCP resource snapshots | 4 | 4 | 3 | 4 | 5 | 4 |
| C. Static multi-node model routing | 3 | 4 | 4 | 5 | 2 | 4 |
| D. A2A remote specialists | 5 | 2 | 1 | 1 | 5 | 2 |
| E. WASI executable extensions | 5 | 3 | 2 | 3 | 5 | 2 |

### Refined A1 decision

The user approved Approach A1. It adds one reviewed model-suggested memory proposal. The proposal
reuses the immutable candidate, paired evaluation, activation, and rollback lifecycle.

The operator owns the complete target and operation. The model emits only one bounded value.
Generated removal is excluded because it needs no content generation. It would also grant the model
a destructive choice. Runtime writes and automatic activation remain separate roadmap work. The
same rule applies to conversation persistence, live retrieval, MCP, ACP, A2A, and remote agents.

## Mathematical bounds

Let `B_i` be rendered input bytes, `B_o` response bytes, `T_o` output tokens, `E` evidence packets,
and `B_m` proposed memory bytes.

- `1 ≤ E ≤ 16`
- `B_i ≤ 1,048,576`
- `B_o ≤ 65,536`
- `1 ≤ T_o ≤ 8,192`
- `1 ≤ B_m ≤ 16,384`

The response envelope contains one key and one JSON string. Every memory byte can require the
six-byte `\\uXXXX` escape. That worst structural representation is below 100 KiB. The independent
65,536-byte response limit is stricter than that theoretical expansion. A model must produce valid
JSON within both response and decoded-memory bounds. Flow does not promise support for every
possible 16,384-byte Unicode value under the response limit.

The selected target still consumes at most 16,384 memory bytes. Under the conservative one-token-
per-byte estimate and Flow's smallest declared 128,000-token evaluation context, that is at most
12.8% before structural prompt overhead. Paired evaluation measures actual utility instead of
assuming that the added context helps.

## Coupling and impact analysis

Dependency direction remains CLI and filesystem infrastructure → application → domain.

- The domain owns the generation request, strict response, provenance, bounds, digests, and
  reconstruction inside the ordinary memory candidate identity.
- The application owns one zero-tool execution and validates provider-owned evidence without file
  or publication authority.
- Filesystem infrastructure admits the complete state and tuning evidence, revalidates currentness,
  and publishes through the existing candidate settlement boundary.
- The CLI adds one mutually exclusive generation grammar and only content-free output.
- Existing lifecycle code remains generic unless review finds a missing cross-binding.
- Detailed pages own the new content, while README stays concise.

## Specification

_Captured by specification-capture on 2026-08-20. Source: user-confirmed refined A1 and Issue #133._

### Non-goals

- No runtime or autonomous memory writes.
- No automatic activation, model-selected targets, or generated removals.
- No conversation history, provider sessions, live retrieval, embeddings, or vector search.
- No MCP, ACP, A2A, or remote-agent transport.
- No memory daemon, database, independent head, package, tool, permission, approval, retry, fallback,
  or sandbox profile.
- No performance claim and no change to existing candidate or retained-state identities.

### Failure modes

- **Timeouts** — a timed-out provider turn fails without retry or final publication.
- **Partial failures** — precommit drift fails cleanly, while unsettled commits or cleanup report
  uncertainty.
- **Invalid input** — invalid or stale input fails before publication with value-free errors.
- **Missing context** — missing project, state, target, entry, evidence, provider, or output context
  fails without fallback.

### Interface contracts

- The mode accepts one baseline, evidence set, agent target, entry ID, operation, output, and model
  tuple.
- The canonical request contains one fixed target and bounded context.
- The response is exactly `{\"value\": string}` and contains no authority fields.
- Optional generation provenance reconstructs all request, response, state, target, model, and usage
  identities.
- The source remains an ordinary `SupplementalMemoryCandidate` under every existing lifecycle
  contract.
- Public views expose content-free identities and omit memory, evidence, paths, responses, and
  private causes.

## Criterion verification map

### Criterion 1 — Explicit generated add or replacement

- **Type**: behavioral and CLI contract
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-candidate-generation.test.ts test/integration/cli/supplemental-memory-candidate-generation.test.ts -t 'generates one explicit memory proposal'`
- **Expected evidence**: exact add and replace candidates are generated for root and child targets.
- **Does not promise**: generated removal or runtime writes.

### Criterion 2 — Content-only model authority

- **Type**: contract and adversarial behavior
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-candidate-generation.test.ts -t 'rejects model-selected authority'`
- **Expected evidence**: extra target, operation, identity, package, tool, or authority fields reject.
- **Does not promise**: model-selected delegation or retrieval.

### Criterion 3 — One-turn provenance and bounds

- **Type**: behavioral and data contract
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-candidate-generation.test.ts test/unit/application/generate-supplemental-memory-candidate.test.ts`
- **Expected evidence**: exact bounds pass and excess values fail. Tests bind each provenance field.
- **Does not promise**: provider-side sampling determinism.

### Criterion 4 — Failure, cancellation, and publication settlement

- **Type**: error handling and filesystem behavior
- **Command**: `npx vitest run test/unit/application/generate-supplemental-memory-candidate.test.ts test/unit/infrastructure/fs/local-supplemental-memory-candidate-generation.test.ts`
- **Expected evidence**: each boundary produces one fixed outcome and no unsafe output.
- **Does not promise**: recovery of a provider turn after process death.

### Criteria 5 and 6 — Existing durable lifecycle and offline use

- **Type**: integration behavior
- **Command**: `npx vitest run test/integration/cli/supplemental-memory-candidate-generation.test.ts test/integration/cli/effective-harness-composition.test.ts test/integration/cli/effective-harness-runtime.test.ts`
- **Expected evidence**: generated content follows the complete durable lifecycle. Activated runs do
  not read live generation sources.
- **Does not promise**: conversation continuation or live retrieval.

### Criterion 7 — Public privacy

- **Type**: error and presentation contract
- **Command**: `npx vitest run test/integration/cli/supplemental-memory-candidate-generation.test.ts test/unit/cli/public-output.test.ts`
- **Expected evidence**: every public projection excludes all private canaries.
- **Does not promise**: memory secrecy from the targeted model.

### Criterion 8 — Backward compatibility

- **Type**: data and runtime contract
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-candidate.test.ts test/unit/infrastructure/fs/local-supplemental-memory-candidate.test.ts test/integration/cli/effective-harness-runtime.test.ts`
- **Expected evidence**: historical hand-authored sources and retained state identities remain exact.
- **Does not promise**: stable-format migration after `v1alpha1`.

### Criterion 9 — Public documentation

- **Type**: documentation and architecture contract
- **Command**: `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/docs/architecture.test.ts`
- **Expected evidence**: public documentation is accurate and passes every repository prose gate.
- **Does not promise**: support for deferred protocols.

### Criterion 10 — Complete verification

- **Type**: repository quality, runtime, package, and hosted integration
- **Commands**:
  - `npm run ci:local`
  - `npm run test:coverage`
  - `npm run test:browser`
  - `npm run test:runtime`
  - `npm pack --dry-run`
  - Optional: `npm run test:live -- -t 'supplemental-memory candidate'`
  - Hosted Linux x64 CI
- **Expected evidence**: all portable gates pass. Coverage stays above repository thresholds. The
  package contains only intended files. Live evidence passes when credentials exist. Hosted Linux
  x64 CI remains green.
- **Does not promise**: a live-provider result when credentials are unavailable locally.

## Implementation plan

1. RED/GREEN/REFACTOR the canonical generation request, strict response, bounds, provenance, and
   ordinary candidate reconstruction.
2. RED/GREEN/REFACTOR the zero-tool application executor and cancellation/privacy behavior.
3. RED/GREEN/REFACTOR stable effective-state/evidence admission and no-replace publication.
4. RED/GREEN/REFACTOR one mutually exclusive CLI mode with content-free output.
5. Prove generated candidates through composition, paired evaluation, activation, durable offline
   execution, recovery, replay, inspection, export, and rollback.
6. Update documentation, run every portable and hosted gate, and complete independent review.
