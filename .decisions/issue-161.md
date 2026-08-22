# Decision Journal: Issue #161 — Manage evidence-backed supplemental-memory relationships

**Issue**: #161 | **Branch**: `codex/issue-161-memory-relationships` | **Started**:
2026-08-22

---

## Context

Flow stores operator-approved supplemental memory as bounded, immutable entries in one complete
effective harness state. Each entry targets one exact workflow, child path, and agent. Candidates,
paired evaluation, activation, execution, recovery, replay, and rollback use content-addressed state
without consulting a live memory service.

Individual entries cannot describe why one fact supports, contradicts, refines, supersedes, or was
derived from another. Adding that metadata creates a graph-integrity problem: replacing one entry
can make both its outgoing and incoming relationships stale. Relationship admission also needs
exact evidence, scope, privacy, model-authority, compatibility, and prompt-budget contracts.

## Current evidence

### Existing lifecycle

- One supplemental-memory candidate changes one entry by add, replace, or remove.
- Memory entries bind exact target, bytes, and SHA-256 identity. Entry order is canonical.
- A complete effective state is the atomic review, evaluation, activation, and rollback unit.
- A capability snapshot carries the effective runtime into attached, detached, child, recovered,
  resumed, and replayed execution.

### Existing authority boundaries

- Goal-workspace evidence locators already resolve one exact durable run event by run, node,
  attempt, sequence, and event digest.
- Model-suggested memory generation lets a model return only one value. The operator owns the
  target, operation, entry identity, review, and activation authority.
- Public views remove memory bytes and retain content-free integrity metadata.

## User, operator, and system flows

### Author one relationship-aware candidate

1. The operator selects the current effective harness state and one memory entry operation.
2. The operator declares zero or more relationship removals and additions incident to that entry.
3. Each relationship addition uses one closed predicate and two exact entry-version endpoints. It
   cites one through four durable run-event locators in the same target.
4. Flow reopens the candidate without following links. It resolves every evidence locator to one
   exact immutable event reference.

5. Flow applies the entry and incident relationship changes as one projection.
6. Flow assesses endpoints, scope, duplicates, cycles, degrees, sizes, evidence, and undeclared
   incident changes before it can stage the candidate.
7. Flow binds the resulting relationship set and deterministic assessment into the complete
   candidate artifact.

### Review, evaluate, and activate

1. Public review shows the target, operation, entry identity, relationship counts, and integrity
   digests. It does not show memory bytes, evidence locators, candidate paths, or private causes.
2. Paired evaluation binds the exact baseline and projected relationship sets and assessments.
3. Flow holds tasks, fixtures, seeds, models, tools, packages, budgets, retries, network denial,
   ordering, and verification controls equal.

4. Activation rechecks the staged artifact, current head, paired result, relationship identities,
   and assessment identities without reopening the source candidate.
5. Apply advances one complete-state head. It cannot publish an entry without its relationship
   change or publish a relationship without its entry change.

### Execute, recover, replay, and roll back

1. A run stores the complete effective runtime in its capability snapshot.
2. Before one targeted agent attempt, Flow selects memory entries and relationships for the exact
   workflow, child path, and agent.
3. Flow renders one bounded escaped memory block and one bounded relationship summary. The summary
   identifies only entry IDs, byte identities, predicates, and unresolved status.

4. Evidence locators and unrelated-agent relationships never enter the model prompt.
5. Detached execution, child execution, recovery, resume, and replay use the retained snapshot.
6. Rollback selects an earlier complete state and never reconstructs relationships from live input.

## External standards and research evidence

### Standards

- [W3C PROV-O](https://www.w3.org/TR/prov-o/) defines derivation, revision, and invalidation
  vocabulary. It informs lineage names, but provenance does not establish truth or trust.
- [Dublin Core Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
  defines replacement vocabulary. Flow uses a narrower exact-version supersession contract.

- [SHACL](https://www.w3.org/TR/shacl/) demonstrates deterministic closed graph validation. Flow
  adopts bounded validation principles but makes no SHACL or RDF conformance claim.
- [SKOS](https://www.w3.org/TR/skos-reference/) uses open-world semantic relationships. That model
  is unsuitable for Flow's closed activation authority because absence must be meaningful here.

### Harness research

- The [MCP reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
  demonstrates a simple entity-relation graph. Its arbitrary strings and mutable operations don't
  satisfy Flow's evidence, versioning, evaluation, or rollback contracts.
- [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/reference/) keeps durable
  model-visible inputs reconstructable from session records. Its optional external memory does not
  supply Flow's conflict-resolution or evidence authority.
- [J-Space Cognition Suite](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)
  motivates visible contradictions. Flow doesn't silently choose a winner.

These sources shape vocabulary and threat analysis. The resulting contract is standards-shaped,
not standards-certified.

## Architecture alternatives

Scores are ordinal design judgments from one to five, not runtime measurements.

| Approach | Atomic replace | Replay | Integrity | Simplicity | Interoperability | Selected |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A. Inline relationships on each memory entry | 1 | 5 | 3 | 3 | 4 | No |
| B. Bounded relationship sidecar in complete state | 5 | 5 | 5 | 4 | 4 | Yes |
| C. Independent mutable relationship graph | 3 | 2 | 2 | 1 | 5 | No |
| D. Derived relationships from model retrieval | 1 | 1 | 1 | 2 | 3 | No |

### Refined Approach B decision

The user approved refined Approach B. Relationships form an optional bounded sidecar beside the
existing memory-entry array inside the same immutable effective state and runtime snapshot.

Inline metadata was rejected because an entry replacement would make inbound edges owned by other
entries stale. Repair would require unlink, replace, and relink activations, temporarily publishing
invalid state. The sidecar lets one candidate replace one entry and rebind every incident edge in
one atomic complete-state transition.

An independent graph service was rejected because it would add a second authority head, live
availability, synchronization, recovery, replay, privacy, and rollback contracts. Model-derived
relationships were rejected because inference cannot become durable authority without explicit
operator review and evidence.

## Relationship contract

### Predicates and endpoints

- Predicates are exactly `supports`, `contradicts`, `refines`, `supersedes`, and `derived_from`.
- Each endpoint binds an entry ID and SHA-256 entry version in one exact target scope.
- Each relationship binds from one to four exact durable run-event references.
- At least one endpoint of every candidate relationship change is the candidate entry.
- Removal and replacement must explicitly remove or rebind every affected incident relationship.
- `supersedes` points from the replacement version to the exact prior version of the same entry.

### Inference and authority

- `refines` and `derived_from` must remain acyclic over active entries.
- `contradicts` is an explicit unresolved condition. It does not suppress either endpoint.

- Flow performs no transitive, symmetric, temporal, confidence, winner, or truth inference.
- Validity depends only on immutable state and evidence. Wall-clock time has no authority.
- Generation can propose memory content only. It cannot create, remove, or rebind relationships.

## Mathematical bounds

The symbols have these meanings:

| Symbol | Meaning |
| --- | --- |
| `R` | Relationships in one state |
| `D_e` | Incident degree of one active entry |
| `C` | Relationship changes in one candidate |
| `V_r` | Evidence references on one relationship |
| `V_s` | Total evidence references in one state |
| `B_r` | Serialized relationship metadata |
| `B_p` | Rendered model-visible relationship summary |

- `R ≤ 32`
- `D_e ≤ 4`
- `C ≤ 8`
- `1 ≤ V_r ≤ 4`
- `V_s ≤ 128`
- `B_r ≤ 131,072` bytes
- `B_p ≤ 8,192` UTF-8 bytes

The evidence bound follows directly from `32 × 4 = 128`. One candidate can remove four prior
incident relationships and add four rebound relationships. The eight-change bound therefore
supports a complete replacement. The relationship metadata bound is twice the 65,536-byte memory
content bound. It remains less than 0.8% of the 16 MiB complete-state limit. All larger state,
runtime, supervisor-frame, and provider-context limits remain independent.

## Coupling and impact analysis

Dependency direction remains CLI and filesystem infrastructure → application → domain.

- A shared domain evidence contract owns run-event locator and resolved-reference schemas and
  canonical digest rules. Goal workspace and memory relationships import it. Neither imports the
  other.
- A shared application resolver owns exact durable event admission. Goal workspace and candidate
  preparation provide their scope-specific policy after resolution.
- Supplemental-memory domain code owns predicates, endpoints, canonical order, graph assessment,
  bounds, prompt summary, candidate projection, and compatibility behavior.

### Lifecycle owners

- Filesystem infrastructure owns stable source admission and invokes the run-evidence resolver. It
  stores no independent relationship state.
- Existing effective-state composition, paired evaluation, activation, capability snapshots,
  scheduler, recovery, replay, public projection, and rollback remain the lifecycle owners.
- The executor receives only a pre-rendered relationship summary. It cannot query evidence, infer
  relationships, or write memory.

No database, vector index, graph server, MCP server, wall-clock expiry, confidence model, automatic
conflict resolver, or provider session is introduced.

## Threat and failure analysis

| Threat or failure | Required behavior |
| --- | --- |
| Replacing an entry leaves an inbound edge stale | Reject unless every incident relationship is explicitly removed or rebound atomically. |
| A relationship cites a mutable or ambiguous event | Resolve exactly one terminal evidence-bearing run event and bind its sequence and digest. |
| Evidence exists for another agent | Reject the relationship before staging. |
| A self-link or duplicate consumes the graph budget | Reject deterministically before publication. |
| Lineage creates a cycle | Reject `refines` or `derived_from` cycles. Don't infer a hierarchy. |
| Contradiction automatically chooses a winner | Preserve both entries and render the unresolved relation explicitly. |
| Evidence locators leak through public output or prompts | Expose content-free relationship counts and digests only. |
| Model-suggested content attempts to add relationships | Reject extra response authority fields; generation remains value-only. |
| Relationship summary exhausts context | Enforce an independent 8 KiB rendered-summary bound. |
| Historical state without the optional sidecar changes identity | Omit the field and preserve exact legacy state, runtime, candidate, and prompt bytes. |
| Recovery consults current relationship source files | Reconstruct only from the retained immutable capability snapshot. |
| Cancellation races publication | Preserve existing pre-ownership cancellation and post-ownership settlement rules. |

## Specification

_Captured on 2026-08-22 from the user-approved refined Approach B and Issue #161._

### Non-goals

- No automatic relationship discovery, transitive closure, symmetry, truth ranking, or winner.
- No live retrieval, embeddings, vector search, knowledge-graph service, MCP transport, or database.
- No model-authored relationship, model-owned activation, runtime memory write, or background repair.
- No wall-clock validity, confidence score, temporal interval, or external ontology conformance.
- No cross-workflow, cross-child, cross-agent, or cross-state relationship.
- No migration that rewrites historical states, candidates, runtimes, evaluations, or prompts.

### Failure modes

- **Timeouts** — no new network operation exists. Existing provider and storage timeouts retain
  their current outcomes.
- **Partial failures** — projection failure publishes nothing. Activation retains the current head
  unless the existing atomic boundary has completed, after which settlement remains authoritative.
- **Invalid input** — malformed, excessive, stale, duplicate, cyclic, cross-scope, unsupported, or
  under-evidenced input fails before staging with content-free errors.
- **Missing context** — missing baseline state, target, entry, relationship, evidence event, event
  digest, or runtime snapshot fails closed without fallback.

### Interface contracts

#### Compatibility and scope

- Optional relationship data preserves every historical identity and prompt byte when absent.
- One candidate contains one memory-entry operation and at most eight incident relationship
  changes.
- Resolved relationships use only closed predicates, exact target and endpoint identities, and
  exact durable run-event references.

#### Identity and disclosure

- State, runtime, candidate, projection, evaluation, and activation identities bind the canonical
  relationship set and deterministic assessment.
- Public views omit private bytes, evidence locators, source paths, and nested private causes.
- The model receives at most one 8 KiB relationship summary for its exact target.

## Criterion verification map

### Criterion 1 — Closed same-scope exact-version relationships

- **Type**: contract and behavioral
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-relationships.test.ts`
- **Expected evidence**: only five predicates and exact same-target endpoint versions pass.
- **Does not promise**: RDF, SHACL, SKOS, PROV, or MCP conformance.

### Criterion 2 — Exact durable run-event evidence

- **Type**: behavioral and error handling
- **Command**: `npx vitest run test/unit/application/resolve-run-evidence-reference.test.ts test/unit/application/goal-workspace.test.ts`
- **Expected evidence**: one-to-four exact references resolve. Missing, ambiguous, corrupt,
  cancelled, and scope-mismatched evidence fails.
- **Does not promise**: that cited evidence proves a relationship is semantically true.

### Criteria 3 and 4 — Atomic incident changes and graph assessment

- **Type**: data processing and error handling
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-relationships.test.ts test/unit/adaptation/supplemental-memory-candidate.test.ts`
- **Expected evidence**: exact bounds pass and plus-one values fail. Every invalid graph form
  rejects before a projection is returned.
- **Does not promise**: concurrent multi-candidate graph edits.

### Criterion 5 — Explicit unresolved contradictions

- **Type**: behavioral
- **Command**: `npx vitest run test/unit/adaptation/supplemental-memory-relationships.test.ts test/unit/adaptation/supplemental-memory.test.ts`
- **Expected evidence**: contradictions remain explicit and produce no derived edges or suppression.
- **Does not promise**: conflict resolution or epistemic ranking.

### Criterion 6 — Complete immutable lifecycle

- **Type**: integration behavior
- **Command**: `npx vitest run test/integration/cli/effective-harness-composition.test.ts test/integration/cli/effective-harness-runtime.test.ts test/unit/application/run-workflow-capabilities.test.ts`
- **Expected evidence**: relationship state remains cross-bound through review, evaluation,
  activation, execution, recovery, replay, and rollback. Generation cannot mutate it.
- **Does not promise**: live graph repair. It also doesn't promise provider conversation
  persistence.

### Criterion 7 — Bounded targeted prompt projection

- **Type**: runtime and privacy behavior
- **Command**:

  ```sh
  npx vitest run test/unit/adaptation/supplemental-memory-relationships.test.ts \
    test/unit/application/run-workflow-child.test.ts \
    test/integration/cli/effective-harness-runtime.test.ts
  ```

- **Expected evidence**: only the exact target receives canonical bounded metadata, with no evidence
  locators or unrelated memory.
- **Does not promise**: correct model use of relationship context.

### Criterion 8 — Public privacy

- **Type**: presentation and adversarial behavior
- **Command**: `npx vitest run test/unit/cli/public-output.test.ts test/integration/cli/effective-harness-runtime.test.ts`
- **Expected evidence**: public output omits private canaries, locators, paths, and causes. It
  retains counts and digests.
- **Does not promise**: secrecy from the targeted model.

### Criterion 9 — Historical compatibility

- **Type**: contract and runtime behavior
- **Command**: `npx vitest run test/unit/adaptation/effective-harness-state.test.ts test/unit/adaptation/effective-harness-runtime.test.ts test/unit/adaptation/supplemental-memory-candidate.test.ts test/integration/cli/effective-harness-runtime.test.ts`
- **Expected evidence**: legacy fixtures retain exact digests, serialized shapes, and prompt bytes.
- **Does not promise**: a future stable-format migration after `v1alpha1`.

### Criterion 10 — Public documentation

- **Type**: documentation and architecture contract
- **Command**: `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/architecture-documentation.test.ts`
- **Expected evidence**: detailed guidance is routed outside README. Links and prose gates pass.
  Architecture and roadmap contracts are current.
- **Does not promise**: support for deferred live retrieval. It also doesn't promise graph
  protocols.

### Complete verification

- **Type**: repository quality, runtime, package, browser, coverage, and hosted integration
- **Commands**:

  ```sh
  npm run ci:local
  npm run test:coverage
  npm run test:browser
  npm run test:runtime
  npm run pack:check
  node scripts/audit-prime-dependencies.mjs
  npm audit --omit=dev --audit-level=low
  ```

- **Hosted command**: Linux x64 CI
- **Expected evidence**: every portable gate passes, and coverage remains sufficient. Packaged files
  are intentional. Production dependencies have no known alert, and hosted CI is green.
- **Does not promise**: live-provider coverage without configured credentials.

## Implementation plan

1. RED/GREEN/REFACTOR shared exact run-event evidence contracts without changing goal-workspace
   wire formats or digests.
2. RED/GREEN/REFACTOR closed relationship schemas, canonicalization, bounds, assessment, prompt
   projection, and legacy absence behavior.
3. RED/GREEN/REFACTOR one-entry plus incident-relationship candidate projection and evidence
   admission.
4. RED/GREEN/REFACTOR complete-state, runtime, evaluation, activation, privacy, recovery, replay,
   and rollback cross-bindings.
5. RED/GREEN/REFACTOR model-visible rendering and confirm generation remains content-only.
6. Segment and update public documentation, then run the full local and hosted verification matrix.
