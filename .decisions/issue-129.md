# Decision Journal: Issue #129 — Reviewable child-specialist candidates

**Issue**: #129 | **Branch**: `codex/issue-129-child-specialist-candidates` | **Started**:
2026-08-20

---

## Context

Flow can evaluate and activate bounded root-agent prompt, Agent Skill, and model-route changes. It
can also execute declared child workflows with immutable compilation, isolated workspaces, typed
results, complete budgets, durable ledgers, cancellation, recovery, and offline replay.

The adaptive layer cannot target an agent inside an existing child workflow. An operator must make
that change outside the candidate, paired-evaluation, and activation lifecycle. Issue #129 adds one
reviewed child-specialization surface without adding runtime delegation authority.

## Current evidence

- The effective harness state binds exact root workflow bytes, the compiled workflow identity, and
  the complete immutable non-policy package closure.

- A child node contains either one bounded embedded workflow or one exact workflow-package
  reference. Compilation recursively binds its workflow digest, typed result schema, complete
  budget, nesting depth, and tree size.

- Child execution already derives a deterministic run identity and creates an isolated workspace.
  It records an independent ledger and rolls verified resource totals into the parent. Recovery
  reopens the exact workspace and ledger identity.

- Existing prompt candidates can target only agent nodes in the root workflow source. Existing
  Agent Skill package candidates also select one root agent. They cannot express a nested child
  target.

- Existing effective candidate parsing recompiles both complete states and proves that only the
  declared surface differs.

- Paired evaluation already binds two exact effective states. It holds tasks, seeds, budgets,
  network denial, retries, order, and verification controls equal.

## User, operator, and system flows

### Review and compose a child-specialist candidate

1. The operator selects the current effective harness head as the baseline.

2. The operator supplies one candidate for one embedded child node and one agent inside that child.

3. The candidate declares either one instructions replacement or one exact Agent Skill selection.

4. Flow reopens the candidate and declared baseline without following links.

5. Flow proves that the root workflow, child workflow, agent, and package-closure identities match.

6. Flow projects the declared axis, recompiles the complete root and child tree, and proves that
   every unrelated field is unchanged.

7. Flow stages one immutable effective candidate artifact for review.

### Evaluate the candidate

1. The operator selects the staged baseline and candidate states in one paired evaluation plan.

2. Flow binds both exact state identities and the child-specialist candidate identity.

3. Flow proves that the model route, tasks, fixtures, seeds, and budgets are equal. It also holds the
   network policy, retries, immutable package bytes, and verification controls equal.

4. Each trial starts from a fresh workspace and receives only its admitted state.

5. Reports identify the changed child target and axis without publishing prompt or package content.

6. Inspection and export use durable evidence. They do not reopen the live candidate or catalog.

### Activate, run, and roll back

1. The operator requests a content-free preview for a superior complete paired result.
2. Flow verifies the candidate artifact, evaluation, current head, and both complete states.
3. Apply rechecks those identities under the existing effective-harness mutation ownership.
4. Flow publishes immutable dependencies before advancing the single effective harness head.
5. Attached, detached, child, recovery, and replay paths use the selected immutable state.
6. Rollback selects a retained complete state and does not reconstruct the child from live input.

### Cancel and settle failures

1. Pre-ownership cancellation returns the exact caller reason and publishes no authority.
2. Source drift, stale heads, invalid targets, undeclared skills, or unrelated changes fail closed
   with value-free errors.
3. A failure before the authoritative head change leaves the old state selected.
4. A failure after the commit boundary reopens exact durable state and returns the existing settled
   or commit-uncertain outcome.

## External standards evidence

- The [OpenAI Agents SDK orchestration guide](https://openai.github.io/openai-agents-js/guides/multi-agent/)
  distinguishes model-directed orchestration from code-directed orchestration. It states that
  code-directed orchestration gives more predictable speed, cost, and behavior. Issue #129 keeps
  orchestration in the compiled Flow graph.

- The [OpenAI Agents SDK tools guide](https://openai.github.io/openai-agents-js/guides/tools/)
  describes an agent as a tool as a bounded nested run. That run returns a result to the owning
  agent.
  Flow uses its existing child workflow and typed-result boundary. It does not add an SDK-specific
  delegation ABI.

- [Agent Spec](https://oracle.github.io/agent-spec/26.1.2/agentspec/language_spec_26_1_2.html)
  defines a manager-workers pattern with explicit workers. Those workers report to the manager and
  do not interact with the user. The pattern informs the specialist vocabulary. It does not define
  Flow's durable evaluation or activation authority.

- The [Agent2Agent Protocol](https://a2a-protocol.org/latest/specification/) defines remote agent
  discovery, authenticated tasks, messages, artifacts, streaming, and versioning. Issue #129 adds
  no remote agent, transport, discovery, or cross-service authority.

- [Model Context Protocol resources](https://modelcontextprotocol.io/specification/2025-06-18/server/index)
  are application-controlled context. They inform future memory work but do not define child-agent
  adaptation, evaluation, or activation.

## Architecture alternatives

The comparison uses seven ordinal dimensions. The scores are design judgments from one to five,
not runtime measurements.

| Approach | Value | Seam | Safety | Evaluation | Standards | Simplicity | Future value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A. Single-axis child specialist | 5 | 4 | 4 | 4 | 5 | 3 | 5 |
| B. Read-only memory | 4 | 2 | 4 | 5 | 4 | 2 | 5 |
| C. Static multi-node routing | 3 | 5 | 4 | 3 | 3 | 4 | 3 |
| D. Dynamic routing and fallback | 5 | 2 | 1 | 1 | 4 | 1 | 5 |

An exhaustive grid assigned 14 non-negative integer weight units across the seven dimensions. It
evaluated 38,760 combinations. Approach A won 30,649 combinations, memory won 2,499, static
multi-node routing won 3,803, dynamic routing won none, and 1,809 tied. Dynamic routing was Pareto
dominated. The user approved refined Approach A1.

### Child-specialist semantics alternatives

| Alternative | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| One declared axis | Preserves causal attribution and existing surface-only review | Requires sequential candidates to change both instructions and skills | Selected |
| Combined instructions and skills | Reviews a complete specialization in one artifact | Confounds evaluation and expands one candidate's authority | Rejected |
| Complete child workflow replacement | Supports arbitrary specialist graphs | Can change commands, topology, budgets, results, and package authority | Rejected |
| Model-selected delegation | Chooses specialists dynamically | Adds runtime authority, replay decisions, and fallback semantics | Deferred |
| Remote A2A specialist | Supports independently operated agents | Adds discovery, authentication, transport, version, and remote settlement boundaries | Deferred |

## Coupling analysis

The dependency direction remains CLI and infrastructure → application → domain.

- The domain owns the child-specialist candidate schema, one-axis union, exact identities, bounds,
  digest, projection, and unrelated-field rejection.

- The application layer projects a reviewed candidate onto the exact current effective state. It
  prepares evaluation and activation decisions but does not parse files or execute a child.

- Filesystem infrastructure reopens the bounded candidate and evidence with stable no-follow
  observations. It publishes no state during ordinary candidate admission.

- Evaluation infrastructure binds exact complete states and keeps shared controls equal. The
  evaluator does not reopen a candidate or select a skill.

- Existing child compilation, runtime, workspace, ledger, typed-result, recovery, and cleanup code
  consumes the selected workflow. It does not learn a candidate concept.

- The CLI composes the boundaries and emits content-free identities. It does not become the parser,
  projection, evaluation, or activation authority.

No child-specialist head, mutable specialist catalog, session handoff, remote agent, model-selected
worker, or runtime fallback is introduced.

## Specification

_Captured by specification-capture on 2026-08-20. Source: user-confirmed refined Approach A1 and
Issue #129._

### Non-goals

- This issue does not add dynamic delegation, handoffs, routing, fallback, worker discovery, or
  remote agents.

- This issue does not add memory, conversational sessions, retained agent lessons, or writable
  cross-run context.

- This issue does not add, install, generate, replace, or mutate capability-package bytes.

- This issue does not change model routes, tools, tool packages, approvals, recovery, or policies.
  It also does not change budgets, concurrency, graph topology, dependencies, result schemas, or
  isolation.

- This issue does not change packaged child workflows. Their internal bytes remain owned by their
  exact immutable workflow package.

- This issue does not claim that one evaluated specialization generalizes beyond its declared
  evaluation controls. Those controls include tasks, seeds, fixtures, model, package closure, and
  verification controls.

### Failure modes

- **Timeouts** — Candidate admission performs no network or model call. Bounded filesystem reads
  honor caller cancellation. Evaluation and runtime retain their existing finite deadlines.

- **Partial failures** — Candidate admission publishes no authority. Immutable candidate and state
  dependencies publish before the effective head. A pre-head failure leaves the old state
  authoritative. Existing exact-state reconciliation governs post-boundary uncertainty.

- **Invalid input** — Invalid, ambiguous, no-op, multi-axis, stale, oversized, unstable, linked, or
  unrelated-changing input fails closed with a fixed stage. It publishes no candidate or active
  state.

- **Missing context** — A missing required dependency stops the operation. Required dependencies
  include the active head, targets, baseline source, evidence, packages, evaluation, policy, and
  runtime. Flow uses no live fallback.

- **Dependency outage** — Existing provider or sandbox failure becomes one bounded trial or runtime
  outcome. Flow does not choose another specialist, skill, model, or package.

- **Resource exhaustion** — Candidate, instructions, skill count, path, evidence, workflow, package,
  parser, evaluation, and output limits remain finite. Exact limits succeed and limit-plus-one
  inputs fail before publication.

### Interface contracts

- A child-specialist source has one versioned kind, metadata identity, and workflow scope. It also
  identifies one embedded child, one child agent, and one exact baseline. Its change union has one
  of two forms. It contains bounded instructions or a bounded, duplicate-free Agent Skill selection.

- A child-specialist identity binds the manifest, root workflow, embedded child workflow, and target
  agent. It binds the package closure, declared axis, and content-free before and after identities.
  It also binds the projected complete workflow and candidate digest.

- Instructions are non-blank bounded UTF-8. Public identities contain byte counts and SHA-256
  digests, not instructions. Skill selections contain only bounded canonical package names already
  present in the baseline closure.

- An effective candidate artifact adds one `child-specialist` surface. Baseline and candidate states
  must recompile and differ only at the declared target and axis.

- A paired evaluation binds the exact baseline and candidate states. Tasks, fixtures, seeds, model
  route, budgets, network policy, retries, package bytes, order, and verification controls remain
  shared and exact.

- Public views contain only bounded target, axis, state, package, evidence, and digest identities.
  These views include candidate, evaluation, activation, run, event, inspection, and export output.
  They contain no private content or absolute path. They also contain no private response, secret,
  or nested cause.

- Activation and rollback use the existing complete effective-state head and atomic transition
  contract. Runtime and recovery consume only the selected immutable state.

## Verification map

| Criteria | Type | Planned command | Expected passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1–4 | Contract and behavioral | `npx vitest run test/unit/adaptation/child-specialist-candidate.test.ts test/unit/application/prepare-effective-harness-candidate.test.ts test/unit/adaptation/effective-harness-candidate.test.ts` | Both axes project one exact target. Bounds, no-op, multi-axis, ambiguous targets, stale identities, and independent unrelated-field mutations fail. | Packaged-child mutation or dynamic delegation |
| 5 | Filesystem and error | `npx vitest run test/unit/infrastructure/fs/local-child-specialist-candidate.test.ts test/unit/infrastructure/fs/local-adaptation-candidate.test.ts test/unit/infrastructure/fs/local-effective-harness-candidate.test.ts` | Exact and plus-one limits, no-follow ancestry, source races, cancellation precedence, stable reopen, and private canaries pass. | Remote candidate sources or hostile same-user kernel compromise |
| 6 | Evaluation contract | `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/application/run-evaluation.test.ts test/unit/infrastructure/fs/local-evaluation-store.test.ts` | Both exact states and one child axis are bound while every shared control and package byte remains equal. | Statistical generalization beyond the declared tasks and seeds |
| 7 | Activation and settlement | `npx vitest run test/unit/application/prepare-effective-harness-activation.test.ts test/unit/infrastructure/fs/local-effective-harness-store.test.ts test/unit/adaptation/effective-harness-transition.test.ts` | Superior evidence, current-head checks, concurrent mutation, cancellation, rollback, and commit-boundary matrices pass. | Distributed multi-host transactions |
| 8–9 | Offline runtime and compatibility | `npx vitest run test/integration/cli/effective-harness-composition.test.ts test/integration/cli/effective-harness-runtime.test.ts test/integration/cli/evaluation.test.ts test/unit/application/run-workflow-capabilities.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/cli/public-output.test.ts` | Attached, detached, child, recovery, replay, inspection, export, legacy candidates, and private-canary paths use frozen state without live fallback. | Remote workers or opaque provider-session continuation |
| 10 | Documentation | `npm run docs:style`<br>`npm run docs:links`<br>`npm run docs:ste`<br>`npx vitest run test/integration/package/architecture-documentation.test.ts` | Canonical lifecycle, architecture, evaluation, recovery, testing, roadmap, and README routing are accurate and linked. | External standards certification |
| All | Static and runtime | `npm run format:check`<br>`npm run lint`<br>`npm run typecheck`<br>`npm run build`<br>`npm test -- --maxWorkers=1 --testTimeout=15000`<br>`npm run test:coverage -- --testTimeout=30000`<br>`npm run test:runtime`<br>`npm run pack:check` | Repository quality, complete serial suite, coverage, runtime probes, and packaged CLI checks pass. | Live paid-provider benchmark evidence |

## Verification evidence

_Final local snapshot: 2026-08-20._

- The criterion-map commands passed 303 tests across 21 files. The 19 non-socket files passed 245
  tests. The supervisor service and worker files passed 58 tests with temporary Unix-socket
  permission.

- `npm test -- --maxWorkers=1 --testTimeout=15000` passed 4,469 tests in 321 files. Four tests and
  one file were skipped by their declared platform or environment gates.

- `npm run test:coverage -- --testTimeout=30000` passed the same 4,469 tests. Coverage was 84.60%
  statements, 79.12% branches, 91.31% functions, and 84.73% lines.

- `npm run test:runtime` passed 43 tests in nine applicable files. It skipped 34 tests behind their
  declared host-runtime gates. `npm run test:browser` passed two tests in one file.

- `npm run format:check`, `npm run typecheck`, `npm run build`, `npm run docs:style`,
  `npm run docs:links`, `npm run docs:ste`, and `git diff --check` passed. `npm run lint` passed with
  one inherited informational `noUselessConstructor` notice in
  `src/application/external-harness-adapter.ts`.

- `node scripts/smoke-compiled.mjs` passed with temporary command-sandbox socket permission.
  `npm run pack:check` verified clean installation and CLI execution from
  `synaptiai-flow-harness-0.0.0.tgz` with SHA-256
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

- `node scripts/audit-prime-dependencies.mjs` passed for the Prime Node lock and 60 Python packages.
  `npm audit --omit=dev --audit-level=low` reported zero vulnerabilities.

- The local host does not reproduce CI's pinned Ubuntu x64 Docker, containerd, runc, and Prime peer
  configuration. GitHub CI remains the authoritative gate for that declared environment. No live
  paid-provider benchmark was run.

## Implementation sequence

1. RED/GREEN the bounded source, identity, one-axis union, digest, projection, and full mutation
   matrix.

2. RED/GREEN stable no-follow local admission, exact and plus-one bounds, cancellation, races, and
   privacy.

3. RED/GREEN the effective candidate union, state-only projection, generic dispatcher, storage, and
   content-free public views.

4. RED/GREEN exact paired evaluation identity, execution, reports, offline inspection, and export.

5. RED/GREEN activation, rollback, attached and detached execution, child recovery, replay,
   concurrency, cancellation, and privacy.

6. Update canonical public documentation, the architecture diagram, the repository map, roadmap
   status, testing guidance, and concise README routing.

7. Run focused, complete, coverage, runtime, documentation, and package gates. Review to zero
   P1/P2/P3 findings.

## Stranger test

A new contributor can implement the issue from this journal without inventing product semantics:

- The issue and specification identify the target, the two exclusive axes, and preserved authority.
  They also define durability, public privacy, and excluded packaged-child and dynamic-agent work.

- Every acceptance criterion has a runnable verification command and an explicit non-promise.

- The flow descriptions define review, evaluation, activation, runtime, recovery, cancellation, and
  settlement behavior.

- The coupling section identifies the owner of each responsibility. It keeps child runtime
  independent from candidate concepts.
