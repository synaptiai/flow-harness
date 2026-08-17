# Decision Journal: Issue #111 — Reviewable Agent Skill package candidates

**Issue**: #111 | **Branch**: `codex/issue-111-agent-skill-package-synthesis` | **Started**: 2026-08-17

---

## Context

Flow can generate bounded resource replacements for one existing Agent Skill. It can validate,
evaluate, activate, roll back, recover, and replay that change against the exact immutable baseline
package. Flow cannot create a new Agent Skill package for a workflow that selects no skill.

Issue #111 implements the next Gate 7 stage. An operator supplies a content-free package blueprint
that fixes every authority-bearing field and every relative output path. One zero-tool model turn may
propose only the inert UTF-8 contents for those declared files. Flow then produces one ordinary,
reviewable candidate directory and keeps evaluation and activation as separate authority gates.

## External evidence

- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)
  defines a required `SKILL.md` and optional `references/`, `assets/`, and `scripts/` resources.
  Issue #111 supports only bounded text files under the first three surfaces and excludes scripts.

- [Agent Skills client implementation guidance](https://agentskills.io/client-implementation/adding-skills-support)
  recommends progressive disclosure and treats project skills as potentially untrusted. Flow keeps
  generated contents inert until held-out evaluation and explicit reviewed activation.

- [Agent Skills authoring guidance](https://agentskills.io/skill-creation/best-practices) recommends
  grounding a skill in real project artifacts and refining it through execution evidence. Flow uses
  tuning-only evidence and preserves regression and holdout material for the evaluator.

- [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview) standardizes
  editor-agent sessions. It can transport a future package-authoring experience, but it does not
  define package authority, evaluation evidence, or durable activation.

- [A2UI](https://a2ui.org/) defines declarative presentation messages. It can inform a future
  content-bearing UI package, but it does not replace the Agent Skills package contract or Flow's
  candidate boundary.

## Roadmap choice

Gate 7 names Agent Skill package synthesis as the next missing surface after resource-delta
generation. Installation, signing, registry publication, executable resources, and multi-skill
candidates remain separate stages because each adds independent authority and recovery contracts.

## Architecture alternatives

The comparison weights authority safety 30%, reviewability 20%, standards fidelity 20%, durable
reuse 15%, implementation locality 10%, and future install compatibility 5%.

| Approach | Score / 5 | Sensitivity wins | Disposition |
| --- | ---: | ---: | --- |
| A2-D: bounded candidate directory | 4.00 | 59.7% | **Selected and user-approved** |
| Embedded package in one candidate JSON file | 3.70 | 34.7% | Rejected |
| Generated `.flowpkg` installation artifact | 3.40 | 5.6% | Rejected |

### A2-D. Bounded multi-file candidate directory — selected

The operator supplies one strict content-free blueprint. It declares the skill authority, one exact
root agent target, and between one and sixteen exact relative file paths. `SKILL.md` is mandatory.
Optional files may be below `references/` or textual `assets/`. The model returns content for every
declared path exactly once. Flow canonicalizes the package, projects the workflow selection, and
publishes this review directory without replacement:

```text
candidate-output/
├── CANDIDATE.json
└── skill/
    └── <operator-selected-name>/
        ├── SKILL.md
        ├── references/...
        └── assets/...
```

- **Strengths**: matches the Agent Skills package shape, is directly reviewable, gives future
  install and pack commands a real package tree, and keeps all path authority outside the model.
- **Costs**: needs directory-level stable admission, atomic publication, a new candidate identity,
  and a new activation variant that binds both workflow and package state.
- **Boundary**: generated files are inert UTF-8. They cannot add tools, policies, scripts, or
  executable authority. Runtime use remains limited to the workflow's already-admitted tools.

### A2-E. Embedded package bytes — rejected

Store every file inside `CANDIDATE.json` as an array of path and content.

- **Strengths**: reuses single-file candidate publication.
- **Failure**: weakens human review and package provenance, duplicates extraction logic, and makes a
  future installer consume a private candidate encoding instead of the standard package tree.

### A2-F. Generate an installable `.flowpkg` — rejected

Generate a signed or install-ready capability bundle immediately.

- **Strengths**: directly compatible with the remote capability store.
- **Failure**: conflates synthesis with publisher identity, signing, trust, installation, and
  registry recovery. Those are explicit later roadmap stages.

### A1. Generate only `SKILL.md` — rejected

Generate a single required file and defer all supporting resources.

- **Strengths**: smallest implementation.
- **Failure**: does not satisfy the approved standards-fidelity objective for bounded references
  and textual assets, and would create a second package-synthesis transition later.

## Specification

_Captured by specification-capture on 2026-08-17. Source: Issue #111 and user-approved A2-D._

### Non-goals

- Install, sign, publish, or remotely distribute a generated package.
- Generate scripts, binary files, executable files, model-selected paths, or more than one skill.
- Change a workflow that already selects Agent Skills or change more than one node.
- Let the model choose package authority, workflow structure, target, evidence, provider, model,
  limits, evaluation, activation, or rollback.
- Expose regression or holdout tasks, verifier evidence, credentials, run handles, absolute paths,
  unrelated package data, or live catalogs to generation.
- Add ACP, A2A, A2UI, remote UI, automatic updates, or a stronger sandbox backend.

### Failure modes

- **Invalid blueprint** — missing `SKILL.md`, forbidden directory, duplicate or ambiguous path,
  traversal, excessive entries, or excessive declared bytes fails before model execution.
- **Invalid model result** — malformed JSON, missing or duplicate file, unknown path, invalid UTF-8,
  excessive content, or authority-bearing output fails with a fixed value-free stage.
- **Source drift** — workflow, evidence, or blueprint identity changes before publication. Flow
  rejects the proposal instead of mixing source states.
- **Cancellation and timeout** — a controlling signal before commit stops the next phase, returns
  the exact reason, and leaves no final candidate.
- **Publication uncertainty** — a failure after atomic directory rename reports uncertain
  settlement. Flow never regenerates or replaces the directory automatically.
- **Evaluation mismatch** — baseline and candidate profiles differ outside the one skill selection
  and exact package snapshot. Admission rejects before trials start.
- **Activation mismatch** — stale workflow, package, evaluation, or activation identity rejects
  before durable mutation. A partial commit remains inspectable and recoverable.
- **Privacy failure** — public output never includes generated text, encoded text, private paths,
  provider responses, credentials, or nested private causes.

### Interface contracts

- The operator selects one baseline workflow, one root agent node, one or more tuning-evidence
  packets, one package blueprint, one output directory, one candidate identity, one provider/model,
  and bounded execution limits.
- The blueprint is strict, canonical, versioned, and content-free. It declares skill authority and
  every relative path. Paths use portable separators and are never model-selected.
- A package contains one through sixteen inert UTF-8 files. `SKILL.md` is required. Other files are
  under `references/` or textual `assets/`. `scripts/`, executable modes, links, special files,
  binary content, and undeclared paths reject.
- Generation uses one model turn, at most 8,192 output tokens and 65,536 response bytes. It has no
  tools, skills, packages, workspace reads, commands, effects, retries, evaluation, or activation.
- The model response supplies text for every declared path exactly once and no other fields.
- Projection changes one root agent's `skills` from `[]` to `[name]`. The target must already admit
  `read`. Every other workflow and runtime-authority field is byte-equivalent after canonical parse.
- The candidate directory contains `CANDIDATE.json` and the exact generated package tree. Its public
  identity binds baseline, evidence, blueprint, generation, package, workflow, capability, and
  candidate digests without content.
- Evaluation compares the original workflow with no package against the projected workflow and
  exact generated package under identical tasks, controls, verifiers, policy, and limits.
- Activation stores both baseline workflow/no-package and projected workflow/package states.
  Rollback restores the original workflow with no package. Existing persisted variants retain their
  encoding and digest.
- Public success output contains only portable identities, declared paths, hashes, limits, usage,
  and settlement status. Public errors are fixed and value-free.

## Domain and application contracts

### Package blueprint

`AgentSkillPackageBlueprint` binds:

- fixed API version and kind.
- skill name, description, optional public metadata, compatibility, license, and requested tools.
- one exact baseline workflow id and one exact root agent node id.
- one through sixteen unique portable files with exact path, purpose, and bounded generation
  guidance. The blueprint contains no proposed file content.
- canonical blueprint digest and exact source identity.

The operator, not the model, owns all these values. Flow renders the `SKILL.md` frontmatter from the
blueprint and treats the model result for that file as body content only.

### Generation request and response

The model-facing request contains portable baseline workflow and target identities, the content-free
blueprint, one through sixteen tuning-only evidence identities and summaries, and exact generation
limits. The response is a strict array of portable path and UTF-8 content entries. It must close the
declared path set exactly.

### Candidate projection

The baseline workflow selects no Agent Skills. The target is one root agent node that already has
the `read` tool. Projection changes only its `skills` list to the generated skill name. The projected
capability snapshot contains exactly the generated package. A new additive candidate kind binds both
changes and does not fabricate a baseline skill package.

### Stable source admission and publication

Admission observes every lexical ancestor and opens workflow, evidence, blueprint, candidate
manifest, and package files without following links. It enforces regular-file identities, exact
bounds, UTF-8, entry counts, portable paths, executable-mode rejection, and source revalidation.

Publication creates a private same-parent staging directory, writes and syncs every exact file,
reopens and validates the complete candidate, revalidates sources, syncs the staging directory, and
renames the complete directory without replacement. Parent-directory sync settles the commit. A
post-rename failure is uncertain and recoverable by exact inspection.

### Durable evaluation and activation

The evaluation plan adds one package-introduction source identity. Baseline admission uses the
original workflow and no generated capability package. Candidate admission uses the exact projected
workflow and generated package. The store recomputes all nested and cross-layer digests.

Activation adds one package-introduction snapshot variant. It stores exact baseline and candidate
workflow packages plus activation snapshots. The baseline activation may contain zero capability
packages; the candidate activation contains exactly the generated package. Apply, idempotency,
rollback, recovery, detached execution, child execution, export, and replay consult durable bytes
only.

## Coupling analysis

| Consumer | Required change | Constraint |
| --- | --- | --- |
| Generation domain | Blueprint, request, response, completion, provenance | No filesystem, executor, catalog, evaluation, or activation imports |
| Generation application | One zero-tool execution | Exact provider/model and one turn; no tool or capability evidence |
| Filesystem admission | Stable blueprint/workflow/evidence/package directory capture | No links, special files, live fallback, mixed identity, or unbounded enumeration |
| Publisher | Atomic no-replace directory publication | Preserve single-file prompt and resource-candidate behavior |
| Candidate union | Add package-introduction identity | Old prompt and resource candidate bytes and digests remain unchanged |
| Workflow projection | Select one new skill on one root agent | No graph, model, prompt, tool, policy, sandbox, budget, or approval change |
| Evaluation plan/store | Bind baseline no-package and candidate exact-package states | Recompute nested and cross-layer identities during reopen |
| Activation store | Add baseline/candidate workflow-package pair | Old encodings remain valid without migration |
| Runtime admission | Resolve exact generated package from durable activation | No candidate, blueprint, evidence, network, or live-catalog read |
| Public output | Redact generated content by structural path | Preserve legitimate metadata keys that resemble private field names |
| CLI | Add a third mutually exclusive generation mode | Existing prompt and resource-generation grammar remains stable |
| Documentation | Explain review artifact, authority, limits, recovery, and remaining stages | Do not claim install, signing, publication, executable generation, or superiority |

## TDD implementation sequence

1. RED/GREEN the strict content-free blueprint, exact path grammar, bounds, canonical frontmatter,
   request/response closure, generation provenance, and privacy.
2. RED/GREEN one-turn zero-tool execution, exact provider/model, timeout, cancellation, usage, and
   invalid-output precedence.
3. RED/GREEN no-follow multi-file candidate admission, source stability, exact entry/byte bounds,
   executable rejection, and atomic directory publication settlement.
4. RED/GREEN package-introduction candidate projection and generic candidate discrimination while
   preserving prompt and resource-candidate bytes.
5. RED/GREEN evaluation plan/store cross-binding for original no-package and projected exact-package
   profiles, including interrupted claim, recovery, inspect, and export.
6. RED/GREEN activation apply, idempotency, stale rejection, rollback to no package, recovery, and
   persisted backward compatibility.
7. RED/GREEN CLI grammar, public redaction, attached/detached/child execution, and offline replay.
8. Update public documentation and run the complete verification and adversarial review gates.

## Acceptance-criterion verification map

Every command is planned before implementation. Each row inherits the issue non-goals.

| Criteria | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Blueprint, exact files, bounds, inert content, authority | Contract and error | `npx vitest run test/unit/adaptation/agent-skill-package-candidate.test.ts test/unit/adaptation/agent-skill-package-candidate-generation.test.ts` | Exact-bound positives and +1, malformed path, script, binary, executable, duplicate, missing, unknown, and authority mutation rows pass | Signing, install, executable resources |
| One-turn zero-tool generation and data minimization | Behavioral | `npx vitest run test/unit/application/generate-agent-skill-package-candidate.test.ts` | Exact provider/model/limits, one call, zero tools/effects, request allowlist, timeout, cancellation, usage, privacy rows pass | Model quality or superiority |
| Stable source admission and atomic publication | Data and error | `npx vitest run test/unit/infrastructure/fs/local-agent-skill-package-candidate.test.ts test/unit/infrastructure/fs/local-agent-skill-package-candidate-publication.test.ts` | No-follow, source-race, entry/byte bounds, cancellation, no-replace, settled and uncertain publication rows pass | Distributed filesystem atomicity |
| Projection, identity, and old candidate compatibility | Behavioral and contract | `npx vitest run test/unit/adaptation/agent-skill-package-candidate.test.ts test/unit/infrastructure/fs/local-adaptation-candidate.test.ts` | Exact one-field workflow delta, package/capability/candidate redigest mutations, and unchanged old fixtures pass | Multi-skill or existing-skill edits |
| Durable paired evaluation | Behavioral and data | `npx vitest run test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/unit/infrastructure/fs/local-evaluation-store.test.ts` | Baseline no-package, candidate exact-package, nested identity mutations, claim/recovery/inspect/export rows pass | Evaluation result superiority |
| Activation and rollback | Behavioral and data | `npx vitest run test/unit/adaptation/agent-skill-package-activation.test.ts test/unit/adaptation/agent-skill-package-activation-admission.test.ts test/unit/infrastructure/fs/local-prompt-activation-store.test.ts` | Exact apply, idempotency, stale rejection, rollback, recovery, and old-encoding fixtures pass | Automatic activation or remote installation |
| CLI, runtime, offline replay, and privacy | Behavioral and error | `npx vitest run test/integration/cli/agent-skill-package-candidate-generation.test.ts test/integration/cli/agent-skill-package-candidate.test.ts test/integration/cli/agent-skill-package-activation.test.ts test/integration/cli/remote-capability-workflow.test.ts test/integration/supervisor/service.test.ts test/integration/supervisor/worker.test.ts test/unit/cli/public-output.test.ts` | Exact grammar, review directory, content-free outputs, attached/detached/child/recovery/replay, and no-live-source rows pass | Registry publication or remote UI |
| Documentation and dependency direction | Documentation and contract | `npm run docs:ste && npx vitest run test/integration/package/dependency-boundaries.test.ts && git diff --check` | Changed prose passes STE, dependency boundary passes, and diff has no whitespace errors | External standards certification |
| Full release gate | Configuration and runtime | `npm run format:check && npm run lint && npm run typecheck && npm test -- --maxWorkers=1 && npm run build && npm run test:runtime && npm run test:coverage && npm run pack:check && npm audit --omit=dev` | All commands pass; runtime CLI smoke test and package verification report success | Unsupported operating systems or unpublished registry artifacts |
| Live provider contract | Behavioral integration | `npm run test:live -- --run test/live/agent-skill-package-candidate-generation.live.test.ts` | Credential-gated live test performs one provider call and validates the bounded content-only result | Repeatability of model quality |

## Verification evidence

Evidence is recorded only after the frozen tree runs each mapped command. Every criterion entry will
include what was not tested, known evidence limitations, and the exact adversarial cases covered.

## Activity log

- 2026-08-17 — User approved Approach A2-D with the proposed defaults.
- 2026-08-17 — Created Issue #111 after a duplicate search and branched from exact `origin/main`.
- 2026-08-17 — Recorded the full specification, alternatives, coupling analysis, TDD sequence, and
  plan-time verification map before production implementation.
