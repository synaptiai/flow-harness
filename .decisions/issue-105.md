# Decision Journal: Issue #105 — Evidence-bound Agent Skill candidate generation

**Issue**: #105 | **Branch**: `codex/issue-105-agent-skill-generation` | **Started**: 2026-08-16

---

## Context

Flow can generate prompt candidates from tuning-only evidence. It can also validate, compare,
activate, roll back, recover, and replay handwritten Agent Skill candidates that replace existing
UTF-8 resources without changing package authority. Operators still have to author every Agent
Skill candidate by hand.

The next Gate 7 slice closes that gap. Generation must reuse the existing Agent Skill candidate
boundary without giving a model control over package selection, file selection, evidence,
execution, evaluation, or activation.

## External evidence

- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx)
  defines `SKILL.md` plus optional resources and scripts as a portable package. Flow keeps the
  package selection and every authority-bearing field outside model control.

- [Agent Skills client implementation guidance](https://agentskills.io/client-implementation/adding-skills-support)
  describes progressive disclosure. Generation therefore receives only explicitly selected
  resources, not the complete live catalog or unrelated package content.

- [A2UI](https://a2ui.org/) provides a declarative presentation protocol. Its current production
  line is v0.9.1 and v1.0 is a candidate. It is relevant to future generated presentation
  resources, but it does not define candidate authority or model-generation evidence.

- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview) standardizes
  editor-agent sessions, prompts, tools, files, and terminals. It is useful for a future client
  adapter, but it does not replace Flow's durable candidate, evaluation, or activation contracts.

- [The Update Framework](https://theupdateframework.github.io/specification/latest/) defines a
  larger root, timestamp, snapshot, and targets update system. Automatic package updates remain a
  separate Gate 6 program.

## Roadmap choice

The comparison weights roadmap fit 25%, reuse 20%, authority safety 20%, portability 15%, standards
alignment 10%, and operator value 10%.

| Next slice | Score / 5 | Strength | Primary weakness | Disposition |
| --- | ---: | --- | --- | --- |
| Agent Skill candidate generation | 4.800 | Existing candidate, evaluation, activation, and prompt-generation seams are complete | Needs a new bounded model contract and stable multi-source admission | **Selected** |
| Automatic signed package updates | 4.175 | Completes freshness and repository lifecycle | Requires the complete TUF client/repository surface | Later Gate 6 program |
| MicroVM isolation | 3.975 | Enables hostile executable extensions | Privileged Linux/KVM host and image lifecycle | Required before executable extensions |
| Content-bearing A2UI packages | 3.900 | Standards-based generated presentation | Renderer authority and executable extension policy remain unresolved | Revisit after generated inert resources |
| ACP adapter | 3.400 | Standards-based editor integration | Does not close a current harness-authority gap | Later client integration |

A deterministic sensitivity check sampled 100,000 randomized criterion-weight sets. Agent Skill
generation won 94,143 samples. Automatic updates won 3,443, and MicroVM isolation won 2,414.
A2UI and ACP did not win a sample. Agent Skill generation is therefore the stable next slice.
The result does not depend on only one chosen weighting.

## Architecture alternatives

### A. Bounded resource-delta generation — selected

Add a sibling Agent Skill generation contract. The operator selects one exact workflow, one exact
skill, one or more exact tuning-evidence packets, and one or more existing inert UTF-8 resource
paths. `SKILL.md` and the top-level `scripts/` directory are excluded. One zero-tool model turn
returns replacements only for those paths. Flow completes an ordinary `AgentSkillCandidate`,
projects it through the existing authority-preserving candidate code, and publishes it atomically
without replacement.

- **Strengths**: reuses stable source admission, package snapshots, evaluation, activation,
  rollback, recovery, and offline replay. Model authority is limited to replacement bytes.
- **Costs**: needs a distinct strict request/response schema, generation provenance, and a stable
  multi-source admission boundary.
- **Compatibility**: prompt generation retains its current grammar and identity. Existing
  handwritten Agent Skill candidates remain valid.

### B. Full package synthesis — rejected

Let the model return a complete skill package.

- **Strengths**: supports new files, scripts, and metadata in one operation.
- **Failure**: gives the model file-selection, metadata, requested-tool, trust, and executable
  authority. It bypasses the purpose of the existing Agent Skill candidate projection.

### C. Deterministic templates or rules — rejected

Generate replacements through fixed transformations without a model.

- **Strengths**: simple, cheap, and deterministic.
- **Failure**: cannot use tuning evidence to propose substantive adaptive improvements and does not
  close the roadmap's model-assisted generation gap.

### D. Proposer plus model reviewer — rejected

Use one model to propose changes and a second turn or model to approve them.

- **Strengths**: can filter weak proposals before publication.
- **Failure**: adds model calls, cost, nondeterminism, and a misleading approval boundary. Flow's
  existing paired evaluation and reviewed activation are the authoritative review stages.

## Specification

_Captured by specification-capture skill on 2026-08-16. Source: extracted-from-issue and approved
Approach A._

### Non-goals

- Creating a new Agent Skill package, adding or deleting files, generating executable scripts, or
  changing package authority fields.
- Generating, evaluating, activating, installing, publishing, or merging more than one skill or
  candidate in one request.
- Letting a model choose the workflow, skill, resource paths, evidence, provider, model, limits,
  evaluator, or activation decision.
- Exposing regression or holdout material, verifier evidence, live run handles, credentials,
  private paths, or unrelated package contents to generation.
- Adding ACP, A2UI, remote UI, automatic package updates, executable package extensions, or a
  stronger sandbox backend.

### Failure modes

- **Cancellation and timeout** — cancellation or timeout before publication returns the exact
  controlling reason and leaves no final candidate. No later phase starts.

- **Invalid model result** — malformed, excessive, empty, unselected, duplicated, unchanged, or
  identity-mismatched output returns a fixed bounded public stage. The error has no private content
  or nested private cause.

- **Source drift** — a selected workflow, evidence packet, package directory, or resource can
  change before publication. Flow rejects drift instead of mixing snapshots.

- **Publication uncertainty** — a failure after an atomic candidate commit reports explicit
  uncertain publication and never retries generation automatically.

- **Missing context** — the command requires the project, workflow, skill, evidence, model, output,
  resource, and limit context. It fails before model execution when any context is absent.

### Interface contracts

- The operator selects one baseline workflow, one or more tuning-evidence packets, and one exact
  skill. The operator also selects resource paths, an output path, a candidate identity, a
  provider/model setting, and execution limits.

- The model-facing request is canonical, bounded, versioned, and contains only admitted generation
  inputs. It contains portable identities and selected resource bytes, never absolute paths,
  credentials, holdout material, verifier data, or unrelated package content.

- The response is one strict bounded resource-replacement object. It may address only the explicit
  allowlist and must change at least one resource.

- Generation executes one model turn with no tools, skills, packages, workspace reads, policy
  decisions, effects, retries, evaluation, or activation.

- The generated file is an ordinary `AgentSkillCandidate`. Existing validation, evaluation,
  activation, rollback, detached execution, recovery, and offline replay commands accept it.

- Public success output contains only portable identities, selected resource paths, hashes, limits,
  usage, and generation status. Public errors remain value-free.

## Domain and application contracts

### Generation request and response

The prepared generation input also binds the operator-selected candidate id and exact semantic
version. Those values stay outside the model-facing request and enter the completed candidate
identity. The model-facing request contains:

- fixed API version and operation kind.
- baseline workflow id, source digest, and compiled workflow digest.
- selected Agent Skill name, package digest, and preserved public package authority.
- one through sixteen tuning-evidence identities and tuning-only summaries.
- one through sixteen unique selected existing inert UTF-8 resources with portable path, current
  digest, and bounded content. `SKILL.md` and top-level `scripts/` files are excluded.

- exact provider, model, thinking level, timeout, output-token limit, and response-byte limit.

The response contains only a strict `changes` array of portable resource path and non-empty UTF-8
replacement text. Unknown fields, duplicates, unselected paths, unchanged output, an empty change
list, excessive bytes, and malformed JSON reject.

### Generation provenance

The completed candidate records a content-free generation identity containing provider, model,
thinking, limits, usage, canonical request digest, response digest, and selected target identities.
The existing Agent Skill candidate identity continues to bind baseline workflow, baseline package,
evidence, changes, projected package, projected capability, and candidate digests.

### Stable local admission

Generation admission opens and snapshots the exact workflow, evidence packets, selected skill
package, and selected resources. It rejects symbolic links, special files, path escape, duplicate
selection, binary resources, `SKILL.md`, top-level scripts, unselected resources, source races,
excessive entries, and all live catalog fallback. It returns one revalidation closure that checks
the complete observed source chain before projection and immediately before publication.

### Publication

Publication keeps the existing no-replace, lock, temporary-file, rename, cancellation, settlement,
and recovery contract. The publisher validates either strict prompt-candidate text or strict Agent
Skill-candidate text without weakening either schema.

## Coupling analysis

| Consumer | Required change | Constraint |
| --- | --- | --- |
| Generation domain | New strict Agent Skill request, response, completion, and provenance | No filesystem, executor, catalog, evaluation, or activation imports |
| Generation application | One zero-tool execution and evidence validation | Preserve exact provider/model, one turn, no tool/capability/policy/effect evidence |
| Filesystem admission | Stable workflow/evidence/package/resource snapshot and revalidation | No live-catalog fallback, symlink traversal, or mixed source identity |
| Publisher | Admit the sibling candidate kind | Preserve no-replace and settlement semantics; do not weaken prompt validation |
| CLI | Select generation mode with explicit skill and resources | Prompt grammar remains backward compatible; modes are mutually exclusive |
| Existing candidate consumers | No semantic change | Generated output is an ordinary Agent Skill candidate |
| Documentation | Explain command, authority, limits, privacy, and recovery | Do not claim package creation, install, publication, automatic evaluation, or superiority |

## TDD implementation sequence

1. Red/green the strict Agent Skill generation request, canonical rendering, response, provenance,
   exact bounds, selected-resource closure, and privacy.
2. Red/green zero-tool execution evidence, exact provider/model, one-turn usage, timeout,
   cancellation, and invalid-output behavior.
3. Red/green stable local workflow/evidence/skill/resource admission, no-follow traversal, source
   races, cancellation, exact bounds, and live-catalog traps.
4. Red/green sibling-candidate publication while preserving all prompt publication behavior.
5. Red/green CLI grammar, success projection, public output, no side effects, and source
   revalidation around publication.
6. Run generated output through existing validation, paired evaluation, activation, rollback,
   detached, recovery, and offline replay selectors.

7. Update README, architecture, capability sourcing, evaluation, testing, workflow specification,
   roadmap, and public examples.
8. Run focused, full, coverage, runtime, live-provider, offline, package, documentation, dependency,
   audit, and CI-parity gates.
9. Run adversarial specification, correctness, security, and holdout review. Resolve every P1/P2/P3
   finding before publication.

## Acceptance-criterion verification map

| Criteria covered | Type | Planned verification | Expected evidence |
| --- | --- | --- | --- |
| Strict request, response, and authority-preserving completion | Contract/security | New generation-domain tests plus existing candidate-domain tests | Exact/boundary positives pass; schema, target, authority, digest, byte, duplicate, and unchanged mutations reject |
| Zero-tool one-turn execution | Behavioral/security | New generation-application tests | Exact provider/model and one turn pass; tool, capability, policy, effect, retry, usage, and private-error mutations reject |
| Stable local admission | Filesystem/security | New local generation-source tests | Ancestor, symlink, special, race, cancellation, exact-bound, unrelated-source, and live-catalog traps pass |
| Atomic publication | Data/recovery | Existing publisher suite plus sibling-kind cases | No replace, lock, cancellation, settled failure, uncertain commit, and concurrent generation pass |
| CLI behavior and privacy | Integration/error | New Agent Skill generation CLI tests | Exact grammar and success pass; output omits resource bytes, absolute paths, credentials, private causes, and unrelated data |
| Existing candidate lifecycle | Regression/offline | Agent Skill validate/eval/activate/rollback/worker/recovery/replay selectors | Generated and equivalent handwritten candidates cross identical boundaries without source consultation |
| No unintended mutation | Security/regression | Filesystem and CLI canary matrices | Package, workflow, catalogs, ledger, activation index, and evaluation store remain byte-for-byte unchanged |
| Documentation and release quality | Docs/release | Docs, dependency, full test, coverage, runtime, live-provider, package, audit, and CI-parity gates | All configured gates pass with limitations and platform evidence recorded |

## Verification evidence

### Focused acceptance selector

```sh
npx vitest run \
  test/unit/adaptation/agent-skill-candidate-generation.test.ts \
  test/unit/application/generate-agent-skill-candidate.test.ts \
  test/unit/infrastructure/fs/local-agent-skill-candidate-generation.test.ts \
  test/unit/infrastructure/fs/local-agent-skill-candidate-publication.test.ts \
  test/integration/cli/agent-skill-candidate-generation.test.ts \
  test/unit/adaptation/agent-skill-candidate.test.ts \
  test/integration/cli/agent-skill-candidate.test.ts \
  test/unit/infrastructure/fs/local-prompt-candidate.test.ts \
  test/unit/infrastructure/fs/local-prompt-candidate-generation.test.ts \
  test/unit/infrastructure/fs/local-agent-skill-candidate.test.ts
```

Result: 151 tests passed across 10 files.

The dependency-boundary selector passed 11 tests:

```sh
npx vitest run test/integration/package/dependency-boundaries.test.ts
```

### Frozen-tree release evidence

- The serial suite passed 3,752 tests and skipped 4 declared tests across 267 files.
- The coverage suite passed the same 3,752 tests and 4 skips. It reported 83.89% statements,
  78.10% branches, 90.29% functions, and 84.00% lines.
- The compiled runtime suite passed 40 tests and skipped 34 platform-specific tests across 18
  files.
- The browser suite passed 2 tests. The live-provider suite loaded and skipped 3 tests because no
  provider credentials were available.

- Format, typecheck, build, changed-document STE, and diff checks passed. Lint passed with one
  pre-existing informational constructor note in an unchanged file.

- Clean package installation and CLI execution passed. The installed project reported effective
  policy digest `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

- The production npm audit reported zero vulnerabilities. The Prime dependency audit passed for
  the Node lock and 60 Python packages.

- The compiled smoke check passed.

- `npm run ci:local` passed its preliminary gates and then rejected Prime preparation because the
  local host is macOS arm64. Hosted Linux x64 CI with the pinned Docker, containerd, and runc stack
  remains required before merge.

## Activity log

- 2026-08-16: Audited the current roadmap, open work, and completed prerequisite stack.
- 2026-08-16: Compared five next slices against six weighted criteria and a randomized sensitivity
  analysis. Agent Skill generation won 94.143% of randomized samples.
- 2026-08-16: Created Issue #105 with explicit non-goals, failure modes, and interface contracts.
- 2026-08-16: Presented four architecture alternatives. The user approved Approach A.

- 2026-08-16: Implemented the bounded resource-delta generation contract, stable local admission,
  zero-tool execution, generation provenance, sibling-kind atomic publication, and CLI grammar.

- 2026-08-16: Ran the frozen-tree focused, full, coverage, runtime, browser, live-provider, package,
  audit, documentation, static, and local CI gates.

- 2026-08-17: Closed the final findings for durable target grammar, source-root ancestry, audit
  output, and mutation evidence. Re-ran the frozen release gates with the evidence above.
