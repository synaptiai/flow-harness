# Decision Journal: Issue #131 — Reviewable supplemental-memory candidates

**Issue**: #131 | **Branch**: `codex/issue-131-supplemental-memory` | **Started**:
2026-08-20

---

## Context

Flow can compare, activate, compose, replay, and roll back prompt, Agent Skill, model-route, and
child-specialist candidates. Each reviewed change becomes one complete effective harness state.
Attached runs, detached workers, child workflows, recovery, and replay use that immutable state
without reopening candidate files or live capability catalogs.

The adaptive layer has no memory surface. Operators cannot preserve a reviewed lesson or stable
project fact as supplemental agent context without changing base instructions outside the paired
evaluation lifecycle. Issue #131 adds that surface without adding conversation persistence,
provider session state, live retrieval, or model-controlled writes.

## Current evidence

- An effective harness state binds exact workflow bytes, compiled workflow identity, root workflow
  package identity, complete non-policy package closure, and a state digest. It has a 16 MiB
  serialized limit.

- A capability snapshot carries a content-addressed effective runtime snapshot into attached,
  detached, resumed, recovered, replayed, and child execution. The runtime reconstructs the exact
  state from durable bytes and package snapshots.

- One agent node attempt uses a fresh in-memory Pi session. Flow does not persist provider
  conversation IDs, response IDs, or transcripts.

- Flow owns one fixed agent system prompt. Agent Skill descriptions are appended only for skills
  already selected by the compiled workflow and bound in the immutable capability snapshot.

- Existing effective candidate parsing recompiles baseline and projected complete states and proves
  that only the declared surface changed. Activation advances one atomic complete-state head, and
  rollback selects one retained complete state.

- Public run and event views use shape-aware projections to remove private package bytes while
  retaining internal durable snapshots for offline recovery.

## User, operator, and system flows

### Review and compose one memory candidate

1. The operator selects the current effective harness head as the baseline.

2. The operator supplies one bounded candidate that identifies one existing root agent or one
   existing agent in one embedded child workflow.

3. The candidate declares one stable entry ID and exactly one change: add, replace, or remove.

4. Flow reopens the candidate without following links and verifies the exact baseline state,
   workflow, package closure, target, prior entry state, and candidate identity.

5. Flow applies the declared entry change to the immutable supplemental-memory catalog. It sorts
   entries canonically and enforces entry, target, state, parser, and serialized-state bounds.

6. Flow proves that every unrelated memory entry and every workflow, model, tool, package, policy,
   approval, retry, budget, verifier, sandbox, and graph field is unchanged.

7. Flow stages one complete effective harness candidate artifact for content-free review.

### Evaluate the candidate

1. The operator selects the staged baseline and candidate states in one paired evaluation plan.

2. Flow binds both state identities, the exact memory target, the entry ID, and the before and after
   byte identities.

3. Flow holds tasks, fixtures, seeds, model routes, tools, packages, budgets, network denial,
   retries, order, and verification controls equal.

4. Each trial starts from a fresh workspace and receives only its admitted complete state.

5. Reports identify the target, entry, operation, byte counts, and digests. They do not publish
   memory content or candidate paths.

6. Inspection and export use durable evaluation evidence. They do not reopen the candidate or a
   live catalog.

### Activate, run, and roll back

1. The operator requests a content-free preview for a superior complete paired result.
2. Flow verifies the candidate artifact, evaluation, current head, and both complete states.
3. Apply rechecks those identities under existing effective-harness mutation ownership.
4. Flow publishes immutable dependencies before advancing the effective harness head.
5. A future run stores the selected effective runtime snapshot in its capability snapshot.
6. Before an agent attempt, Flow selects only entries for the exact workflow and agent identities.
7. Flow appends one canonical escaped memory block after its fixed system instructions and before
   the selected Agent Skill catalog.
8. Attached, detached, child, recovery, and replay paths use the retained bytes.
9. Rollback selects a retained complete state and never reconstructs memory from live input.

### Cancel and settle failures

1. Pre-ownership cancellation returns the exact caller reason and publishes no authority.
2. Source drift, stale heads, invalid targets, stale entry identities, malformed bytes, or unrelated
   changes fail closed with value-free errors.
3. A failure before the authoritative head change leaves the prior state selected.
4. A failure after the atomic boundary settles state with an independent signal before restoring a
   late caller cancellation.
5. Cleanup or commit uncertainty remains visible and cannot be replaced by a private cause or a
   later cancellation.

## External standards and research evidence

- [Model Context Protocol resources](https://modelcontextprotocol.io/specification/2025-06-18/server/index)
  are application-controlled context identified by URIs. They inform the distinction between
  application-owned context, user-controlled prompts, and model-controlled tools. Issue #131 keeps
  context application-owned but adds no MCP transport or live resource lookup.

- The [MCP security principles](https://modelcontextprotocol.io/specification/2025-06-18/index)
  require explicit user consent and protection of resource data. Issue #131 requires explicit
  preview and apply and excludes memory bytes from public output.

- [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/) prepend
  stored conversation history and append new turn input and output. The
  [running-agents guide](https://openai.github.io/openai-agents-js/guides/running-agents/)
  distinguishes SDK sessions, server-managed conversations, response chaining, and caller-managed
  history. These are conversation-continuation mechanisms, not Flow's reviewed state authority.

- [Agent Client Protocol session load and resume](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
  restore or reconnect an editor-to-agent conversation. Issue #131 does not use ACP session state as
  memory or replay authority.

- The [Agent2Agent Protocol](https://a2a-protocol.org/dev/specification/) uses context IDs to group
  remote tasks and messages. An agent can maintain internal conversational state, but A2A does not
  define Flow's local evaluation, activation, or rollback authority.

- [LangGraph memory concepts](https://docs.langchain.com/oss/javascript/concepts/memory)
  distinguish short-term thread state from long-term data shared across sessions. Issue #131 adds
  neither mutable thread state nor a general long-term store. It adds one reviewed configuration
  artifact.

- [MemGPT](https://arxiv.org/abs/2310.08560) uses tiered virtual context to manage information that
  exceeds a model context window. Issue #131 does not add model-managed tiers, paging, or writes.

- [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) finds that model performance can
  change significantly with the position of relevant information in long contexts. Flow therefore
  uses one fixed placement and retains paired held-out evaluation instead of assuming that more
  context helps.

- [Evaluating Very Long-Term Conversational Memory of LLM Agents](https://aclanthology.org/2024.acl-long.747/)
  measures recall and reasoning across long multi-session conversations. That problem remains a
  non-goal because Issue #131 stores no conversation history.

- [Securing LLM-Agent Long-Term Memory Against Poisoning](https://arxiv.org/abs/2606.24322) and
  [Hidden in Memory](https://arxiv.org/abs/2605.15338) describe persistent memory as a delayed
  cross-session attack surface. Issue #131 permits no model writes or automatic promotion. It
  requires explicit content-addressed review, evaluation, activation, and rollback.

## Architecture alternatives

The comparison uses seven ordinal dimensions. Scores are design judgments from one to five, not
runtime measurements.

| Approach | Value | Existing seam | Safety | Replay | Standards | Simplicity | Future value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A. Immutable per-agent supplemental entries | 5 | 5 | 4 | 5 | 4 | 4 | 5 |
| B. MCP-shaped lazy resource catalog | 4 | 3 | 3 | 4 | 5 | 2 | 5 |
| C. Provider or ACP session persistence | 5 | 1 | 2 | 1 | 4 | 3 | 3 |
| D. Agent Skill lessons package | 3 | 4 | 3 | 5 | 3 | 3 | 3 |

### Refined A1 decision

The user approved refined Approach A1: one immutable, read-only, per-agent supplemental-memory
catalog inside the complete effective harness state.

| Alternative | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Per-agent immutable entries | Exact attribution, offline replay, existing activation and rollback, no live lookup | Adds a new state and prompt-injection surface that needs strict bounds and privacy | Selected |
| Lazy MCP-shaped resources | Progressive disclosure and standards vocabulary | Adds retrieval authority, read evidence, query semantics, and another runtime branch | Deferred |
| Persistent conversation sessions | Natural conversational continuity | Provider-specific mutable state conflicts with deterministic replay and private-history boundaries | Rejected |
| Agent Skill lessons | Reuses package storage and selection | Conflates behavioral instructions and learned facts and adds package lifecycle semantics | Rejected |

## Mathematical bounds

Let `E` be the number of entries, `B_e` the bytes in one entry, `B_t` the total bytes for one target,
and `B_s` the total bytes in one state.

The accepted bounds are:

- `E ≤ 16`
- `1 ≤ B_e ≤ 16,384`
- `B_t ≤ 16,384`
- `B_s ≤ 65,536`

Flow's smallest declared evaluation context window is 128,000 tokens. Under the conservative upper
estimate of one token per UTF-8 byte, one target's admitted content consumes at most
`16,384 / 128,000 = 0.128`, or 12.8%, of that window. The escaped prompt block also contains entry
metadata and structural markup. Its exact worst case is 101,452 UTF-8 bytes: 98,304 escaped content
bytes plus 3,148 envelope bytes for 16 maximum-length entry IDs. Ordinary reviewed prose is much
smaller, but no contract depends on that observation. The paired evaluation must measure the
actual candidate effect and reject a candidate that exceeds the selected model's usable context.

The 65,536-byte state-wide memory bound is 0.39% of the 16 MiB effective-state bound. Base64
expansion is at most `4 × ceil(65,536 / 3) = 87,384` characters before JSON overhead. Existing
16 MiB state and 40 MiB supervisor-frame bounds therefore remain dominant and must still be
checked independently.

## Coupling analysis

The dependency direction remains CLI and infrastructure → application → domain.

- The domain owns memory entry schemas, targets, canonical order, bounds, byte identities, state
  and runtime digests, candidate projection, surface-only comparison, and prompt-block rendering.

- The application layer applies one reviewed candidate to the current complete state. It prepares
  paired evaluation and activation but does not read files, choose content, or authorize a run.

- Filesystem infrastructure reopens bounded candidate bytes with stable no-follow observations. It
  publishes no state during ordinary candidate admission.

- The scheduler selects supplemental entries through the immutable capability snapshot and exact
  workflow and agent identities. It does not query a live memory store.

- The Pi executor appends the pre-rendered context block to Flow's fixed system instructions before
  its selected Agent Skill catalog. It cannot change tools, model settings, or scheduler authority.

- Existing effective-state storage, transitions, paired evaluation, detached supervision, run
  ledgers, recovery, public projections, and rollback remain the owning lifecycle boundaries.

No memory daemon, vector database, MCP server, provider conversation, writable tool, automatic
summarizer, model-authored candidate, or independent memory head is introduced.

## Threat and failure analysis

| Threat or failure | Required behavior |
| --- | --- |
| Stale candidate overwrites a newer entry | Bind exact absent or prior digest precondition and current head; reject before publication. |
| Candidate targets a different agent after compilation | Bind root workflow, child workflow, target agent, and compiled identities; reject mismatch. |
| Content breaks the prompt delimiter | Encode the content through one canonical structural escaping function and test planted delimiters. |
| Memory asks for new authority | Keep tools, packages, model, policy, approval, budgets, and graph unchanged; describe memory as context only. |
| Many valid entries exhaust context | Enforce per-entry, per-target, state-wide, count, serialized-state, and frame bounds. |
| Live file changes after activation | Store exact bytes in the complete state and runtime snapshot; never reopen the candidate. |
| Detached worker receives an incomplete snapshot | Bind memory bytes and identities into state, runtime, capability, and run digests; fail reconstruction. |
| Public output leaks content or encoded content | Project content-free identities and test raw, encoded, path, key-name, and nested-cause canaries. |
| Model or tool writes memory | Provide no write port or tool; keep Pi sessions attempt-local and in memory. |
| Cancellation races an atomic publish | Return exact cancellation before ownership; settle independently after commit; preserve uncertainty. |
| Memory improves held-out tasks but harms regressions | Use the existing paired held-out and regression acceptance gate. |
| Relevant text is ignored because of prompt placement | Use one fixed placement and require measured evidence instead of an assumed benefit. |

## Specification

_Captured by specification-capture on 2026-08-20. Source: user-confirmed refined Approach A1 and
Issue #131._

### Non-goals

- This issue does not persist transcripts, messages, model outputs, tool observations, provider
  threads, conversation IDs, response IDs, ACP sessions, or A2A task history.

- This issue does not add model-written memory, automatic extraction, summarization, promotion,
  retrieval, ranking, embeddings, decay, compaction, or conflict resolution.

- This issue does not add MCP transport, a remote resource server, a memory database, a writable
  memory tool, or an independent mutable memory head.

- This issue does not add dynamic routing, fallback, remote agents, general delegation, or new
  model, tool, skill, package, policy, approval, budget, verifier, retry, or sandbox authority.

- This issue does not claim that reviewed memory is factually correct or that one evaluated result
  generalizes beyond its declared tasks, seeds, fixtures, model, and verification controls.

### Failure modes

- **Timeouts** — Candidate admission performs no network or model call. Bounded filesystem reads
  honor caller cancellation. Evaluation and runtime retain their existing finite deadlines.

- **Partial failures** — Candidate admission publishes no authority. Immutable candidate and state
  dependencies publish before the effective head. A pre-head failure leaves the old state
  authoritative. Existing exact-state reconciliation governs post-boundary uncertainty.

- **Invalid input** — Invalid, ambiguous, blank, no-op, stale, oversized, unstable, linked,
  duplicate, reordered, or unrelated-changing input fails closed with a fixed stage and no private
  value or cause.

- **Missing context** — A missing active head, target, prior entry, package, evaluation, policy, or
  runtime dependency stops the operation. Flow uses no live fallback.

- **Dependency outage** — Existing provider or sandbox failure becomes one bounded trial or runtime
  outcome. Flow does not choose another memory entry, model, skill, package, or agent.

- **Resource exhaustion** — Entry count, entry bytes, target bytes, state bytes, candidate bytes,
  path bytes, serialized state, event, supervisor frame, inference frame, evaluation, and output
  limits remain finite. Exact limits succeed and limit-plus-one inputs fail before publication.

### Interface contracts

- A supplemental-memory entry has a stable identifier, an exact root or embedded-child agent
  target, a positive UTF-8 byte count, a SHA-256 digest, and canonical base64 content. Entries are
  unique and sorted by target identity and entry ID.

- A memory candidate source has one versioned kind, metadata identity, exact scope, exact baseline
  state and package closure identities, one entry ID, and one add, replace, or remove change.

- An add proves the entry is absent. A replace proves the exact prior byte identity. A remove proves
  the exact prior byte identity and contains no replacement bytes. Every successful operation must
  change the complete state digest.

- A memory candidate identity binds the candidate manifest, baseline head and state, root workflow,
  package closure, target agent, entry ID, operation, content-free before and after identities, and
  projected complete-state digest.

- An effective candidate artifact adds one `supplemental-memory` surface. Baseline and candidate
  states must recompile and differ only at the declared entry.

- A paired evaluation binds both exact complete states, one memory surface, and all shared
  controls. Public artifacts contain only target, entry, operation, byte-count, and digest identity.

- The runtime selects entries by exact current `workflowId` and `agentNodeId`. It renders one
  canonical escaped block after Flow's fixed system instructions and before any selected Agent Skill
  catalog. Untargeted agents receive no block.

- Activation and rollback use the existing effective-state head and atomic transition contract.
  Durable run snapshots include exact memory bytes. Public views never include those bytes.

## Verification map

| Criteria | Type | Planned command | Expected passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–2 | Contract and error | `npx vitest run test/unit/adaptation/supplemental-memory-candidate.test.ts test/unit/adaptation/effective-harness-state.test.ts` | Add, replace, and remove project one exact entry. Root and child targets, canonical order, UTF-8 bytes, exact and plus-one bounds, stale baselines, duplicates, no-ops, invalid targets, and private canaries pass. | Automatic memory extraction or factual validation |
| 3–4 | Composition and state | `npx vitest run test/unit/application/prepare-effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-runtime.test.ts` | Complete state and runtime bind exact bytes and target identity. Every unrelated field and entry is mutation-tested. | A separate mutable memory store |
| 5 | Evaluation | `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/application/run-evaluation.test.ts test/unit/infrastructure/fs/local-evaluation-store.test.ts` | Both exact states and one memory axis are bound while tasks, model, packages, order, budgets, and verification remain shared. | Statistical generalization beyond declared evidence |
| 6 | Activation and settlement | `npx vitest run test/unit/application/prepare-effective-harness-activation.test.ts test/unit/infrastructure/fs/local-effective-harness-store.test.ts test/unit/adaptation/effective-harness-transition.test.ts` | Preview, apply, composition, concurrent mutation, exact rollback, cancellation, and commit-boundary matrices pass. | Distributed multi-host transactions |
| 7–8 | Runtime prompt and authority | `npx vitest run test/unit/application/run-workflow-capabilities.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts test/integration/cli/effective-harness-runtime.test.ts` | Exact root and child targets receive one escaped canonical block after fixed instructions; untargeted agents receive none; sessions remain attempt-local; tools and model settings do not change. | Retrieval, paging, or model-written memory |
| 9 | Public privacy | `npx vitest run test/unit/cli/public-output.test.ts test/integration/cli/effective-harness-composition.test.ts test/integration/cli/evaluation.test.ts` | Run, event, candidate, evaluation, activation, inspect, and export views exclude raw, encoded, path, field-name, and nested-cause canaries while internal snapshots retain exact bytes. | Protection from a privileged user reading project-owned state files |
| 10–11 | Offline lifecycle and cancellation | `npx vitest run test/integration/cli/effective-harness-runtime.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/application/run-workflow-capabilities.test.ts test/unit/infrastructure/fs/local-supplemental-memory-candidate.test.ts` | Attached, detached, child, resume, recovery, replay, and offline paths use retained bytes. Source removal, catalog drift, exact cancellation, cleanup, and settlement matrices pass. | Remote workers or opaque provider-session continuation |
| 12–13 | Documentation and architecture | `npm run docs:style`<br>`npm run docs:links`<br>`npm run docs:ste`<br>`npx vitest run test/integration/package/architecture-documentation.test.ts` | Canonical evaluation, architecture, capability, status, roadmap, README routing, Mermaid explanation, flows, boundaries, and evidence remain accurate. | External standards certification |
| 14 | Static and runtime | `npm run format:check`<br>`npm run lint`<br>`npm run typecheck`<br>`npm run build`<br>`npm test -- --maxWorkers=1 --testTimeout=15000`<br>`npm run test:coverage -- --testTimeout=30000`<br>`npm run test:runtime`<br>`npm run test:browser`<br>`npm run pack:check` | Repository quality, full serial suite, coverage, runtime probes, browser host, and packaged CLI checks pass on the final tree. | Live paid-provider benchmark evidence |

## Verification evidence

The final local tree passed these gates on 2026-08-20:

- The combined acceptance selector passed 383 tests across 24 files. It covered the domain,
  candidate filesystem boundary, complete-state composition, paired evaluation, activation,
  attached and detached execution, child targeting, public projection, and offline replay paths
  named in the verification map.

- The complete serial suite passed 4,506 tests across 325 files, with four existing conditional
  tests skipped:

  ```sh
  npm test -- --maxWorkers=1 --testTimeout=15000
  ```

- The instrumented complete suite passed the same 4,506 tests and four skips. Coverage was 84.64%
  statements, 79.22% branches, 91.37% functions, and 84.77% lines:

  ```sh
  npm run test:coverage -- --testTimeout=30000
  ```

- Formatting, lint, type checking, the distributable build, documentation style, documentation
  links, documentation prose, and architecture-documentation tests passed. Lint retained one
  pre-existing informational suggestion in `src/application/external-harness-adapter.ts`.

- The browser suite passed two tests. The runtime suite passed 43 tests and skipped 34 conditional
  tests. The Prime dependency audit covered the Node lock and 60 Python packages.

- The compiled smoke check passed. Package verification installed and executed
  `synaptiai-flow-harness-0.0.0.tgz` with SHA-256
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.
  The production dependency audit reported zero vulnerabilities.

- The native Prime preparation gate did not run locally because the host and Docker daemon are
  ARM64, while Flow correctly requires Linux x64 for this acceptance boundary. The hosted Linux
  x64 workflow must pass before merge. No platform guard was bypassed.
