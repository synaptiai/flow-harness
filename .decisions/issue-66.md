# Decision Journal: Issue #66 — Evidence-bound adaptive prompt candidates

**Issue**: #66 | **Branch**: `codex/issue-66-adaptive-prompt-candidates` | **Started**: 2026-08-09

---

## Context

Issue #64 completed the first reproducible harness-evaluation vertical slice. Flow can now compare
two complete `flow-workflow-v1` profiles under the same model, budget, network, retry, fixture,
verifier, seed, and scheduling controls. The remaining Gate 7 gap is the unit of adaptation: an
operator or future refiner cannot describe a bounded harness change, bind it to tuning evidence, or
carry its identity through evaluation without copying and editing a whole workflow.

The new surface must not introduce a second scheduler or compiler, reveal regression/holdout
material, turn a model proposal into activation authority, or make evaluation identity depend on
mutable ambient state.

## External evidence

- [Pi autoresearch](https://pi.dev/packages/pi-autoresearch) uses an append-only experiment log,
  explicit keep/revert decisions, restart recovery, and reviewable final branches. The durable-log
  and review boundaries are useful; unrestricted repository mutation and scalar-command evaluation
  are not sufficient for Flow's harness contract.
- [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) stores prompt, memory, skill, and
  subagent refinements as supplemental state while retaining an immutable base prompt and rollback
  history. Its worker and Python kernel provide lifecycle isolation rather than a security sandbox,
  and its refiner may directly apply proposals. Flow keeps the supplemental-state principle but
  separates proposal, evaluation, and activation.
- [Continual Harness](https://arxiv.org/abs/2605.09998) identifies prompt, sub-agent, skill, and
  memory as useful adaptive surfaces and reports gains from online refinement. Its in-place,
  reset-free research loop is not copied because Flow must keep evaluator definitions and base
  semantics immutable during an authoritative run.
- [OMP metaharness](https://github.com/can1357/oh-my-pi/tree/main/packages/metaharness) reinforces
  experiment/run/trace separation and whole-task isolation. Native OMP/Prime execution remains a
  later isolation-and-credential-broker milestone rather than the candidate implementation seam.

## Milestone choice

| Candidate | Value | Existing seam | Main risk | Disposition |
| --- | --- | --- | --- | --- |
| Prompt-candidate lifecycle | Starts Gate 7 with an actually evaluable change | Workflow compiler, evaluation store, paired reports | Holdout leakage or disguised workflow replacement | **Selected** |
| Native OMP/Prime adapter | Direct external comparison | Harness adapter port | Whole harness retains user authority and credentials | Defer until stronger isolation |
| OMP-inspired native tool | Immediate ergonomics | Tool broker and evaluation | Adoption before representative evidence | Benchmark separately |
| Policy/UI packages | Closes Gate 6 text | Package distribution | Authority-bearing policy and no stable UI host | Defer |

Prompt-only is selected for the first candidate ABI because it changes harness guidance without
changing runtime authority. Routing would contradict the current evaluation plan's shared-model
control. Skills, tools, policy, verifiers, approvals, budgets, graph structure, and retry behavior
have additional capability or authority implications and remain excluded.

## User, operator, and system flows

### Author/refiner flow

1. Run or receive a completed evaluation containing at least one tuning task.
2. Export a canonical tuning-only evidence packet.
3. Author a prompt candidate against an exact baseline workflow and one or more exact evidence
   packets.
4. Validate the candidate and inspect the baseline, evidence, target nodes, before/after hashes, and
   projected workflow identity without executing a model.
5. Reference that candidate as the candidate profile in a new paired evaluation plan.

The author/refiner never receives regression/holdout rows, verifier identities, assertions, run ids,
or schedule positions through the tuning packet.

### Operator flow

1. Review the candidate source, motivating evidence identities, and prompt diff hashes.
2. Validate that the paired plan preserves the shared model and safety controls.
3. Run, inspect, or export the evaluation using the normal CLI.
4. Treat a favorable report as evidence only. Activation remains unavailable.

### System flow

1. Read the evaluation store through its existing strict replay and digest-chain validation.
2. Require the evaluation to be complete and select only tasks declared `tuning`.
3. Project bounded outcome/metric evidence and compute its own canonical digest.
4. Admit a candidate source, baseline workflow, and evidence packets with stable file observations.
5. Verify all declared hashes and ensure at least one evidence profile matches the exact baseline
   workflow digest.
6. Replace only prompts on declared root agent nodes in the parsed baseline source.
7. Compile the deterministic projection with the ordinary compiler and record both proposal and
   projected identities.
8. Include the candidate identity in the evaluation plan digest, durable public header, resume
   comparison, and offline export.

## Architecture alternatives

### A. Immutable prompt overlay projected through the existing compiler — selected

A strict candidate manifest binds one baseline workflow, one or more tuning-only evidence packets,
and bounded prompt replacements for existing root agent nodes. Admission constructs deterministic
JSON workflow source, compiles it normally, and exposes the result through the existing
`flow-workflow-v1` adapter.

- **Strengths**: smallest authority surface; exact structural preservation by construction; normal
  compiler, scheduler, sandbox, policy, evaluation, and replay paths; provider-neutral.
- **Costs**: prompt-only; candidate source admission and evaluation schemas gain an optional identity;
  a future refiner still needs a separate model-facing proposal workflow.
- **Security**: no executable code, run handle, verifier material, or activation authority enters the
  candidate.

### B. Full rewritten workflow plus a semantic diff checker — rejected

Accept a complete candidate workflow and compare it with a baseline after compilation.

- **Strengths**: simple authoring and future flexibility.
- **Failure**: every new workflow feature would expand the semantic comparator; source changes could
  hide graph, policy, package, budget, tool, or retry changes; the candidate would be a replacement,
  not a narrow supplemental artifact.

### C. Model refiner directly edits active workflow source — rejected

Give a zero-tool or workspace agent evaluation evidence and let it edit the baseline file.

- **Strengths**: visible end-to-end self-improvement loop immediately.
- **Failure**: conflates proposal with mutation authority, complicates crash recovery, risks holdout
  leakage, and makes rollback/stale-baseline behavior part of the first slice.

### D. New native adaptive-harness runtime adapter — rejected

Create a special executor for candidates instead of projecting ordinary Flow workflows.

- **Strengths**: could support Prime-style continual state and online updates.
- **Failure**: creates a second scheduler/replay boundary and weakens comparability with the baseline.

## Domain contracts

### Tuning evidence packet

The packet is canonical strict JSON with a fixed version and kind. It contains:

- source evaluation id, plan digest, terminal ledger digest, and complete trial counts;
- suite id/version;
- profile ids, adapter kind, workflow digest, and optional candidate digest;
- tuning task ids; and
- per-tuning-trial profile id, seed, repetition, classification, bounded harness outcome/reason plus
  explicit reason truncation, verification outcome, and nullable metrics.

Admission requires complete profile pairs, a one-to-one seed/repetition mapping, contiguous
repetition numbers, and a declared total that implies an integral source-task count between the
retained tuning-task count and the evaluation task ceiling.

It does not contain task partitions, fixtures, instructions, regression/holdout task ids, schedule
positions, trial ids, run ids, record digests, verifier digests, assertion counts, assertions,
observed file hashes, or raw workflow source. An `evidenceDigest` is computed over all content except
the digest field. Export is deterministic, atomic, and no-overwrite.

### Prompt candidate source

The strict YAML/JSON source contains:

- fixed API version and `PromptCandidate` kind;
- canonical id and exact semantic version;
- workflow-scoped baseline path, source SHA-256, and compiled workflow digest;
- one through sixteen evidence references containing a portable path, source SHA-256, evidence
  digest, and plan digest; and
- one through sixteen unique root agent-node prompt replacements, each with the expected current
  prompt SHA-256 and a bounded non-empty replacement.

Unknown fields, duplicate paths/digests/targets, path escapes, symlinks, special files, unstable
reads, oversized sources, malformed YAML/JSON, digest mismatches, missing matching baseline evidence,
unknown targets, non-agent targets, stale prompt hashes, and invalid projected workflows fail closed.
Stable observations include the canonical candidate root, every intermediate component, and the
final file with device/inode/size/nanosecond mtime/ctime identity.

### Admitted prompt candidate

Admission returns immutable private source paths/content plus a public identity containing:

- candidate id/version/digest and manifest provenance/source SHA-256;
- baseline provenance/source SHA-256/workflow digest;
- ordered evidence provenance/source/evidence/plan digests;
- ordered target node ids and before/after prompt digests; and
- projected workflow source SHA-256 and compiled workflow digest.

`candidateDigest` is derived from the complete public identity excluding itself. No absolute path or
prompt body enters the public identity.

### Evaluation profile source

An evaluation profile selects exactly one of `workflow` or `candidate` while retaining adapter
`flow-workflow-v1`. A candidate profile executes its admitted projected workflow only when it is the
declared comparison candidate and its embedded baseline exactly matches the comparison baseline
profile. Its candidate identity and generated-source kind enter the plan digest and public header.
The header retains the complete prompt-free identity, independently recomputes `candidateDigest`,
and cross-binds baseline and projected hashes to the surrounding profiles. Direct workflow source
syntax is unchanged and omits source kind from the version-1 identity, so legacy stored headers and
incomplete runs remain replayable and resumable.

### CLI

```text
flow candidate validate <candidate.yaml>
flow eval tuning-evidence <evaluation-id> --output <path> [--evaluations-dir <path>]
```

Candidate validation is read-only and credential-free. Tuning-evidence export requires a complete,
valid local evaluation, writes canonical JSON atomically, and refuses overwrite. Existing eval
validate/run/inspect/export commands include candidate identity when present.

## Coupling analysis

| Community | Change | Constraint |
| --- | --- | --- |
| Workflow schema/compiler | Parse baseline and compile projected JSON | No new node semantics or alternate compiler |
| Evaluation domain | Profile source/identity admits candidate selection | Direct workflow plans remain valid |
| Evaluation filesystem admission | Stable-read candidate, baseline, and evidence | All paths remain below the plan/candidate root |
| Evaluation store | Optional candidate identity in public profile | Legacy headers omit it and remain replayable |
| CLI/export | Candidate validation and tuning-only export | No credentials, overwrite, or hidden material |
| Runtime adapter | Receives projected ordinary workflow | No candidate-specific execution authority |
| Documentation | Describe hygiene and non-activation | Do not claim automatic refinement or superiority |

## Failure modes

| Failure | Required behavior |
| --- | --- |
| Evaluation is incomplete, corrupt, or has no tuning tasks | Refuse evidence export; write nothing |
| Export target exists or parent cannot be made durable | Refuse overwrite and report an actionable error |
| Regression/holdout material appears in projected packet | Contract/test failure; packet must be rejected or implementation fixed before release |
| Candidate/evidence/baseline path escapes or is a symlink/special file | Reject before projection or output |
| Candidate, evidence, or baseline changes during admission | Reject as `source_changed` |
| Declared source, plan, evidence, baseline, or prompt digest differs | Reject as identity mismatch |
| Evidence does not contain a profile matching the baseline workflow digest | Reject cross-plan/cross-baseline substitution |
| Target is missing, duplicated, nested, or not a root agent node | Reject; do not reinterpret target paths |
| Replacement makes the workflow invalid | Return ordinary compiler diagnostics wrapped as candidate admission failure |
| Evaluation header candidate identity is removed/swapped/tampered | Digest or schema replay fails closed |
| Candidate evaluation is favorable | Report evidence only; never mutate baseline or activate candidate |

## Non-goals

- Automatic model proposal, activation, rollout, rollback, or mutation during an authoritative run.
- Skill, memory, sub-agent, routing/model, tool, policy, UI, verifier, budget, approval, retry, graph,
  package, or executable-extension candidates.
- Native Pi, OMP, or Prime evaluation adapters.
- Revealing or summarizing non-tuning tasks/results/verifier material to a refiner.
- Proving statistical representativeness or publishing a superiority claim.

## Acceptance-criterion verification map

| Criterion | Command | Expected evidence |
| --- | --- | --- |
| Strict candidate schema and bounds | `npx vitest run test/unit/adaptation/prompt-candidate.test.ts` | Table-driven valid/unknown/duplicate/bounds/digest cases pass |
| Tuning-only evidence and canonical identity | `npx vitest run test/unit/evaluation/tuning-evidence.test.ts` | Deterministic packet snapshot; forbidden-key/content matrix absent |
| Stable local candidate admission | `npx vitest run test/unit/infrastructure/fs/local-prompt-candidate.test.ts` | Path, symlink, race, tamper, target, projection, and baseline tests pass |
| Candidate evaluation identity/replay | `npx vitest run test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/integration/cli/prompt-candidate.test.ts` | Exact baseline, candidate plan/header, offline inspect/export, drift-resume, and tamper tests pass |
| CLI validate/export/run/inspect | `npx vitest run test/integration/cli/prompt-candidate.test.ts test/integration/cli/evaluation.test.ts` | Credential-free candidate/evidence flow and paired run pass |
| Existing evaluation contracts | `npx vitest run test/unit/evaluation test/unit/application/run-evaluation.test.ts test/unit/application/evaluation-adapter.test.ts` | All evaluation tests pass |
| Type/build/runtime contract | `npm run check` | Format, lint, typecheck, tests, and build pass |
| Coverage | `npm run test:coverage` | Configured global thresholds pass |
| Distribution | `npm run pack:check` | Packed public artifact verification passes |
| Dependency integrity | `npm audit --omit=dev --audit-level=low` | No production vulnerability at threshold |
| CI syntax | `actionlint .github/workflows/ci.yml` | Workflow lint exits zero |
| Public documentation | `npx vitest run test/scaffold/community-files.test.ts` | Required adaptive/evidence/trust text is present |

## TDD implementation sequence

1. Red/green the strict tuning-evidence packet projection and parser.
2. Red/green the prompt-candidate source, identity, projection, and adversarial domain cases.
3. Red/green stable filesystem admission for baseline and evidence sources.
4. Red/green candidate-aware evaluation plan identity, durable header, and replay.
5. Red/green CLI validation and tuning-evidence export, then paired candidate execution.
6. Refactor shared canonical JSON and stable-source helpers only where duplication is proven.
7. Update public documentation and examples without marking activation complete.
8. Run focused, full, coverage, packaging, audit, and actionlint gates.
9. Run independent spec, security, and holdout review; resolve every P1/P2/P3 finding.

## Adversarial review reconciliation

| Finding | Disposition | Verification |
| --- | --- | --- |
| Export could exceed the 8 MiB admission ceiling | Fixed: truncate reasons to 512 UTF-8 bytes with explicit evidence and enforce canonical packet bytes | Maximum 4,096-trial export boundary test |
| Nested and candidate-root path swaps were not fully observed | Fixed: root/ancestor/final BigInt identity snapshots and post-read revalidation | Deterministic nested and root symlink-race tests |
| Evidence admitted contradictory outcomes or impossible tuples/totals | Fixed: classification/recovery consistency, unique complete pairs, scheduler bijection, contiguous repetitions, feasible totals | Re-digested semantic mutation matrix |
| Candidate could be compared against an unrelated baseline | Fixed: live admission and durable replay bind candidate projection to the exact comparison baseline | Negative plan and re-digested header tests |
| Public provenance paired generated bytes with a baseline path | Fixed: projection source kind plus null private source path and selection provenance | Plan/header provenance assertions |
| Partial durable identity permitted internally inconsistent redigestion | Fixed: retain and independently verify complete candidate identity, then cross-bind surrounding workflow hashes | Valid-then-mutated complete-header replay test |
| `sourceKind: file` changed direct version-1 plan digests | Fixed: omit the discriminator for direct sources and retain it only for projections | Legacy header/current-plan claim-resume test |
| Public replay still accepted explicit `sourceKind: file` as a second encoding | Fixed: public type/schema admit only an optional projection literal | Self-consistently redigested explicit-file header rejection test |
| Hostile schema diagnostics could be unbounded | Fixed: bound issue count, message fragments, and final CLI diagnostics | Large unknown-key diagnostic tests |
| Prompt schema silently trimmed exact replacement text | Fixed: validate non-blank text without transforming it | Exact leading/trailing whitespace test |
