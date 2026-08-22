# Decision journal: Issue #159 — Evaluate reference-first model context compaction

**Issue**: #159
**Branch**: `codex/issue-159-reference-first-compaction`
**Started**: 2026-08-22

## Exploration

### User, operator, and system flows

1. **Record completed context** — Flow preserves completed user, assistant, tool-call, and
   tool-result events in the private provider-neutral session record. The workflow ledger remains
   authoritative for scheduling, effects, approvals, budgets, and completion.

2. **Project retained results** — Before a provider request, Flow can replace an eligible large
   command result with validated same-run artifact references. The projection preserves status,
   error state, hashes, and the bounded means to reopen exact bytes.

3. **Consider a summary** — Reference-plus-summary mode first applies deterministic reference
   projection. It selects only a balanced closed history prefix. The original objective,
   instructions, tools, authority, approvals, and effect state remain outside model-generated
   summary authority.

4. **Settle atomically** — Flow records the source head, selected range, bounds, output identity,
   usage, size change, and settlement. Only an accepted settlement changes the provider-facing
   surface. Rejection or interruption retains the prior surface.

5. **Recover interruption** — Recovery detects an unmatched compaction start before it closes the
   interrupted model attempt. A later retry uses a smaller result limit and remains bounded.

6. **Evaluate three modes** — A dedicated held-out experiment runs no compaction, reference-only
   context, and reference-plus-summary context in all six balanced orders. It reports deterministic
   constraint retention, task success, token use, cost, latency, and settlement evidence.

7. **Review evidence** — Evaluation never enables automatic production compaction. An operator can
   inspect or export the experiment and decide separately whether later roadmap work may activate
   a policy.

### Existing patterns

- `flow.model-session/v1` is a strict append-only hash chain with ordered request, tool, attempt,
  interruption, and resume events. Its public projection contains only bounded integrity metadata.

- The Pi stream-function wrapper is the last Flow-owned boundary before provider I/O. It receives
  complete provider-neutral messages, structured tool-result details, the current system prompt,
  and tool catalog.

- Command tools return structured `ArtifactReference` values in their private result details.
  Model-facing text also mentions references, but parsing that display text would create an unsafe
  second protocol.

- `requestCapacity` checks the exact canonical runtime surface before provider I/O. A context
  transformation must run before this check so the committed request identity binds the surface
  the provider actually receives.

- Evaluation v1 deliberately admits exactly two profiles and feeds activation proofs. Its plan,
  routes, schedule, aggregate report, stores, fixtures, CLI, and activation consumers encode that
  pair.

- Existing evaluation runs do not create model-session stores. A compaction experiment must own
  those stores so it can verify lifecycle and surface evidence. It must not infer behavior from
  aggregate token totals.

### Dependency and coupling analysis

The domain layer owns provider-neutral surface selection, compaction lifecycle validation,
canonical identities, bounded metrics, and the dedicated evaluation contract. The application
layer coordinates durable session events, isolated trials, verification, and aggregation. Pi owns
translation at the provider boundary but not durable authority. Filesystem stores persist exact
domain records. CLI and public projections expose only safe evidence.

This preserves the repository dependency direction:

`presentation and infrastructure -> application -> domain`

The generic two-profile evaluator remains unchanged. The compaction experiment can reuse isolated
workspace, filesystem verification, model controls, and trial primitives without making
compaction an activation candidate.

### Research and adversarial conclusions

- DeepSeek Harness validates a separate compaction capability, reference-first pruning, and durable
  lifecycle evidence. It detects unmatched starts and keeps tool call/result ranges balanced. Flow
  adopts those mechanics with a stricter all-candidate rule. A rejected summary cannot partially
  change the active surface.

- Pi keeps full session entries and derives a smaller provider surface, but its default summary is
  model-generated. Pi also enables ambient compaction by default. Flow must disable that path and
  own every transformation it evaluates.

- Anthropic offers context editing and compaction. OpenAI offers compact responses. These
  provider-native blocks cannot become Flow's portable durable source.

- Longer context does not guarantee better retrieval. Position and distractors can reduce task
  accuracy. Evaluation therefore places protected constraints at early, middle, and late positions
  and verifies them deterministically.

- A summary call can cost more than one immediate request saves. Held-out tasks must continue after
  compaction so total session cost and latency measure amortized behavior rather than one request.

- Reference or summary projection reduces provider context but not the 16 MiB and 1,024-event
  authoritative session limits. This slice must document that independent boundary.

## Decision

### Considered approaches

| Approach | Summary | Advantages | Disadvantages | Risk |
| --- | --- | --- | --- | --- |
| A: Two linked v1 evaluations | Run no-context versus references, then references versus summary as separate paired plans. | Small change to the existing evaluator. | Duplicates reference trials, weakens shared-environment comparison, and requires cross-plan provenance. | Medium |
| B: Generalize evaluation v1 | Migrate the generic evaluator and activation consumers to arbitrary multi-arm plans. | Flexible for future experiments. | Changes public pair contracts across scheduling, storage, reports, CLI, fixtures, and activation. | High |
| C: Dedicated compaction experiment | Add one fixed three-mode plan and report while reusing safe execution and verification primitives. | Keeps one coherent experiment, specialized safety evidence, and existing activation compatibility. | Adds a focused plan, store, CLI path, and report that must share rather than copy primitives. | Low |

**Approved approach**: C, a dedicated compaction experiment with Flow-owned provider surfaces.

### Contract defaults

- Modes are `none`, `references`, and `references-and-summary`. No automatic production mode is
  enabled by this slice.

- Reference projection consumes validated structured command artifact references. It preserves the
  original result unless the replacement is available, belongs to the exact run and attempt, and
  is smaller.

- Pi ambient compaction is disabled for every Flow-owned session.

- One experiment trial can accept at most one summary. It can make at most two generation attempts.
  The second output limit must be smaller than the first.

- The original objective stays exact. Current system instructions, tools, authority, unresolved
  approvals, and effect uncertainty remain outside summary authority.

- Selected boundaries never orphan a tool call or result. The most recent complete request remains
  verbatim.

- A summary requires deterministic verification of its protected constraints. Its complete
  provider surface must also meet the plan's minimum reduction.

- Every task and seed forms a three-mode block. The seed count is a positive multiple of six. Each
  task therefore runs all mode orders, with every mode in every position equally.

- Hierarchical evidence first compares references with none. It compares summary with references
  only when the reference gate passes. Any protected-constraint loss rejects the relevant mode.

- Summary usage counts toward total tokens, cost, and execution time. Reports also separate
  compaction bytes, estimated tokens, attempts, interruptions, rejections, and artifact reopening.

### Non-goals

- This slice does not enable automatic production compaction or let a model select a mode.

- This slice does not rewrite, truncate, or relax the authoritative session record.

- This slice does not make a summary authoritative for policy, approval, effects, scheduling,
  budgets, verification, or completion.

- This slice does not persist provider-native compact blocks, response handles, hidden reasoning,
  or credentials.

- This slice does not generalize evaluation v1 or change candidate activation proofs.

- This slice does not parse human-readable tool output to discover artifact references.

### Failure modes

- **Unavailable artifact** — Keep the complete tool result. Do not emit a reference-only
  replacement.

- **Invalid or cross-run reference** — Reject the candidate before provider I/O and retain the
  prior surface.

- **Unbalanced range** — Select no summary. Never split a tool-call/result relationship.

- **Summary error, cancellation, or limit** — Record rejection or interruption and retain the
  reference-only surface.

- **No meaningful reduction** — Reject the summary candidate and report the measured sizes.

- **Constraint loss** — Reject the candidate regardless of task success or token savings.

- **Crash after start** — Recovery records the interrupted compaction before closing the model
  attempt. A later bounded attempt uses a smaller output limit.

- **Durable append failure** — Call no provider with an unrecorded changed surface.

- **Evaluation interruption** — Resume from the committed trial prefix without repeating a settled
  adapter call.

- **Record limit** — Stop before the next append or provider call. Compaction does not authorize a
  larger private record.

## Adversarial review

- The public evaluation header recomputes its plan digest from the redacted identity fields. A
  changed control, constraint, fixture identity, workflow identity, seed, mode, or threshold cannot
  retain the original digest.

- An evaluation trial record requires a matching active-attempt record. The store removes that
  marker only after the terminal hash-chained record is durable. Recovery rejects an active attempt
  that contradicts the public schedule or committed prefix.

- The model-session replay recomputes each compacted range hash and byte count from committed
  primary events. It also recomputes token estimates from the recorded surface bytes.

- Summary usage is all-or-nothing evidence. If a started summary call has no complete terminal
  usage, Flow records the summary metrics as unavailable instead of zero. It also records total
  token and cost metrics as unavailable. The affected paired comparison remains insufficient
  evidence.

- Public run projections accept records created before the compaction counters existed. Missing
  counters decode as zero and a missing active-compaction field decodes as `null`.
