# Reproducible harness evaluation

Flow evaluates complete harness profiles, not models in isolation. A versioned plan binds two
workflow profiles to the same task fixtures, private deterministic verifiers, model configuration,
budgets, retry policy, network policy, seeds, and paired order. It then records each scheduled trial
in a separate immutable evaluation ledger.

This makes a result inspectable and reproducible from committed evidence. It does not make a small
or biased suite statistically representative, turn a seed into provider-side sampling control, or
justify a superiority claim without enough held-out tasks.

Install the [Flow preview](guides/install-preview.md) before you use this guide. Commands that name
an included `examples/...` plan must run from the root of a Flow checkout that matches the installed
version. Replace those paths with your own project-relative plans when you evaluate another project.

## Quick start

From the matching checkout, validate the included plan without credentials or filesystem mutation:

```sh
flow eval validate examples/evaluation/harness-comparison.evaluation.yaml
```

Validation compiles both workflows and fingerprints every admitted source. Running trials contacts
the declared provider and therefore needs its normal Pi credentials:

```sh
flow eval run examples/evaluation/harness-comparison.evaluation.yaml
flow eval inspect harness-comparison
flow eval export harness-comparison --output harness-comparison.json
```

The native Pi example uses one Flow workflow and one native Pi profile:

```sh
flow eval validate examples/evaluation/native-pi-comparison.evaluation.yaml
flow eval run examples/evaluation/native-pi-comparison.evaluation.yaml
```

The native OMP example compares the native Pi and native OMP profiles:

```sh
flow eval validate examples/evaluation/native-omp-comparison.evaluation.yaml
flow eval run examples/evaluation/native-omp-comparison.evaluation.yaml
```

The OMP example requires Linux and an attested official Bun 1.3.14 standard executable for x64 or
arm64. It also requires the two optional OMP packages at version 17.2.12. Validation checks these
local runtime identities. A run also needs the declared provider credentials in the Flow host.
`FLOW_BUN_EXECUTABLE` can select another host path. It cannot add a release attestation.

The Prime Agent example compares one Flow workflow with one fixed Prime profile:

```sh
flow runtime prepare prime-agent
flow eval validate examples/evaluation/native-prime-agent-comparison.evaluation.yaml
flow eval run examples/evaluation/native-prime-agent-comparison.evaluation.yaml
```

Prime Agent requires Linux x64, Docker API 1.51, cgroup v2, and the fixed local image. Docker must
configure `flow-prime-runc` with one canonical `runc` path and no arguments.
Preparation builds the image twice. Flow rejects different image, package, closure, or SBOM
identities. A run never builds, pulls, or updates the image.

The default store is `.flow/evaluations/<evaluation-id>/`. `--evaluations-dir <path>` selects an
explicit store for run, inspect, and export. `eval export` refuses to overwrite an existing file.

## ACP interoperability qualification

An evaluation with `purpose: acp-interoperability-v1` qualifies two distinct exact local ACP
executors against one shared prompt-only workflow. It uses private canonical result verification
and produces `report.qualification` with `qualified`, `not_qualified`, or
`insufficient_evidence`. It doesn't authorize activation or tuning-evidence export.

Read [Qualify two local ACP agents](guides/qualify-acp-agents.md) for agent selection, manifests,
the restricted workflow and plan shapes, live execution, verdict interpretation, and recovery.

## Phase-routing qualification

An evaluation with `purpose: phase-routing-v1` compares the complete `before` and `after` profiles
from one immutable effective-harness candidate. Every task must be a filesystem-verified holdout.
The report requires complete per-request route, cost, and latency evidence, non-inferior verified
quality, both explicit efficiency thresholds, and the declared safety constraints.

Only a complete `qualified` report can authorize activation of that exact composed artifact. The
ordinary superiority verdict doesn't own this decision. Read
[Evaluate and activate phase-aware model routing](guides/phase-routing.md) for candidate authoring,
the plan, verdicts, activation, recovery, and non-goals.

## Bounded delegation evaluation

An evaluation with `purpose: delegation-v1` compares the same root workflow and package closure
with and without one sealed foreground specialist. Only the exact candidate manager receives the
empty-input `flow_delegate` tool. It can skip the tool or call the exact reviewed child once.

The report separates `delegation-fit` and `sequential-control` tasks, child outcomes, child resource
changes, missing observations, and constraint violations. Missing delegation evidence forces
`insufficient_evidence`. A proven constraint breach forces `constraint_failed`. No verdict can
authorize activation.

Read [Evaluate bounded one-shot delegation](guides/evaluate-bounded-delegation.md) for candidate
production, plan requirements, the foreground child lifecycle, report interpretation, recovery,
privacy, and non-goals.

## Context compaction evaluation

The dedicated three-mode evaluator compares complete portable history, verified artifact
references, and reference-first bounded summaries:

```sh
flow eval compaction validate \
  examples/evaluation/context-compaction.evaluation.yaml
flow eval compaction run \
  examples/evaluation/context-compaction.evaluation.yaml
```

It uses a distinct `ContextCompactionEvaluationPlan`, a six-order balanced schedule, protected
constraint assertions, and the store at
`.flow/evaluations/context-compaction/<evaluation-id>/`. Inspect and export use `eval compaction
inspect` and `eval compaction export`. The report can never authorize production activation.

Read [Evaluate reference-first context compaction](guides/context-compaction.md) for the plan,
runtime, metrics, verdict, and recovery contract. The ordinary two-profile plan and activation
rules below don't apply to this specialized experiment.

## Plan contract

An `EvaluationPlan` contains:

- A canonical plan id and a versioned suite.
- One or more tasks partitioned as `tuning`, `regression`, or `holdout`.
- Exactly two profiles in version 1.
- One shared provider, model id, and `thinking` level, except when `phase-routing-v1` binds two
  complete exact phase profiles.
- One exact budget, denied workload-tool network, and zero provider and harness retries.
- Unique non-negative seeds and `paired-alternating-v1` order.
- Comparison thresholds and safety constraints.

The plan must schedule enough holdout pairs to satisfy its superiority threshold:
`minimumPairedTrials` must be no greater than the number of holdout tasks multiplied by the
number of seeds. Because the minimum is positive, every plan therefore needs at least one holdout
task. Tuning and regression pairs do not count toward this threshold.

A profile selects one of these built-in adapters:

- `flow-workflow-v1` selects one admitted workflow, prompt candidate, or Agent Skill candidate.
- `pi-native-v1` selects the fixed `pi-evaluation-v1` harness configuration.
- `omp-native-v1` selects the fixed `omp-evaluation-v1` harness configuration.
- `prime-agent-native-v1` selects the fixed Prime Agent OCI harness configuration.

The plan cannot select an executable path, package version, driver path, or protocol version.
Flow resolves these values from its trusted external harness registries.
For the generated roster and isolation types, read
[Tools and capabilities](reference/tools-and-capabilities.md#evaluation-adapters).

The ACP qualification purpose is the narrow exception for an executor selection. Each of its two
`flow-workflow-v1` profiles selects one project-local `AcpAgent` manifest. Admission binds the
manifest's exact runtime closure in the capability snapshot. Both profiles must select the same
workflow source and distinct executor identities.

The bounded delegation purpose is the narrow exception for a sealed child capability. Its two
`flow-workflow-v1` profiles use the same root workflow and package closure. The baseline has no
delegation authority. The candidate binds one exact embedded Pi manager, objective, child workflow,
typed result, executor identity, complete child budget, depth of one, and one call. Every task is a
filesystem-verified holdout labeled `delegation-fit` or `sequential-control`, and both labels are
required.

Paths are portable relative paths below the plan directory. Fixtures may contain only bounded
regular files and directories: symbolic links, special files, `.flow`, path escapes, oversized
trees, and sources that change during admission fail closed. Each workflow must contain a
model-bearing node and exactly match the plan's model and budget. Version 1 rejects workflow,
verifier, and command-tool packages plus agent fresh-recovery settings because their full identity
is not yet represented in the evaluation plan. An Agent Skill candidate is the only skill-bearing
profile form. It binds one selected package and supplies exact capability snapshots to both
profiles.

The built-in `filesystem-v1` verifier supports only closed data assertions:

- `exists` requires a regular file or directory;
- `absent` requires that the path not exist; and
- `sha256` requires a regular file with the declared lowercase SHA-256.

Verifier assertions and their digest enter the plan identity but are never sent to the evaluated
adapter. The adapter receives only the task instruction, frozen workspace identity, workflow
profile, declared model/control values, trial identity, and seed.

## Schedule and isolation

Flow derives a stable schedule from the complete plan digest. For every task/seed pair it runs the
baseline and candidate consecutively, alternating which profile starts first on each pair. This
limits order bias while preserving deterministic replay. A seed identifies repetition and order;
the current Pi adapter does not claim to set a provider's random sampler from that seed.

Every trial starts from a fresh reflink-or-copy workspace. Flow observes the copied tree again and
refuses execution if its digest, entry count, byte count, instruction path, or instruction digest
differs from admission. The adapter has no evaluation-store authority. After the harness settles,
Flow runs the private verifier against the final isolated workspace and appends exactly one terminal
trial record. The final workspace is then discarded. A resumed owner idempotently removes residue
for committed trials and for the next uncommitted trial before creating a fresh copy; cleanup failure
stops the evaluation rather than reusing partial output.

New evaluations use an explicit named private collection below the evaluation directory. Flow
continues to protect the historical `.flow-workspaces` name. It does not create a new unnamed
collection.

## Evidence and outcomes

`plan.json` is a redacted public header: it contains source digests and portable provenance, not
absolute fixture paths, workflow bodies, prompts, or private verifier assertions. It retains each
verifier digest and assertion count so offline replay can prove evidence identity and completeness.
`trials.jsonl` is an append-only digest chain. A same-host owner record permits one writer; a dead owner can be
retired, while a live or corrupt owner blocks another writer. A torn final JSON fragment is ignored
on read and repaired before the next append. Earlier corruption, record reordering, duplicated
trials, plan drift, or schedule contradictions fail closed.

Headers, trial lines, and owner metadata use fatal UTF-8 decoding and bounded strict JSON parsing.
Duplicate keys, invalid Unicode or UTF-8, non-I-JSON numbers, excessive structure, and trailing input are rejected before they can
become evidence or mutation authority.

Each scheduled trial is classified as:

- `verified_success`: the harness completed and the private verifier accepted;
- `false_completion`: the harness completed but deterministic verification rejected;
- `harness_failure`: the harness failed, crashed, timed out, cancelled, or returned malformed or
  missing output; or
- `verifier_error`: the harness completed but the private verifier could not produce a verdict.

Accepted/rejected results must cover every admitted assertion in order. Verifier errors carry a
bounded reason. A mismatched verifier digest or contradictory assertion set is never accepted.

Missing records are never successes and stay in the scheduled denominator. Unavailable metrics are
`null`, counted separately, and never coerced to zero. Reports retain reported cost, token classes,
turns, tool calls/errors, wall and active time, interventions, policy violations, recovery attempts,
and recovery outcome when the underlying run recorded them. `costPerAcceptedResultUsdMicros` is
available only after the complete profile schedule has cost evidence for every trial and at least one
verified success; it divides total profile cost, including failed attempts, by verified successes.
When a child run contributes only aggregate resource evidence, unprojected child activity, policy,
intervention, and recovery measurements remain `null` rather than becoming top-level zeroes.

## Comparison verdict

Reports reproduce per-profile rates from the complete scheduled denominator. The superiority
comparison uses matched holdout task/seed pairs only; tuning and regression trials remain descriptive
and still participate in whole-profile safety metrics. Flow requires each pair to match on platform,
architecture, Node version, Flow version, workspace backend, and starting fixture snapshot, then uses
a deterministic 2,000-sample bootstrap over the paired verified-success delta at the fixed 95%
confidence level.

`superior` requires all of the following:

- at least `minimumPairedTrials` complete, environment-comparable holdout pairs;
- the confidence-interval lower bound to exceed `minimumEffect`;
- candidate false-completion rate at or below `maxFalseCompletionRate`;
- available candidate policy-violation evidence at or below `maxPolicyViolations`; and
- candidate verified-success regression no worse than `maxVerifiedSuccessRegression`.

If regression tasks are present, the regression ceiling uses only complete environment-comparable
regression pairs. With no regression tasks it is not applicable; holdout gains never offset declared
regression losses.

Otherwise the verdict is `constraint_failed`, `insufficient_evidence`, or `not_superior`. A complete
evaluation may therefore be valid evidence without supporting a superiority claim.

## Holdout hygiene and claim quality

The runtime boundary prevents verifier assertions from entering adapter requests, but benchmark
authors still control the source material. Do not place expected output, hashes, hidden tests,
verifier logic, or answer-bearing history in a holdout fixture, `TASK.md`, profile prompt, package, or
model-visible repository file. Review task provenance and rotate contaminated tasks. A digest proves
which bytes were used; it does not prove those bytes were secret before the run.

Use `tuning` tasks for prompt and workflow iteration. Use `regression` tasks to protect known
behavior. Treat a small or repeatedly inspected `holdout` result as exploratory. Release-quality
evidence needs a predeclared plan, enough independent held-out tasks and paired repetitions for the
minimum sample, complete telemetry required by its constraints, environment disclosure, no plan
changes after looking at results, and replication where practical. Flow enforces the declared
mechanics but cannot certify task independence, statistical power, or freedom from publication bias.

## Resume and offline inspection

Re-running `eval run` with the same evaluation id and exact admitted plan validates the committed
prefix and starts only the missing suffix. It never reruns a committed trial and never resumes
inside a trial. If the evaluator stops after an underlying run starts but before its trial record is
committed, v1 does not reconstruct or credit that orphan as success; the uncommitted schedule slot is
recorded as failure without a provider retry. A source change creates a different plan digest and cannot be attached to the old
evaluation. `eval inspect` and `eval export` need only the evaluation store: they do not load live
workflows, fixtures, provider configuration, or credentials.

## Current adapter boundary

The provider-neutral application port is `HarnessEvaluationAdapter`.

`flow-workflow-v1` executes a compiled Flow workflow. It derives metrics from the durable run
state. `pi-native-v1` and `omp-native-v1` run in separate SRT processes on Linux. Flow requires the
verified Linux PID namespace.

`prime-agent-native-v1` runs in one fixed Docker OCI image on Linux x64. It uses a persistent
IPython session for the trial. The trusted settlement records zero or one kernel request. A second
kernel request fails the trial. The image has no external network route or daemon log.

Each child receives the task, trial identity, workspace identity, model controls, and budgets. It
does not receive verifier assertions, evaluation-store paths, or provider credentials.

The host broker makes each model request. It enforces the admitted provider, model, thinking level,
zero retries, and cumulative token and cost limits. Each child can use only `read` and `edit`.
Flow confines the Pi and OMP tools to the canonical trial workspace. The OMP profile disables ambient
extensions, skills, rules, MCP, memory, LSP, project context, and session persistence.

The Pi profile identity binds the Node executable and both installed Pi package closures. The OMP
profile identity binds an attested Linux Bun executable and both installed OMP package closures.
The OMP closure includes runtime Markdown and the package-resolution graph. Flow also observes the
directories that can change package resolution. Both identities bind the adapter contract,
protocol, driver closure, local Flow closure, SRT closure, configuration, policy, platform,
containment, and broker contract. Any change creates a new plan digest. A resume operation rejects
that change.

The OMP child receives a canonical `NODE_PATH` for the selected package graph. SRT grants read
access only to the exact package roots in that graph. An unselected package in the same search
container stays private.

The Prime identity binds the Docker runtime, fixed policy, image, Node closure, Python closure,
Prime package, driver configuration, broker, and transfer protocol. Local attestation also binds
the Docker socket, daemon, cgroup, image device, and global lease target.

The final-image probe hashes the driver closure, supervisor, kernel proxy, and Python launcher. The
protected attestation stores these hashes. The host package does not contain these image binaries.

Only the public identity enters the evaluation header. Inspect and export do not load Docker,
Prime Agent, Python, or the local attestation. Raw host identifiers stay outside public evidence.

Flow permits one active Prime container per Docker daemon. It checks host capacity before create.
During execution, Flow monitors bounded Docker response time. A policy failure removes the container.

Flow stores an OCI lease before container start. Recovery reconciles the exact name, nonce, image,
policy, and full container ID. Flow does not start another trial while removal stays uncertain.

Tuning-evidence export accepts only `flow-workflow-v1` profiles. It rejects an evaluation that uses
an external harness profile.

## Tuning-only evidence and adaptive candidates

A completed evaluation with at least one tuning task can produce a deterministic refiner input:

```sh
flow eval tuning-evidence <evaluation-id> --output <path> [--evaluations-dir <path>]
```

Export reopens the store through the normal header, schedule, strict-record, digest-chain, and
completeness validation. It refuses a partial or corrupt evaluation, an evaluation without tuning
tasks, or an existing output path. The packet contains source evaluation/suite identity, the
terminal ledger digest, both profile workflow identities, optional prior candidate digests, and only
tuning trial classifications, bounded harness/verification outcomes, and nullable metrics. Harness
reasons retain at most 512 UTF-8 bytes and state whether they were truncated. Packet admission
rejects contradictory outcome/classification/recovery evidence, duplicate trials, incomplete pairs,
inconsistent tuning schedules, reused seeds/repetitions, non-contiguous repetitions, and totals that
cannot imply an integral bounded source-task count.

Regression and holdout task ids, records, outcomes, metrics, reasons, assertions, verifier digests,
assertion counts, fixtures, instructions, trial ids, run ids, record digests, and schedule positions
are absent rather than replaced by redaction markers. The packet has its own canonical
`evidenceDigest`; editing any retained value invalidates it. A SHA-256 digest proves exact bytes, not
who authored them or that the underlying tasks were independent.

An operator can generate one prompt candidate from an exact baseline and one or more tuning
packets:

```text
flow candidate generate <baseline> <evidence>... --output <candidate.yaml> \
  --id <id> --version <semver> --allow-nodes <id,...> \
  --provider <provider> --model <model> [--thinking <level>]
```

Flow admits stable local files before the model call. It sends only the permitted root-agent
prompts and the parsed tuning packets to one zero-tool model turn. It does not send regression or
holdout records, verifier data, workspace paths, activation state, or other project files. Flow
checks every admitted source again after the model call.

The model returns prompt replacements only. Flow adds exact hashes and generation provenance. The
response digest identifies the canonical accepted replacements, not a provider transcript. Flow
validates the normal candidate projection before it publishes a new file. It does not replace an
existing path. Generation does not run the evaluation and does not activate the candidate.

A pre-commit failure leaves no candidate. A post-commit cleanup failure returns
`publication_uncertain`, and a complete candidate can exist. A pre-commit lock-cleanup failure
returns `cleanup_uncertain`. The lock can block another publication until safe recovery.
If a process exits after commit, the next publication attempt keeps the complete final file. It
removes a dead same-host lock and a temporary link only when that link has the final file inode.
The command then returns `output_exists`.

An evaluation profile may select exactly one `workflow` or `candidate` source:

```yaml
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
  - { id: candidate, adapter: flow-workflow-v1, candidate: better.prompt-candidate.yaml }
```

Candidate admission verifies the manifest, baseline, evidence packets, prompt hashes, and projected
workflow. The candidate must be the declared comparison candidate. Its embedded baseline must match
the comparison baseline profile.

Candidate identity enters the plan digest, schedule, public header, resume checks, inspect output,
and export. The projection still uses `flow-workflow-v1`. Evaluation never changes the baseline.

The public header stores the complete prompt-free candidate identity. Replay recalculates its digest.
The baseline and projected identities must match both comparison profiles. Direct workflow profiles
omit the projection discriminator. This omission preserves existing version-1 plan digests.

### Agent Skill candidates

An `AgentSkillCandidate` binds the same tuning-only evidence to one exact workflow and one already
selected local Agent Skill package. It declares one through sixteen replacements for unique
existing UTF-8 package resources. Every replacement includes the expected current SHA-256.

An operator can generate one such candidate with one zero-tool model turn:

```text
flow candidate generate <baseline> <evidence>... --output <candidate.yaml> \
  --id <id> --version <semver> --skill <name> --allow-resources <path,...> \
  --provider <provider> --model <model> [--thinking <level>]
```

Flow admits the closed workflow, exact selected package, tuning packets, and 1 through 16 unique
existing inert UTF-8 resource targets before execution. `SKILL.md` and files below the top-level
`scripts/` directory are not generation targets. The request omits absolute paths, unrelated package
files, regression data, holdout data, verifier evidence, credentials, and live run state. The
response can replace only selected resources. It cannot select a package, add a file, or change
package authority.

Admission performs stable no-follow reads of the candidate, workflow, evidence, and baseline skill
package. It rejects path escape, links, special files, source drift, and missing or binary
resources. It also rejects stale hashes, unrelated evidence, and changes to package authority.
Replacing `SKILL.md` is allowed only when its parsed manifest authority remains exact.

The comparison baseline and candidate compile to the same workflow identity. The baseline profile
receives the admitted original package snapshot. The candidate receives the projected package
snapshot. Both snapshots come from the same candidate admission. Ordinary workflow capability
checks bind them before scheduling. Runtime trials do not reread the live skill catalog.

The candidate identity stores the baseline and projected package/capability digests, changed-file
hashes, workflow identity, evidence identity, and portable provenance. It omits resource contents
and absolute paths. The durable header distinguishes `agent-skill-candidate-projection` from prompt
projection while retaining legacy direct and prompt encodings. Inspection and export need no live
candidate, package directory, network, registry, or credential.

Generation publishes one inert candidate file without replacement. It does not evaluate,
automatically select, activate, install, or publish an Agent Skill package. A favorable result is
evidence, not authority. An operator can separately preview and apply an exact activation proposal
from the complete superior evaluation.

### Agent Skill package candidates

An `AgentSkillPackageCandidate` introduces one new inert package into a workflow that selects no
skills. The operator supplies a strict content-free blueprint that fixes the skill authority, one
root agent target, and 1 through 16 exact output paths. `SKILL.md` is required. Optional files are
below `references/` or textual `assets/`. Scripts, executable files, binary content, links, special
files, and model-selected paths reject.

One zero-tool model turn returns content for every declared path exactly once. The request contains
only the portable baseline identity, public blueprint, tuning-only evidence, target identity, and
fixed limits. Flow renders the `SKILL.md` authority from the blueprint and publishes this inert
review directory under an exact output lock. It refuses an observed existing output and never
intentionally replaces one:

```text
candidate-output/
├── CANDIDATE.json
└── skill/
    └── <operator-selected-name>/
        ├── SKILL.md
        ├── references/...
        └── assets/...
```

The baseline workflow must select no skills. Projection changes one root agent that already has the
`read` tool from `skills: []` to `[<operator-selected-name>]`. It does not change the graph, prompts,
models, tools, policy, approvals, budgets, verifiers, retries, or runtime semantics.

Paired evaluation compiles the original workflow with no capability package for the baseline
profile. It compiles the projected workflow and supplies exactly the generated package for the
candidate profile. The plan and durable store bind both workflow identities and both capability
states. They also bind the blueprint, evidence, generation provenance, and candidate digest. Trials
never discover a live skill catalog.

The review directory remains inert and source-dependent until activation. Validation reopens its
sibling baseline, evidence, and blueprint sources. A complete superior evaluation can produce an
exact activation proposal. Applied activation stores the original workflow with no package and the
projected workflow with the generated package. New runs, detached workers, resume, replay, and
rollback then use durable bytes only.

### Model-routing candidates

A `ModelRoutingCandidate` replaces one model tuple on one existing root agent node. The source
declares the exact current tuple and one exact replacement:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: ModelRoutingCandidate
metadata: { id: route-implement-to-gpt, version: 1.0.0 }
scope:
  kind: workflow-model-route
  workflowId: evaluated-profile
  nodeId: implement
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
route:
  before: { provider: test, id: deterministic, thinking: medium }
  after: { provider: openai, id: gpt-5.4, thinking: high }
```

The candidate is at most 65536 UTF-8 bytes. A provider uses a canonical identifier. A model id is
1 through 256 trimmed characters. The thinking level is `off`, `minimal`, `low`, `medium`, `high`,
or `xhigh`. The two routes must differ.

Admission uses stable no-follow reads for the candidate and baseline. The target must be an existing
root `agent` node. The declared before route must match the baseline source and compiled workflow.
Projection changes only `agent.model` on that node and compiles the complete result again.

Use `flow candidate compose <candidate>` before evaluation or activation. Direct activation of an
ordinary route candidate fails. Composition rebases the exact route onto the current complete
effective state and stages one immutable artifact.

A paired plan for the staged artifact keeps the shared `model` control and adds two ordered routes:

```yaml
controls:
  model: { provider: test, id: deterministic, thinking: medium }
  modelRoutes:
    - profileId: baseline
      nodeId: implement
      route: { provider: test, id: deterministic, thinking: medium }
    - profileId: candidate
      nodeId: implement
      route: { provider: openai, id: gpt-5.4, thinking: high }
```

The entries must name the comparison profiles in baseline-then-candidate order. They must target the
same declared node and match the candidate identity. The shared model still controls every other
agent and model verifier. Tasks, fixtures, seeds, budgets, network policy, retries, schedule order,
verification, and every non-route workflow field remain equal.

The durable plan, header, records, inspection, and export retain the route pair, candidate digest,
and workflow ID. The workflow ID appears independently in both profile bindings. Flow uses that
redundancy to bind the candidate scope to the admitted baseline and candidate workflows. Historical
non-routing evaluation headers can omit this field.

The public evidence omits workflow bodies, credentials, and provider responses. Trial execution
receives one selected route, not the pair. Flow does not discover models, choose routes dynamically,
or use fallbacks.

### Child-specialist candidates

A `ChildSpecialistCandidate` changes one existing agent in one embedded child workflow. It declares
the root workflow, child node, child agent, complete baseline identities, immutable package-closure
digest, and exactly one change axis:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: ChildSpecialistCandidate
metadata: { id: stricter-review-specialist, version: 1.0.0 }
scope:
  kind: workflow-child-specialist
  workflowId: specialist-harness
  childNodeId: delegate-review
  agentNodeId: review
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
  child:
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
  packageClosureDigest: <64-lowercase-hex>
change:
  kind: instructions
  beforeSha256: <64-lowercase-hex>
  value: Review the implementation and identify unsupported claims.
```

The alternative `skills` change declares exact ordered `before` and `after` lists. Every selected
name must already exist in the current effective state's immutable Agent Skill closure. The change
doesn't install, generate, fetch, or modify package bytes.

Admission reopens the candidate and sibling baseline with bounded no-follow reads. It checks the
root workflow, embedded child workflow, target agent, selected axis, and package closure. It rejects
a packaged child because the workflow package owns those immutable bytes. It also rejects a no-op,
both axes, an undeclared skill, a stale identity, or any unrelated root or child change.

The candidate source is at most 1 MiB. Replacement instructions are nonblank and at most 262,144
UTF-8 bytes. A skill list has at most 32 unique canonical names. Flow recompiles the complete parent
and child tree and accepts only the declared field difference.

Use `flow candidate validate <candidate.yaml>` against the current effective harness. Then use
`flow candidate compose <candidate.yaml>` to stage one complete effective harness artifact. Direct
activation of the ordinary child-specialist document fails.

Paired evaluation selects the staged artifact as the baseline and candidate profiles. Both profiles
use the same tasks, fixtures, seeds, model controls, budgets, network denial, retries, order,
verification, and immutable package bytes. Only the declared child axis differs. A complete superior
result can enter the existing effective-harness preview, apply, and state-digest rollback flow.

The public identity names the workflow, child, agent, axis, package-closure digest, complete state
digests, and candidate digest. For instructions, it contains only UTF-8 byte counts and SHA-256
digests. It contains no instructions, workflow body, package content, absolute path, provider
response, or nested error cause. Inspection, export, attached or detached execution, recovery, and
replay use durable state without reopening the candidate or a live skill catalog.

This surface doesn't add model-directed delegation, remote agents, session memory, dynamic routing,
fallbacks, or child workspace promotion. The compiled parent graph continues to decide when the
child runs and which typed result it returns.

### Supplemental-memory candidates

Supplemental memory is bounded reference context for one existing agent. It is part of the
immutable effective harness state. It is not conversation history, a provider session, a retrieval
service, or a model-writable store.

A `SupplementalMemoryCandidate` declares one add, replace, or remove operation:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: SupplementalMemoryCandidate
metadata: { id: reviewed-project-layout, version: 1.0.0 }
scope:
  kind: workflow-agent-memory
  workflowId: adaptive-workflow
  childPath: []
  agentNodeId: implement
  entryId: project-layout
baseline:
  stateDigest: <64-lowercase-hex>
  workflowDigest: <64-lowercase-hex>
  packageClosureDigest: <64-lowercase-hex>
change:
  kind: add
  value: Use the reviewed package map when locating implementation owners.
```

For a nested agent, `childPath` contains the ordered child-node IDs from the root workflow to the
workflow that owns `agentNodeId`. An add requires the entry to be absent. A replace or remove also
requires `beforeSha256` to equal the exact current entry digest. A no-op rejects.

The candidate file is at most 1 MiB. One state contains at most 16 entries. Each entry contains
1 through 16,384 UTF-8 bytes. One target receives at most 16,384 bytes, and one state contains at
most 65,536 memory bytes. Flow rejects blank or malformed UTF-8, duplicate entry identities,
noncanonical order, invalid targets, stale state or package identities, and unrelated changes.

Admission reopens the source with bounded no-follow reads and revalidates every lexical ancestor and
the source identity. It resolves the active complete state only after the source kind is known. The
target must be an existing compiled `agent` node. Projection recompiles the complete state and
proves that the workflow, root package, package closure, and every unrelated memory entry remain
unchanged.

#### Review relationship changes

A hand-authored memory candidate can also remove and add evidence-backed relationships incident to
its one entry. Relationship endpoints bind exact entry IDs and content digests in the same workflow,
child path, and agent target. Added relationships use only `supports`, `contradicts`, `refines`,
`supersedes`, or `derived_from`, and each cites one through four terminal run events for that exact
agent.

Flow resolves each event locator before staging and binds its sequence and complete event digest.
It rejects missing, ambiguous, corrupt, cancelled, stale, cross-agent, duplicate, cyclic, unrelated,
or excessive input. A replacement or removal must explicitly remove every prior incident
relationship. A replacement can rebind those claims to its new entry version in the same atomic
proposal. Contradictions remain unresolved. Flow doesn't infer truth, winners, symmetry, transitive
links, confidence, or temporal validity.

Model-assisted generation cannot declare relationships. Use
[Manage supplemental-memory relationships](guides/supplemental-memory-relationships.md) to author,
review, activate, recover, and roll back the hand-authored extension.

#### Generate a model-suggested entry

Use model-assisted generation when tuning evidence supports a new or replacement reference entry.
You must have an active effective harness for the workflow and one through 16 tuning-evidence
files. You choose the workflow, exact root or embedded-child agent, entry ID, add or replace
operation, output path, and model tuple.

This command generates an add proposal for a root agent:

```sh
flow candidate generate adaptive-workflow tuning-evidence.json \
  --output reviewed-memory.candidate.json \
  --id reviewed-memory \
  --version 1.0.0 \
  --memory-agent implement \
  --memory-entry reviewed-fixture \
  --memory-operation add \
  --provider <provider> \
  --model <model>
```

For an embedded child agent, add `--memory-child-path <child-id,...>`. For a replacement, use
`--memory-operation replace`. The active state supplies and binds the exact prior entry digest.
Generation doesn't support removal because the model doesn't need to produce content for that
operation. Write a reviewed removal candidate directly instead.

Flow sends one canonical request through one exact-model agent turn. The request contains the
selected agent prompt, memory for that exact target, tuning evidence, and content-free baseline
identities. The agent receives no tools, Agent Skills, capability packages, workspace authority,
target-selection authority, or retry. It must return exactly one JSON object with one `value`
string.

The request is at most 1 MiB. The response is at most 65,536 UTF-8 bytes and 8,192 output tokens.
The decoded value follows the existing 1-through-16,384-byte entry limit. The generated source
records content-free request, response, model, usage, evidence, operation, and prior-entry
identities. Flow rejects malformed output, extra response fields, a no-op replacement, changed
evidence, a changed effective-harness head, or cancellation before publication.

The command publishes one inert candidate with create-only semantics. It doesn't compose,
evaluate, activate, or write runtime memory. Public generate, validate, compose, run, event,
inspection, and export views omit the value, encoded value, evidence paths, provider response, and
nested causes. The selected model receives the proposed context, so don't use supplemental memory
as a secret store.

Validate and compose the candidate before evaluation:

```sh
flow candidate validate <candidate.yaml>
flow candidate compose <candidate.yaml>
```

Direct activation of the raw memory candidate fails. Composition binds the change to the exact
current effective head and stages one complete artifact. A paired evaluation selects that artifact
through `effectiveCandidate` for both profiles, with `selection: baseline` and
`selection: candidate`. Tasks, fixtures, seeds, models, packages, budgets, network denial, retries,
order, and verification remain equal.

The public candidate and evaluation views contain the target, entry ID, operation, byte counts,
content-free relationship changes, and SHA-256 digests. Public active-state and run views reduce
relationships to counts and set and assessment digests. They omit content, encoded content,
evidence locators, absolute source paths, and nested causes. After activation, attached runs,
detached workers, children, resume, recovery, replay, inspection, and export use the exact retained
state. They don't reopen the candidate, evidence runs, or a live memory source.

Treat supplemental memory as model-visible context, not as a secret store. Flow removes stored
memory bytes from its public state projections. A model can still repeat or transform context in
its generated node output, just as it can repeat an ordinary node prompt or workspace file.

Before an agent attempt, Flow places a fixed authority notice after its fixed system instructions.
One canonical escaped memory block follows the notice and precedes the selected Agent Skill catalog.
Only entries for the exact root workflow, child path, and agent node are included. Supplemental
memory cannot add a tool, package, or model route. It cannot change policy, approval, graph
transitions, or other execution authority.

When the exact target has relationships, Flow places a second bounded canonical block after the
memory block. It includes endpoint IDs and digests, predicates, and unresolved contradiction
status. It excludes evidence locators and unrelated-target relationships.

## Activation gate

### Review workflow

Validate and inspect a candidate before it enters an evaluation:

```sh
flow candidate validate <candidate.yaml>
flow candidate compose <candidate.yaml>
```

Export tuning evidence before model-assisted generation:

```sh
flow eval tuning-evidence <evaluation-id> --output <path>
flow candidate generate <baseline> <path> --output <candidate.yaml> [generation options]
```

For the memory-specific command and review boundary, see
[Generate a model-suggested entry](#generate-a-model-suggested-entry).

After a complete accepted evaluation, preview activation and use the exact proposal digest to apply
it. Most candidates require `superior`. Phase routing requires `qualified`. Use `flow candidate
activate` for activation and `flow activation rollback` to restore an earlier stored revision. The
command forms and persisted contracts are defined in
[Adaptive activation](workflow-spec.md#adaptive-activation).

Activation normally requires a complete evaluation with the `superior` verdict. A phase-routing
activation instead requires a complete `phase-routing-v1` report with the `qualified` verdict.
Flow recalculates the report from the stored schedule and record chain. All applicable quality,
efficiency, and safety constraints must pass. Missing, corrupt, or unavailable evidence stops
activation.

The evaluation candidate must match the live candidate identity. Prompt activation binds the exact
baseline and projected workflows. Agent Skill resource activation binds the unchanged workflow and
the exact baseline and projected package snapshots. Agent Skill package activation binds the
original workflow with no package and the projected workflow with exactly one generated package.
Flow stores the plan digest, terminal record digest, report digest, release criteria, and aggregate
comparison result.

Model-route activation also requires the exact ordered route controls stored in the evaluation.
The controls must match the composed artifact before preview and again before apply. A
child-specialist activation uses the same complete-state proof and requires the evaluation's exact
child candidate and state identities.
A supplemental-memory activation requires the exact composed memory candidate, complete baseline
and candidate states, relationship-set and assessment identities when present, and content-free
evaluation identity.
Phase-routing activation requires the exact composed artifact, evaluation-only `before` state,
candidate `after` state, ordered profile digests, and purpose-specific qualification report.
Delegation evaluation candidates cannot be composed or activated, even when the ordinary comparison
verdict is `superior`.

The activation proof contains no task text, fixture path, assertion, holdout identity, trial record,
or run identifier. It contains aggregate comparison values only.

Preview is read-only. It binds the current activation head, candidate artifact, baseline artifact,
actor, and reason to one proposal digest. Apply requires that exact digest. A source or head change
makes the proposal stale.
