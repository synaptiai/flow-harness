# Decision Journal: Issue #91 — Evidence-bound Agent Skill candidates

**Issue**: #91 | **Branch**: `codex/issue-91-agent-skill-candidates` | **Started**: 2026-08-15

---

## Context

Flow can discover, distribute, snapshot, execute, recover, and replay exact inert Agent Skill
packages. It can also describe, evaluate, activate, and roll back prompt-only adaptive candidates.
The remaining Gate 7 skill-candidate gap is now primarily an identity and evaluation-composition
problem: evaluation plan version 1 deliberately rejects Agent Skills because it has no immutable
capability input for either profile.

Issue #60 previously ranked adaptive refinement behind package distribution and reproducible
evaluation. Those prerequisites are complete. This slice must reuse them without turning an
evaluation result into package, workflow, or activation authority.

## External evidence

- [Continual Harness](https://arxiv.org/abs/2605.09998) reports adaptation across prompts,
  sub-agents, skills, and memory. Flow uses the adaptive-surface motivation but rejects its
  reset-free in-place mutation model for authoritative evaluation.
- [Agent Skills](https://agentskills.io/specification) defines progressively disclosed skill
  instructions and resources. Flow already imports the inert resource model and keeps package
  selection and requested tool authority outside candidate control.
- [The Update Framework](https://theupdateframework.github.io/specification/latest/) separates
  authenticated target identity from the application action applied to that target. Flow uses the
  same separation here: a candidate and favorable evaluation are evidence, not activation.
- [Gondolin](https://github.com/earendil-works/gondolin) is now compatible with Flow's Node runtime,
  but Linux x64 remains less tested than ARM64 and VM asset/runtime lifecycle is a separate
  privileged milestone. Skill-candidate evaluation executes no new package code and does not need
  to wait for that boundary.
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) now provides an emerging UI
  resource contract, but the extension is optional and its specification remains draft. Flow still
  lacks a presentation host, so UI contribution packages remain a separate architecture decision.

## Roadmap choice

The comparison weights prerequisite completion 25%, reuse of proven seams 20%, authority safety
20%, product differentiation 20%, and deterministic verification 15%.

| Next slice | Score / 5 | Strength | Primary weakness | Disposition |
| --- | ---: | --- | --- | --- |
| Evidence-bound Agent Skill candidates | 4.45 | Distribution, snapshots, evaluation, and prompt-candidate patterns already exist | Evaluation must gain exact capability inputs without breaking durable prompt history | **Selected** |
| Gondolin or another microVM backend | 3.80 | Unlocks hostile executable packages and contains the host kernel boundary | Privileged multi-platform runtime, image, cleanup, and Linux x64 acceptance surface | Next safety milestone before executable extensions |
| TUF repository and automatic updates | 3.15 | Completes secure update discovery and key lifecycle | Requires root, targets, snapshot, timestamp, repository, and operating contracts | Separate Gate 6 program |
| MCP Apps UI contribution packages | 2.95 | A real interoperable presentation standard now exists | Draft optional extension and no Flow MCP host or renderer | Revisit after a presentation-host decision |

The selected slice has the highest current leverage because the exact blockers recorded in Issue
#60 are now resolved. The decision does not weaken the sequencing constraint for executable
extensions: those still require a VM-grade or managed isolation profile.

## Architecture alternatives

### A. Add a sibling Agent Skill candidate kind with an immutable package projection — selected

A strict candidate binds one baseline workflow, one exact baseline Agent Skill package, tuning-only
evidence, and replacements for existing UTF-8 skill resources. Admission snapshots the baseline,
projects one replacement package, and supplies exact baseline/candidate capability snapshots to the
ordinary paired evaluation adapter.

- **Strengths**: reuses the existing skill snapshot, workflow runner, evaluation schedule, report,
  store, recovery, and export paths; introduces no executable or activation authority.
- **Costs**: evaluation identity gains a second candidate kind and profile-owned capability
  snapshot; the first slice supports one selected skill package only.
- **Compatibility**: prompt-candidate identity and legacy skill-free evaluation headers retain
  their current encoding.

### B. Replace PromptCandidate with a generic HarnessCandidate hierarchy now — rejected

A shared generic manifest could model prompts, skills, memory, sub-agents, and routing immediately.

- **Strengths**: one future-facing candidate vocabulary.
- **Failure**: forces a migration of mature durable prompt identities before a second surface proves
  which fields are genuinely common; encourages a lowest-common-denominator authority model.

### C. Evaluate a full replacement skill package or temporary installation — rejected

The candidate could contain a whole package and evaluation could install it into a temporary
catalog.

- **Strengths**: small projection function and supports arbitrary package changes.
- **Failure**: permits metadata, requested-tool, trust, file-set, and provenance changes; package
  mutation and collision recovery become part of evaluation; catalog state can substitute trial
  bytes.

### D. Let the candidate profile read a live alternate skill directory — rejected

The evaluation plan could point baseline and candidate profiles at two project directories.

- **Strengths**: simplest author workflow.
- **Failure**: live files can drift between paired trials and recovery; durable evidence would name
  paths rather than prove bytes; deletion could make historical inspection or replay unavailable.

## Specification

_Captured by specification-capture skill on 2026-08-15. Source: extracted-from-issue._

### Non-goals

- Activating, rolling back, generating, polling, downloading, installing, or publishing an Agent
  Skill candidate.
- Adding, removing, renaming, or reselecting skills, resources, packages, or workflow nodes.
- Changing requested tools, package metadata, package trust, prompts, graph, model routing, policy,
  approvals, budgets, verifiers, retry behavior, sandbox profile, network authority, or evaluator
  definitions.
- Memory, sub-agent, routing, tool, policy, UI, workflow, verifier, executable-extension, or
  arbitrary package candidates.
- Online refinement, traffic splitting, staged rollout, or mutation during an authoritative run.

### Failure modes

- **Timeouts and cancellation** — preserve the exact operator cancellation reason before and after
  each asynchronous admission or execution boundary, start no later phase, and publish no partial
  candidate authority.
- **Partial failures** — reject a drifting candidate, evidence file, baseline workflow, baseline
  skill, or capability snapshot before trial execution or durable publication. A durable trial
  start retains the normal evaluation crash and recovery rules.
- **Invalid input** — reject malformed, excessive, duplicated, unsafe, unrelated, stale, or
  identity-mismatched input with bounded value-free public diagnostics and no private cause.
- **Missing context** — reject a missing baseline, evidence packet, selected skill, resource,
  capability byte, or durable identity. Do not consult a live catalog, network source, credential,
  or alternate version as fallback.

### Interface contracts

- `AgentSkillCandidate` is a strict, bounded public source kind distinct from `PromptCandidate`.
- The source binds one workflow-scoped baseline, one exact baseline Agent Skill package, one through
  sixteen tuning-evidence packets, and one through sixteen unique existing UTF-8 resource
  replacements with expected current hashes.
- Admission returns a content-free public identity containing candidate, baseline workflow,
  baseline package, evidence, changed-resource, projected package, and projected capability
  digests. Absolute paths and resource contents remain private.
- The projection preserves the package name, description, license, compatibility, metadata,
  requested tools, trust, provenance, file paths, and file count. It changes only declared existing
  resource bytes and recomputes package/capability identity.
- A candidate comparison admits one ordinary baseline workflow and one Agent Skill candidate
  profile. Both compile to the exact same workflow identity. The baseline receives the admitted
  baseline skill snapshot; the candidate receives the projected skill snapshot.
- The existing workflow runner receives the profile capability snapshot. The scheduler, compiler,
  executor, verifier, policy, sandbox, evidence, and replay contracts remain candidate-neutral.
- Durable evaluation identity distinguishes skill candidates while retaining the exact legacy
  prompt-candidate and skill-free encodings.
- A candidate and favorable evaluation result grant no activation authority.

## Domain and application contracts

### Agent Skill candidate source

The strict YAML or JSON source contains:

- fixed API version and `AgentSkillCandidate` kind;
- canonical candidate id and exact semantic version;
- workflow-scoped baseline path, source SHA-256, and compiled workflow digest;
- one baseline skill-package directory path and expected package digest;
- one through sixteen tuning-evidence references with source, evidence, and plan digests; and
- one through sixteen unique existing resource paths with expected current SHA-256 and bounded,
  non-empty UTF-8 replacement text.

Unknown fields, duplicate paths or digests, path escape, symbolic links, special files, unstable
reads, oversized sources, malformed YAML or JSON, digest mismatch, missing matching baseline
evidence, unknown resources, binary resources, file-set change, manifest-authority change, and
invalid projected snapshots fail closed.

### Evaluation profile identity

An Agent Skill candidate profile retains `adapter: flow-workflow-v1`. Its workflow identity is the
unchanged baseline workflow. Its candidate identity and projected capability snapshot digest enter
the plan digest and durable public header. The comparison baseline receives the baseline capability
snapshot from the same admitted candidate boundary.

Prompt-candidate profiles keep their current source projection and current public encoding.
Skill-free direct workflow profiles keep their current identity and omit capability fields.

### Runtime evaluation boundary

Each admitted Flow profile may carry one private immutable capability snapshot. The adapter passes
that snapshot to the ordinary workflow runner. Trial execution does not read project skill roots,
installed package blobs, metadata candidates, registries, credentials, or network state.

## Coupling analysis

| Consumer | Required change | Constraint |
| --- | --- | --- |
| Candidate domain | Strict source, projection, and public identity | No catalog, filesystem, evaluation-store, or executor imports |
| Candidate filesystem admission | Stable baseline workflow, skill package, and tuning evidence reads | No symlink, special-file, source-race, or ambient-catalog fallback |
| Evaluation plan | Admit prompt or skill candidate and attach exact capability snapshots | Legacy direct and prompt profile encodings remain stable |
| Evaluation adapter | Pass a profile capability snapshot to the existing runner | No candidate-specific scheduler or executor |
| Evaluation store | Persist and replay skill-candidate plus capability identity | Exact redigestion and cross-binding before resume/export |
| CLI | Validate and inspect the new candidate; run the normal paired evaluation | Credential-free and read-only outside explicit evaluation mutation |
| Documentation | Explain trust, bounds, offline behavior, and non-activation | Do not claim generation, activation, or superiority |

## TDD implementation sequence

1. Red/green the strict Agent Skill candidate source, projection, public identity, and authority
   preservation matrix.
2. Red/green stable local admission for the candidate, baseline workflow, baseline skill directory,
   resources, and tuning evidence.
3. Red/green evaluation-plan admission for one baseline and one candidate capability snapshot while
   preserving legacy prompt and direct profiles.
4. Red/green adapter execution with exact profile snapshots plus live-catalog, network, credential,
   removal, and collision traps.
5. Red/green durable plan/header/store/recovery/export identity and tamper rejection.
6. Red/green CLI validation, inspection, and paired evaluation behavior.
7. Update public documentation, roadmap state, examples, and the criterion verification map.
8. Run focused, full, coverage, runtime, packaging, documentation, audit, and CI-parity gates.
9. Run independent specification, correctness, security, and holdout review; resolve every P1/P2/P3
   finding before publication.

## Acceptance-criterion verification map

| Criteria covered | Type | Planned verification | Expected evidence |
| --- | --- | --- | --- |
| Strict candidate and authority-preserving projection | Contract/security | Focused candidate-domain tests | Exact and boundary positives; every source, identity, authority, file-set, binary, duplicate, and digest mutation rejects |
| Stable local admission | Filesystem/security | Focused candidate-admission tests | Root, ancestor, symlink, special, source-race, exact-bound, cancellation, and private-canary matrix passes |
| Paired evaluation composition | Behavioral/config | Evaluation-plan and adapter tests | Candidate-only selection, identical workflow/controls, exact baseline/candidate snapshots, and no live fallback pass |
| Durable identity and recovery | Data/recovery | Evaluation-store, resume, inspect, and export tests | Stored inspection and export stay source-free; new admission redigests exact identities, and removal, substitution, or cross-binding mutations reject |
| Backward compatibility | Regression | Existing prompt-candidate and evaluation selectors | Legacy direct/prompt digests, headers, incomplete runs, and CLI behavior remain exact |
| Public CLI and privacy | Integration/error | Candidate and evaluation CLI tests | Validate/inspect are read-only and credential-free; paired run works; output omits contents, paths, and causes |
| Documentation and release quality | Docs/release | Docs, dependency, full test, coverage, runtime, package, audit, and CI-parity gates | All configured gates pass with limitations and platform evidence recorded |

## Verification evidence

- The mapped Agent Skill, prompt-candidate, evaluation-plan, adapter, durable-store, and CLI
  selector passed 106 tests across 12 files.
- The complete default suite passed 3,398 tests and skipped 4 tests across 243 files. The skipped
  tests require platform capabilities that the local host does not provide.
- The serial coverage suite passed the same 3,398 tests and skipped 4 tests. It reported 83.23%
  statement coverage, 77.32% branch coverage, 89.76% function coverage, and 83.35% line coverage.
- The runtime suite passed 39 tests and skipped 33 tests across 17 files. Its skips are guarded
  native or hosted-runtime scenarios.
- Formatting, lint, type checking, compilation, documentation prose, and diff-integrity checks
  passed. Lint reported one inherited informational constructor finding outside this change.
- The packed artifact installed and executed successfully. The Prime dependency audit passed for
  the Node lock and 60 Python packages. The production dependency audit reported zero
  vulnerabilities.
- The configured local CI driver passed formatting, lint, type checking, and compilation, then
  stopped at its explicit platform guard: `Prime OCI runtime preparation requires Linux on x64`.
  The hosted Ubuntu x64 workflow remains the authoritative environment for that native gate.
