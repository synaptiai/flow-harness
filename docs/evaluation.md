# Reproducible harness evaluation

Flow evaluates complete harness profiles, not models in isolation. A versioned plan binds two
workflow profiles to the same task fixtures, private deterministic verifiers, model configuration,
budgets, retry policy, network policy, seeds, and paired order. It then records each scheduled trial
in a separate immutable evaluation ledger.

This makes a result inspectable and reproducible from committed evidence. It does not make a small
or biased suite statistically representative, turn a seed into provider-side sampling control, or
justify a superiority claim without enough held-out tasks.

## Quick start

Build Flow, then validate the included plan without credentials or filesystem mutation:

```sh
npm run build
node dist/cli/main.js eval validate examples/evaluation/harness-comparison.evaluation.yaml
```

Validation compiles both workflows and fingerprints every admitted source. Running trials contacts
the declared provider and therefore needs its normal Pi credentials:

```sh
node dist/cli/main.js eval run examples/evaluation/harness-comparison.evaluation.yaml
node dist/cli/main.js eval inspect harness-comparison
node dist/cli/main.js eval export harness-comparison --output harness-comparison.json
```

The native Pi example uses one Flow workflow and one native Pi profile:

```sh
node dist/cli/main.js eval validate examples/evaluation/native-pi-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-pi-comparison.evaluation.yaml
```

The native OMP example compares the native Pi and native OMP profiles:

```sh
node dist/cli/main.js eval validate examples/evaluation/native-omp-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-omp-comparison.evaluation.yaml
```

The OMP example requires Linux and an attested official Bun 1.3.14 standard executable for x64 or
arm64. It also requires the two optional OMP packages at version 17.2.12. Validation checks these
local runtime identities. A run also needs the declared provider credentials in the Flow host.
`FLOW_BUN_EXECUTABLE` can select another host path. It cannot add a release attestation.

The Prime Agent example compares one Flow workflow with one fixed Prime profile:

```sh
node dist/cli/main.js runtime prepare prime-agent
node dist/cli/main.js eval validate examples/evaluation/native-prime-agent-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-prime-agent-comparison.evaluation.yaml
```

Prime Agent requires Linux x64, Docker API 1.51, cgroup v2, and the fixed local image.
Preparation builds the image twice. Flow rejects different image, package, closure, or SBOM
identities. A run never builds, pulls, or updates the image.

The default store is `.flow/evaluations/<evaluation-id>/`. `--evaluations-dir <path>` selects an
explicit store for run, inspect, and export. `eval export` refuses to overwrite an existing file.

## Plan contract

An `EvaluationPlan` contains:

- A canonical plan id and a versioned suite.
- One or more tasks partitioned as `tuning`, `regression`, or `holdout`.
- Exactly two profiles in version 1.
- One shared provider, model id, and `thinking` level.
- One exact budget, denied workload-tool network, and zero provider and harness retries.
- Unique non-negative seeds and `paired-alternating-v1` order.
- Comparison thresholds and safety constraints.

The plan must schedule enough holdout pairs to satisfy its superiority threshold:
`minimumPairedTrials` must be no greater than the number of holdout tasks multiplied by the
number of seeds. Because the minimum is positive, every plan therefore needs at least one holdout
task. Tuning and regression pairs do not count toward this threshold.

A profile selects one of these built-in adapters:

- `flow-workflow-v1` selects one admitted workflow or prompt candidate.
- `pi-native-v1` selects the fixed `pi-evaluation-v1` harness configuration.
- `omp-native-v1` selects the fixed `omp-evaluation-v1` harness configuration.

The plan cannot select an executable path, package version, driver path, or protocol version.
Flow resolves these values from its trusted external harness registries.

Paths are portable relative paths below the plan directory. Fixtures may contain only bounded
regular files and directories: symbolic links, special files, `.flow`, path escapes, oversized
trees, and sources that change during admission fail closed. Each workflow must contain a
model-bearing node and exactly match the plan's model and budget. Version 1 rejects workflow,
verifier, skill, and command-tool packages plus agent fresh-recovery settings because their full
identity is not yet represented in the evaluation plan.

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

Flow permits one active Prime container per Docker daemon. It checks host capacity before create
and while the trial runs. A policy failure stops and removes the container.

Flow stores an OCI lease before container start. Recovery reconciles the exact name, nonce, image,
policy, and full container ID. Flow does not start another trial while removal stays uncertain.

Tuning-evidence export accepts only `flow-workflow-v1` profiles. It rejects an evaluation that uses
an external harness profile.

## Tuning-only evidence and prompt candidates

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

## Activation gate

Activation requires a complete evaluation with the `superior` verdict. Flow recalculates the report
from the stored schedule and record chain. All declared safety constraints must pass. Missing,
corrupt, or unavailable comparison evidence stops activation.

The evaluation candidate must match the live candidate identity. The evaluation baseline and
projected workflow must also match the live candidate. Flow stores the plan digest, terminal record
digest, report digest, release criteria, and aggregate comparison result.

The activation proof contains no task text, fixture path, assertion, holdout identity, trial record,
or run identifier. It contains aggregate comparison values only.

Preview is read-only. It binds the current activation head, candidate artifact, baseline artifact,
actor, and reason to one proposal digest. Apply requires that exact digest. A source or head change
makes the proposal stale.
