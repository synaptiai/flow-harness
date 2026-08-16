# Decision Journal: Issue #93 — Agent Skill activation and rollback

**Issue**: #93 | **Branch**: `codex/issue-93-agent-skill-activation` | **Started**: 2026-08-15

---

## Context

Flow can admit one evidence-bound Agent Skill resource candidate, project one exact replacement
package, and compare that package with its exact baseline. The paired evaluation is durable and
offline. It proves the workflow, candidate, package, capability, schedule, trials, and report.

That evidence does not yet let an operator select the evaluated package for later workflow runs.
Prompt candidates already have a reviewable activation lane. They support preview, exact apply,
immutable history, future-run selection, durable execution, and rollback. Issue #93 extends that
operator boundary to Agent Skill candidates without turning evaluation into package installation,
publication, generation, or automatic authority.

## External evidence

- The [Agent Skills specification](https://agentskills.io/specification) treats `SKILL.md` and the
  files in the skill directory as one progressively disclosed package. An activated selection must
  therefore retain the complete admitted package instead of retaining only changed files.

- The [OCI image descriptor specification](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)
  binds content with both a digest and a byte size. Flow uses the same content-addressed rule for
  immutable activation blobs and rechecks the bytes before use.

- [The Update Framework specification](https://theupdateframework.github.io/specification/latest/)
  separates authenticated target identity from the application action taken on that target. Flow
  keeps the same separation: a favorable evaluation can support an operator proposal, but it does
  not activate itself.

- Kubernetes documents rollback as selection of a retained deployment revision. It does not
  rewrite an already running revision. The
  [`kubectl rollout undo` contract](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_undo/)
  supports Flow's future-run-only rollback rule and its review-before-apply pattern.

## Roadmap choice

The comparison weights prerequisite completion 25%, reuse of proven seams 20%, authority safety
20%, product value 20%, and deterministic verification 15%.

| Next slice | Score / 5 | Strength | Primary weakness | Disposition |
| --- | ---: | --- | --- | --- |
| Agent Skill activation and rollback | 4.60 | Candidate, evaluation, prompt activation, and durable capability snapshots already exist | A shared store must preserve every legacy prompt byte and digest | **Selected** |
| Agent Skill candidate generation | 3.70 | Completes the authoring loop | Generation needs a separate provider, schema, privacy, and authority boundary | Follow-up after explicit activation |
| VM-grade executable extensions | 3.65 | Unlocks hostile executable contribution types | Privileged runtime and multi-platform cleanup remain a larger safety program | Separate safety milestone |
| TUF repository and automatic updates | 3.20 | Completes remote update discovery and key rotation | Repository roles and operating procedures are not part of candidate activation | Separate Gate 6 program |

The selected slice closes the next explicit Gate 7 gap. It reuses the exact evidence created by
Issue #91 and the operator-controlled mutation boundary created for prompt activation.

## Architecture alternatives

### A. Extend the existing activation lane with a compatible variant — selected

One workflow has one active adaptive revision. A revision is either the existing prompt snapshot or
a new Agent Skill snapshot. The existing prompt encoding remains unchanged. New skill revisions
carry an explicit kind and retain the complete selected package plus the unchanged workflow.

- **Strengths**: one head, one history, one locator, and one mutation lock define future-run
  authority. Prompt and skill selections cannot form two competing heads. Durable execution uses
  the existing capability snapshot contract.

- **Costs**: the prompt-specific store and domain names become historically narrow. The internal
  model must support a union without changing legacy serialized bytes.

- **Compatibility constraint**: old prompt blobs and version 1 indexes must parse and hash exactly
  as before. The prompt-only artifact key and index order must not change.

### B. Add an independent Agent Skill activation store — rejected

A second store could own skill heads and leave prompt code untouched.

- **Strengths**: the first skill implementation would have few edits in the prompt store.
- **Failure**: two stores can select different active revisions for the same workflow. Admission
  would need a new priority rule. The design would duplicate durable publication, settlement,
  recovery, history, rollback, and storage limits.

### C. Install the projected skill package — rejected

Activation could write the projected package into the installed package catalog.

- **Strengths**: ordinary package selection could load it later.
- **Failure**: an evaluation result would gain installation and package trust authority. Collision,
  signature, metadata, revocation, and package lifecycle concerns would enter activation.

### D. Store a live overlay pointer — rejected

Activation could retain the candidate path and apply replacements when a run starts.

- **Strengths**: small stored artifacts.
- **Failure**: live files can drift or disappear. Recovery and replay could receive different bytes.
  Historical inspection could name content that no longer exists.

## Selected architecture

The user approved Approach A on 2026-08-15.

The store remains at `.flow/activations`. The public locator remains
`activation:<workflow-id>`. One workflow head selects one immutable activation digest. Applying a
prompt or Agent Skill revision appends one transition to the same history. Rollback appends another
transition and never deletes a blob.

The compatibility design uses a tagged union at the domain boundary. Existing prompt snapshots
keep their exact version 1 shape, digest projection, capability digest, blob bytes, and index entry.
The Agent Skill snapshot uses a separate explicit kind and its own digest projection. Index parsing
accepts both artifact forms. Legacy index serialization remains unchanged when it contains only
prompt artifacts.

An Agent Skill activation contains the unchanged evaluated workflow source and the exact selected
Agent Skill package snapshot. It also contains the admitted candidate identity and evaluation proof.
Its capability snapshot contains that package and the activation proof. Workflow binding checks the
workflow digest, selected package digest, and skill capability digest. It also checks the activation
digest. It checks the overall capability snapshot digest before execution.

## Specification

_Captured by specification-capture skill on 2026-08-15. Source: mixed. The issue supplies the
outcome and failure contract. The user confirmed Approach A and the defaults below._

### Non-goals

- Generating, downloading, installing, publishing, polling, or automatically selecting an Agent
  Skill candidate.

- Adding, removing, renaming, or reselecting skills, resources, packages, workflow nodes, tools,
  models, policies, approvals, budgets, verifiers, retries, or sandbox settings.

- Independent prompt and Agent Skill heads for one workflow. Traffic splitting and staged rollout
  are also out of scope.

- Multi-skill candidates, arbitrary package replacement, executable extensions, memory candidates,
  sub-agent candidates, routing candidates, and UI candidates.

- Reading live candidate files, project skill directories, installed package stores, or metadata
  candidates after admission. Reading registries, credentials, or network state is also out of
  scope.

- Changing an existing run, detached job, child run, recovery, replay, inspection record, or export
  after a later change. An activation or rollback does not change that durable state.

### Failure modes

- **Timeouts and cancellation** — preserve the exact operator cancellation reason throughout
  configuration, candidate admission, evaluation admission, and proposal creation. Start no later
  phase. Once apply enters the existing mutation owner, its settled or uncertain publication result
  wins over a late signal. Do not report clean cancellation after a possible durable commit.

- **Partial failures** — publish immutable blobs before the new index. Remove only blobs that the
  failed attempt created and that are proven unreferenced. Preserve a settled index if publication
  reached the commit boundary. Reconcile temporary state with the existing bounded recovery rules.

- **Invalid input** — reject incomplete, non-superior, unsafe, excessive, stale, corrupt,
  mismatched, or authority-changing input before mutation. Public errors are bounded and
  value-free. They do not retain private content as a cause.

- **Missing context** — reject a missing candidate, evaluation, workflow, package, activation blob,
  durable capability snapshot, or rollback target. Do not use a live catalog, alternate package,
  network source, credential, or latest-version fallback.

- **Resource exhaustion** — retain the existing bounded index, history, artifact-count, aggregate
  storage, JSON depth, JSON node, and per-blob limits. The new snapshot must fit the existing
  16 MiB blob bound. Agent Skill package limits remain stricter than that outer bound.

### Interface contracts

- `AdaptiveActivationSnapshot` is a strict union of the unchanged `PromptActivationSnapshot` and a
  new `AgentSkillActivationSnapshot`.

- `PromptActivationSnapshot` version 1 keeps its exact serialized form and digest calculation.
  Legacy prompt activation fixtures become fixed golden compatibility evidence.

- `AgentSkillActivationSnapshot` binds one selection, one workflow id, and one candidate identity.
  It also binds one complete evaluation proof and one unchanged workflow source identity. It binds
  one complete selected Agent Skill package snapshot and one activation digest.

- The Agent Skill selection is `baseline` or `candidate`. Baseline selects the exact evaluated
  baseline package. Candidate selects the exact evaluated projected package. Both compile the same
  evaluated workflow bytes.

- The public locator remains `activation:<workflow-id>`. It resolves through the one active head.
  It never encodes a mutable package path or version range.

- The store owns one head and one append-only transition history per workflow. Applying either
  activation kind replaces the future selection for that workflow. It does not mutate prior blobs.

- A rollback target identifies either no activation, a stored prompt revision, or a stored Agent
  Skill revision. New skill target syntax must not change the existing prompt rollback syntax.

- `CapabilitySnapshot` contains the exact selected Agent Skill package and the exact adaptive
  activation proof. Its digest binds both. Prompt activation capability snapshots remain exact.

- A run copies the resolved capability snapshot into its durable admission state. Attached,
  detached, child, recovery, replay, inspection, and export consumers use only that copy.

- The store accepts no network client, credential provider, registry, installed package store, or
  metadata candidate store dependency.

## User, system, and administrator flows

### Operator preview and apply

1. The operator names one admitted Agent Skill candidate and one complete stored evaluation.
2. Flow reopens and validates the live candidate, unchanged workflow, baseline skill, and stored
   evaluation against their exact identities.
3. Flow proves the paired comparison is complete and superior and that all safety constraints pass.
4. Flow creates baseline and candidate activation snapshots and reads the current workflow head.

5. Preview returns a content-free proposal. It performs no durable mutation.
6. Apply takes the exact proposal digest and rechecks the state under the mutation lock.
7. Apply publishes missing immutable blobs and commits one index transition.

### New run admission

1. A workflow source uses `activation:<workflow-id>`.
2. Flow loads the one selected immutable activation blob by digest.
3. For prompt activation, Flow compiles the selected workflow source as it does today.
4. For Agent Skill activation, Flow compiles the unchanged stored workflow.
5. Flow binds the selected skill package through the ordinary capability snapshot.
6. Flow copies the complete snapshot into durable run admission before execution.

### Durable execution and recovery

1. Attached, detached, and child execution receive the already admitted workflow and capability
   snapshot.
2. Recovery and replay reconstruct the same snapshot from durable run records.
3. No consumer reads the mutable activation head after admission.
4. No consumer reads candidate, skill, package, metadata, registry, credential, or network state.

### Rollback

1. The operator selects the baseline, a stored prompt revision, or a stored Agent Skill revision.
2. Preview proves the target exists and returns a content-free proposal for the current head.
3. Apply rechecks the exact proposal under the mutation lock and appends one history transition.
4. Existing runs remain unchanged. New runs resolve the selected target.

### Administrator recovery

1. Normal retry reconciles only bounded temporary files under the activation store.
2. A commit-uncertain error tells the administrator that durable state must be inspected.
3. The administrator uses list and inspect output to determine the selected digest and history.
4. Immutable activation blobs remain available for inspection and explicit future rollback.

## Coupling analysis

| Consumer | Required change | Constraint |
| --- | --- | --- |
| Activation domain | Add a skill snapshot and union parser | Prompt shape and digest remain byte-for-byte exact |
| Evaluation admission | Create baseline and candidate skill snapshots from stored evidence | No evaluation result can apply itself |
| Activation store | Parse, publish, list, select, and roll back the union | One head, lock, history, storage budget, and recovery path |
| Capability binding | Bind selected skill package and activation proof | No live package discovery or substituted package |
| Workflow admission | Resolve either activation kind | Public locator remains unchanged |
| Run state | Persist the exact selected capability snapshot | Later head changes cannot affect the run |
| Supervisor and worker | Carry the existing durable snapshot | No activation-store read in worker execution |
| CLI | Add skill preview/apply/inspect/rollback forms | Legacy prompt syntax and output remain compatible |
| Documentation | Explain trust, bounds, immutable runs, rollback, and recovery | Do not claim generation, installation, or automation |

## TDD implementation sequence

1. RED/GREEN hard-coded prompt activation and capability digest goldens. Prove parsing, index
   serialization, locator behavior, and rollback target behavior remain exact.

2. RED/GREEN the strict Agent Skill activation snapshot. Cover baseline and candidate selections,
   exact package and workflow binding, canonical bytes, bounds, privacy, and every identity mutation.

3. RED/GREEN admission from the complete Agent Skill evaluation. Cover completeness, superiority,
   constraints, profile identity, package identity, workflow identity, stale live input, and
   cancellation.

4. RED/GREEN the union store. Cover mixed history, one-head behavior, apply idempotency, and stale
   proposals. Cover rollback across kinds, settlement, recovery, collision, bounds, and old prompt
   index fixtures.

5. RED/GREEN workflow and capability admission. Cover selected package binding, durable snapshot
   capture, no live fallback, package substitution, activation substitution, and prompt regression.

6. RED/GREEN CLI preview, apply, list, inspect, and rollback. Cover content-free output, exact
   grammar, duplicate flags, cancellation, uncertain commits, and unchanged prompt commands.

7. RED/GREEN attached, detached, child, recovery, replay, inspection, and export behavior with live
   source, catalog, registry, credential, and network traps.

8. Update the roadmap, README, sourcing and recovery documentation, examples, and the final
   criterion evidence map.

9. Run focused, full, coverage, runtime, package, audit, documentation, and CI-parity gates. Run an
   independent correctness, security, specification, and holdout review. Resolve every P1, P2, and
   P3 finding before publication.

## Acceptance-criterion verification map

| Criteria covered | Type | Verification | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Preview from complete superior evidence | Behavioral/error | `npx vitest run test/unit/adaptation/agent-skill-activation-admission.test.ts test/unit/adaptation/agent-skill-activation.test.ts` | Complete superior baseline/candidate snapshots pass. Incomplete, non-superior, unsafe, mismatched, excessive, and private-canary rows reject. | Generation, automatic selection, and arbitrary package changes |
| Exact apply, stale rejection, and idempotency | Data/recovery | `npx vitest run test/unit/infrastructure/fs/local-prompt-activation-store.test.ts` | Mixed-kind apply, retry, stale state, blob collision, publication settlement, bounds, and recovery rows pass. | Distributed writers or remote storage |
| New-run selected workflow and package | Behavioral/contract | `npx vitest run test/unit/application/workflow-package-admission.test.ts test/integration/cli/agent-skill-activation.test.ts` | The exact unchanged workflow and selected package execute. Package, activation, and capability substitutions reject. | Multi-skill selection or installed-package mutation |
| Durable attached, detached, child, recovery, replay, and inspect | Behavioral/recovery | `npx vitest run test/unit/application/run-workflow-capabilities.test.ts test/integration/cli/agent-skill-activation.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts` | Attached execution, resumed durable runs, child ledgers, supervisor admission, and detached workers use the exact admitted package after live activation and skill sources are absent. | Cross-host supervisor migration |
| Exact rollback and append-only history | Behavioral/data | `npx vitest run test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/integration/cli/agent-skill-activation.test.ts` | Baseline, prompt, and skill targets select only future runs. History remains chained and blobs remain present. | Automatic health-based rollback |
| Fail-closed bounds, cancellation, privacy, and uncertain commits | Security/error | The domain, admission, store, CLI, supervisor, and worker commands above | Exact and plus-one bounds, signal precedence, private canaries, cause walks, commit settlement, and tamper matrices pass. | Unbounded third-party storage or network services |
| Exact prompt compatibility | Regression/contract | `npx vitest run test/unit/adaptation/prompt-activation.test.ts test/unit/adaptation/prompt-activation-admission.test.ts test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/integration/cli/prompt-activation.test.ts` | Hard-coded legacy digests, old index bytes, locator grammar, CLI output, run state, recovery, replay, and rollback remain exact. | Migration of deprecated private APIs |
| Documentation and release quality | Docs/release | `npm run docs:ste`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test -- --maxWorkers=1`, `npm run test:coverage`, `npm run test:runtime`, `npm run pack:check`, and `npm run ci:local` | Every configured gate passes. Platform skips and hosted-only evidence are recorded precisely. | A non-Linux host proving Linux-only Prime acceptance |

## Current implementation evidence

- The mapped Agent Skill and prompt compatibility selector passed 213 tests across 15 files. The
  supervisor service and worker files ran with real local sockets. The exact command was:

  ```text
  npx vitest run test/unit/cli/public-output.test.ts test/unit/adaptation/agent-skill-activation-admission.test.ts test/unit/adaptation/agent-skill-activation.test.ts test/unit/infrastructure/fs/local-prompt-activation-store.test.ts test/unit/application/workflow-package-admission.test.ts test/integration/cli/agent-skill-activation.test.ts test/unit/application/run-workflow-capabilities.test.ts test/integration/cli/agent-skill-candidate.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/adaptation/prompt-activation.test.ts test/unit/adaptation/prompt-activation-admission.test.ts test/integration/cli/prompt-activation.test.ts test/unit/adaptation/agent-skill-candidate.test.ts test/integration/cli/prompt-candidate.test.ts
  ```

- The dependency boundary selector passed 13 tests across two files. The exact command was:

  ```text
  npx vitest run test/integration/package/dependency-boundaries.test.ts test/unit/infrastructure/fs/local-adaptation-candidate.test.ts
  ```

- `npm run docs:ste` and `git diff --check` pass on the changed tree.

- The complete serial suite passed 3,496 tests with four configured skips across 247 files. Coverage
  passed with 83.49% statements, 77.68% branches, 89.99% functions, and 83.61% lines.

- Runtime verification passed 39 tests with 33 platform or configuration skips across 17 files.
  The compiled smoke test and clean package installation passed. The production dependency audit
  reported zero vulnerabilities. The Prime audit passed for the Node lock and 60 Python packages.

- `npm run ci:local` passed formatting, lint, type checking, and build before it reached the expected
  host guard: Prime OCI preparation requires Linux on x64. This macOS arm64 host uses Docker Desktop
  with a Linux arm64 Docker 29.7.2 daemon. Hosted CI uses Linux x64, Docker 28.3.3, and the attested
  `flow-prime-runc`; it remains the authority for that boundary.

- Adversarial correctness, security, specification, and holdout review completed with zero current
  P1, P2, or P3 findings.
