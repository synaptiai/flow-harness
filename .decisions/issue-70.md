# Decision Journal: Issue #70 — Generate prompt candidates from tuning-only evidence

**Issue**: #70
**Branch**: `codex/issue-70-prompt-generation`
**Started**: 2026-08-09

---

## Context

Flow can export tuning-only evidence from a complete evaluation. Flow can also admit, evaluate,
activate, and roll back a prompt candidate. An operator must create the candidate artifact by hand.

[Pi Autoresearch](https://github.com/davebcn87/pi-autoresearch) separates experiment tools from
domain instructions. It records each trial in an append-only log and keeps measured gains.

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) keeps its base prompt immutable. Its
Continual Harness refines supplemental state through small updates and recorded snapshots.

[OMP](https://github.com/can1357/oh-my-pi) reports model-specific prompt and tool measurements. Its
results support an evaluation gate instead of a feature-count gate.

Flow needs a proposal step with a smaller authority boundary. The existing paired evaluation must
still decide if the proposal is better and safe.

## Functional flows

### Operator flow

Proposal phase:

1. The operator exports tuning evidence from a complete evaluation.
2. The operator selects an exact baseline, evidence files, prompt targets, model, and output path.
3. Flow admits stable source bytes and shows no regression, holdout, or verifier data to the model.
4. One zero-tool model turn proposes bounded prompt replacements.
5. Flow validates the response and creates a normal prompt-candidate artifact.

Review phase:

6. Flow publishes the complete artifact only when the output path does not exist.
7. The operator uses the existing validate, evaluate, activate, and rollback commands.

### System flow

1. Flow hashes the exact generation request and fixed system prompt.
2. Flow runs the selected model with no tools, skills, packages, or workspace reads.
3. Flow requires one strict JSON object with one or more permitted prompt changes.
4. Flow adds trusted baseline, evidence, target, limit, response, and usage identities.
5. Flow runs the normal candidate parser and projection before publication.
6. Flow rechecks every source identity after model execution and before publication.

### Recovery flow

1. A timeout or cancellation aborts the model session.
2. Flow publishes no candidate after an interrupted or invalid model result.
3. A complete temporary file can become the output through one no-overwrite publication step.
4. A later command retires only bounded temporary files that match the generator name pattern.

## Specification

_Captured by the specification-capture skill on 2026-08-09. Source: mixed issue and design review._

### Non-goals

Authority limits:

- The generator does not activate or evaluate a candidate.
- The generator does not change tools, skills, memory, sub-agents, routing, policy, or budgets.
- The generator does not change verifier definitions or evaluation tasks.
- The generator does not read trial workspaces, private assertions, regression tasks, or holdout tasks.

Deferred work:

- The generator does not persist a Pi transcript as authoritative state.
- The generator does not claim that a candidate improves results.
- The generator does not add a native OMP or Prime runtime adapter.
- The generator does not run a multi-candidate autonomous search loop.

### Failure modes

Model-session failures:

- **Timeouts** — Flow aborts the model session and publishes no output.
- **Cancellation** — A pre-commit cancellation returns a bounded error and publishes no output. A post-commit cancellation returns `publication_uncertain`.
- **Partial failures** — Flow publishes only a complete validated artifact and never publishes a partial response.

Input failures:

- **Invalid input** — Flow rejects malformed, oversized, stale, linked, escaped, or inconsistent sources before generation.
- **Invalid model output** — Flow rejects extra keys, invalid JSON, duplicate targets, empty changes, and unpermitted targets.
- **Missing context** — Flow rejects a missing model, provider, credential, baseline, evidence file, target, or project directory.

Execution failures:

- **Dependency outage** — A provider or Pi failure returns a bounded error and publishes no output.
- **Resource exhaustion** — Input bytes, output tokens, output bytes, elapsed time, turns, targets, and candidate count have fixed limits.
- **Source drift** — Flow rechecks source identities after generation and rejects changed sources.

Publication failures:

- **Output collision** — Flow never overwrites a file, symbolic link, directory, or special entry at the output path.
- **Process interruption** — A pre-commit crash cannot expose a partial candidate at the requested output path.
- **Uncertain publication** — A post-commit cleanup failure returns `publication_uncertain`. One complete final file can exist.
- **Uncertain cleanup** — A pre-commit lock-cleanup failure returns `cleanup_uncertain`. No candidate commits, but the lock can remain.

### Interface contracts

Command and model contracts:

- The command is `flow candidate generate <baseline> <evidence>...` with explicit output and model options.
- The command requires an exact candidate id, semantic version, and comma-separated permitted node ids.
- The command accepts one baseline workflow and between one and sixteen tuning-evidence packets.
- The model input contains workflow identity, permitted prompt text, prompt hashes, and parsed tuning packets.
- The model output is one strict JSON object with only a `changes` array.
- Each model change contains one `nodeId` and one nonblank replacement `value`.

Artifact contracts:

- A generated artifact uses the existing `PromptCandidate` API and adds optional generation provenance.
- Hand-written candidates without generation provenance remain valid.
- Generation provenance records the provider, model, thinking level, limits, request digest, response digest, targets, and usage.
- The response digest identifies the canonical validated changes. It does not identify the raw provider transcript.
- The candidate source and identity digest bind the generation provenance.

Publication and dependency contracts:

- The output writer uses a same-directory temporary file and a no-overwrite publication step.
- The application depends on the provider-neutral `AgentExecutor` port, with Pi as one adapter.

## Architecture options

| Option | Description | Benefits | Risks | Decision |
|---|---|---|---|---|
| A | Run a normal agent workflow that writes the candidate | Reuses workflow execution | Exposes workspace tools and mixes proposal with effects | Rejected |
| B | Use one zero-tool generator above the existing agent port | Keeps provider neutrality and a small input boundary | Adds a strict generation contract | Selected |
| C | Add generation to the evaluation adapter | Shares evaluation plumbing | Risks access to private tasks and verifier state | Rejected |
| D | Let the runtime update active prompt state directly | Similar to continual harness refinement | Bypasses paired evaluation and operator review | Rejected |

## Decision

Use option B. Add a Flow-owned generation service above the existing `AgentExecutor` port.

The service renders only the admitted baseline prompts and public tuning packet. It creates a
synthetic zero-tool agent request with a fixed generation system prompt. The selected executor can
use Pi or a future provider-neutral adapter.

The model cannot write the candidate. It can only return a strict replacement proposal. Flow adds
trusted hashes and provenance. Flow then runs the existing candidate projection before publication.

## Component boundaries

| Component | Responsibility | Must not own |
|---|---|---|
| Candidate generation domain | Bounds, canonical request, strict response, provenance, manifest construction | Files, Pi, credentials, evaluation stores |
| Generation application service | Zero-tool execution, result reconciliation, turn and usage checks | Direct file publication or activation |
| Local generation source | No-follow source admission, stable reads, post-model recheck | Model calls or candidate policy |
| Atomic candidate publisher | Complete no-overwrite publication and bounded temporary retirement | Model output interpretation |
| CLI | Operator options, dependency composition, bounded result summary | Candidate identity rules |
| Existing candidate path | Parse, project, evaluate, activate, and roll back | Model generation |

Dependencies remain one-directional:

```text
CLI -> local source and publisher -> generation application -> generation domain
                                  -> AgentExecutor port <- Pi adapter
CLI -> existing candidate admission and projection
```

The domain imports no filesystem, CLI, Pi, provider, or evaluation-store module.

## Data boundary

The generation request can contain these values:

- Baseline workflow id and digest.
- Permitted root agent node ids.
- Exact current prompt text and prompt hashes for permitted nodes.
- Parsed tuning-evidence packets and their source hashes.
- Provider-neutral model and limit settings.

The request cannot contain these values:

- Evaluation suite task instructions.
- Regression or holdout task identities.
- Filesystem verifier assertions or expected values.
- Trial workspace paths or contents.
- Activation state or approval state.
- Ambient project files, skills, tools, packages, or context files.

Tuning reasons are untrusted data. The system prompt tells the model not to treat them as
instructions. The zero-tool boundary and the later evaluation gate limit the effect of a hostile
reason string.

## Limits

Model request limits:

| Resource | Initial limit |
|---|---:|
| Candidates per command | 1 |
| Model turns | 1 |
| Permitted targets | 16 |
| Evidence packets | 16 |
| Rendered input | 1 MiB |

Model result and artifact limits:

| Resource | Initial limit |
|---|---:|
| Raw model output | 64 KiB |
| Model output tokens | 8,192 |
| Replacement prompt bytes | Existing candidate limits |
| Elapsed model time | 300 seconds by default, 24 hours maximum |

## Verification map

Generation contract checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Create one candidate from exact inputs | Behavioral | `npx vitest run test/integration/cli/prompt-candidate-generation.test.ts -t "generates"` | One valid artifact and one bounded summary | Candidate superiority |
| Use only tuning evidence and baseline prompts | Data | `npx vitest run test/unit/adaptation/prompt-candidate-generation.test.ts -t "renders"` | Exact canonical request fixture | Prompt quality |
| Exclude private evaluation data | Security | `npx vitest run test/integration/cli/prompt-candidate-generation.test.ts -t "private"` | Captured model input omits seeded secrets | Protection from a compromised provider |
| Permit only selected root prompts | Error | `npx vitest run test/unit/adaptation/prompt-candidate-generation.test.ts -t "targets"` | Child, command, unknown, and unselected targets fail | Other candidate types |
| Use the normal candidate contract | Contract | `npx vitest run test/unit/adaptation/prompt-candidate.test.ts test/integration/cli/prompt-candidate-generation.test.ts` | Parser and projection accept the result | Evaluation success |
| Record exact provenance | Contract | `npx vitest run test/unit/adaptation/prompt-candidate-generation.test.ts -t "provenance"` | Digests and settings reconcile exactly | Provider determinism |

Failure and authority checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Publish no invalid result | Error | `npx vitest run test/unit/application/generate-prompt-candidate.test.ts` | Invalid, failed, and truncated results return no candidate | Provider availability |
| Preserve files and reject collisions | Filesystem | `npx vitest run test/unit/infrastructure/fs/local-prompt-candidate-generation.test.ts` | Sources stay unchanged and output collision fails | Multi-host locking |
| Enforce all generation limits | Boundary | `npx vitest run test/unit/adaptation/prompt-candidate-generation.test.ts test/unit/application/generate-prompt-candidate.test.ts` | Exact-limit accepts and one-over rejects | Cost prediction |
| Require later paired evaluation | Integration | `npx vitest run test/integration/cli/prompt-candidate.test.ts -t "evaluates its exact projection"` | A generated candidate keeps its identity through run, inspect, and export | A generated candidate is superior |
| Never activate automatically | Integration | `npx vitest run test/integration/cli/prompt-candidate-generation.test.ts -t "does not activate"` | Activation state remains absent | Manual activation result |

Audit and release checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Support offline audit | Contract | `npx vitest run test/integration/cli/prompt-candidate-generation.test.ts -t "generates one auditable candidate"` | Offline validation shows the generation identity | Raw provider transcript retention |
| Cover adversarial and interruption paths | Adversarial | `npx vitest run test/unit/infrastructure/fs/local-prompt-candidate-generation.test.ts test/integration/cli/prompt-candidate-generation.test.ts && npm run build && npx vitest run --config vitest.runtime.config.ts test/runtime/prompt-candidate-publication.runtime.test.ts` | Race, link, invalid UTF-8, abort, collision, and child-process crash cases pass | Power-loss testing on every filesystem |
| Keep live provider tests optional | Configuration | `npm run test:live` | Missing settings or authentication produce an explicit skip | Provider uptime |

## Implementation order

Domain and application:

1. Add failing domain tests for request rendering, response parsing, targets, bounds, and provenance.
2. Implement the pure generation domain contract.
3. Add failing application tests for the zero-tool call and failure reconciliation.
4. Implement the application service through `AgentExecutor`.

Files, CLI, and release:

5. Add failing filesystem tests for stable inputs and atomic no-overwrite publication.
6. Implement the local source and publisher.
7. Add failing CLI tests for the complete operator flow.
8. Implement `candidate generate` and its dependency composition.
9. Update public documents and run the Simplified Technical English check.
10. Run focused, full, coverage, runtime, package, and dependency gates.
