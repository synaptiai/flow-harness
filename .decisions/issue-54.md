# Decision Journal: Issue #54 — Let agent nodes execute bounded commands under Flow controls

**Issue**: #54 | **Branch**: `codex/issue-54-agent-exec` | **Started**: 2026-08-08
**Base dependency**: PR #53, commit `0eb6905`

---

## Context and flow map

Flow owns sandboxed deterministic command execution, but its embedded agent runtime receives only
Flow-owned `read`, `ls`, and hash-anchored `edit` tools. A coding agent cannot run a compiler, test,
formatter, or version-control inspection while it reasons. Enabling Pi's ambient bash tool would
restore capability by surrendering Flow's exact policy, durable evidence, budget, and recovery
boundaries to a provider-shaped session implementation.

### Author flow

1. The workflow author includes `exec` in one agent node's explicit `tools` list.
2. Validation rejects unknown/duplicate tools and rejects `exec` combined with proof-safe fresh
   recovery.
3. Compilation freezes the selection into the workflow and child-workflow digests.
4. Omission retains the existing no-execution behavior.

### Agent flow

1. The active model calls `flow_exec` with one executable, an argv array, and an optional deadline.
2. Flow validates all bounds and hashes the complete normalized request.
3. The policy broker authorizes exactly `process.execute` for that request.
4. Flow durably prepares the authorized command before any project process can start.
5. The existing command executor invokes the existing SRT sandbox with `shell: false`.
6. Flow durably settles bounded output, full-stream hashes, status, duration, and sandbox provenance.
7. The tool returns that result to the same model loop; a non-zero exit is evidence the model can
   inspect, not an implicit workflow transition.

### Operator flow

1. `flow inspect` exposes each prepared/settled agent command under its node attempt.
2. An open command marks the interrupted attempt uncertain and prevents automatic replay.
3. A settled command's retained output is visible in resource consumption even when the outer agent
   attempt never reaches a terminal event.

### System flow

```text
model call -> strict flow_exec schema -> exact operation digest -> policy decision
                                                          |
                                                          v
durable prepare -> SRT argv execution -> durable settlement -> model tool result
       |                                      |
       v                                      v
recovery uncertainty                    replay + artifact budget
```

## Coupling analysis

- The workflow domain owns only the portable `exec` selection and input-facing limits.
- The policy domain already owns `process.execute`; its operation digest must become mandatory for
  exact execution authorization just as it is for writes.
- The run domain owns command protocol/events, per-attempt command projections, replay invariants,
  terminal-policy reconciliation, failure side-effect consistency, and artifact charging.
- The application owns write-ahead publication callbacks and scheduler response to mid-agent
  artifact exhaustion.
- The Pi adapter owns only the model-facing `flow_exec` schema/result formatting and translates it
  to an application command-execution port.
- The existing command executor and SRT sandbox remain the single host process path. No second
  spawn implementation or Pi bash backend is introduced.
- Production composition injects the same command executor into deterministic nodes, verifiers, and
  agent command calls. Dependency direction remains CLI/infrastructure -> application ports ->
  domain; the domain imports no Pi, SRT, or Node process types.
- The high-coupling file is the run reducer because it is the replay authority. New logic must be
  isolated around a typed command projection instead of adding scheduler-owned counters or
  executor-local durable state.

## Research and challenged assumptions

- The installed Pi runtime is `@earendil-works/pi-coding-agent@0.84.0`. Its bash tool accepts a raw
  command string plus optional timeout, spawns through a configurable shell, streams combined
  output, kills process trees, tail-truncates results, and writes full output to a temporary file.
  Its pluggable `BashOperations` seam is useful adapter precedent, but the shell-string and temp-file
  semantics are not Flow's public or durable contract. See
  <https://github.com/earendil-works/pi>.
- OMP separates tool approval tier from user policy, defaults unknown tools to `exec`, can force a
  prompt for critical destructive shell patterns, and fails closed when a required UI is absent.
  It also supports ordered bash allow/prompt/deny patterns and tool-output artifact spill. These are
  strong precedents for later dynamic approval and storage slices, but combining them with first
  execution would add approval, shell parsing, and artifact-store state machines at once. See
  <https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md>,
  <https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md>, and
  <https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/bash.ts>.
- Prime Agent makes persistent IPython the model-facing control environment and supports `%%bash`,
  kernel restart, best-effort state revival, and daemon command idempotency journaling. Its own
  architecture explicitly states that workers and kernels provide lifecycle containment, not a
  security sandbox, and the README warns that model code runs with user permissions. Flow should
  reuse the write-ahead uncertainty principle, not the host-authority model. See
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/tools/ipython.ts>,
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/modes/daemon/command-recovery-journal.ts>,
  and
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>.
- Node's direct process APIs preserve executable and argv boundaries when no shell is enabled;
  redirection, globbing, substitution, and compound shell syntax are consequently absent. This is
  a deliberate safety and portability boundary, not a missing parser. See
  <https://nodejs.org/api/child_process.html>.
- Anthropic Sandbox Runtime is designed to contain agent commands with OS filesystem/network
  restrictions, but it is a research preview with documented platform limitations. Flow must keep
  its existing fail-before-spawn degradation checks and must not market SRT as VM-grade isolation.
  See <https://github.com/anthropic-experimental/sandbox-runtime>.
- The initial assumption that terminal agent evidence could carry command receipts was disproved by
  the crash window after command effects and before terminal publication. A separate write-ahead
  command protocol is required.
- The assumption that all successful command output could wait for terminal artifact accounting was
  disproved by interrupted outer attempts. Command settlement must charge retained bytes directly.

## Gap-priority calculation

Scores use a 1–5 ordinal scale and balanced weights: user value 30%, dependency leverage 25%,
existing reuse 15%, safety tractability 15%, and provider neutrality 15%. The model is a transparent
decision aid, not an empirical benchmark.

| Remaining gap | Weighted score |
| --- | ---: |
| Agent command execution | **4.85** |
| Dynamic agent-tool approval | 4.00 |
| Workflow packages | 3.90 |
| General failure/fallback retries | 3.70 |
| Managed/VM sandbox backend | 3.60 |
| Adaptive harness | 3.35 |
| External artifact storage | 3.15 |

## Approaches considered

| Approach | Simplicity | Flexibility | Provider neutrality | Recovery/safety | Effort | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Pi bash tool with Flow operations adapter | High | High shell surface | Low | Low without a new journal | Medium | Rejected |
| Native Flow argv tool plus durable command journal | Medium | Medium by design | High | High | Large | **Selected** |
| OMP-style raw shell, dynamic approval, and spill together | Low | Very high | High | Medium until three protocols exist | Very large | Defer into separate slices |
| Prime-style persistent IPython control plane | Low | Very high | Medium | Low under current Flow threat model | Very large | Rejected for this harness boundary |

Weighted design scores remained stable under balanced, security-heavy, and portability-heavy
profiles:

| Approach | Balanced | Security-heavy | Portability-heavy |
| --- | ---: | ---: | ---: |
| Native Flow argv tool | **4.85** | **4.65** | **4.85** |
| OMP-style shell/approval bundle | 4.10 | 3.85 | 4.05 |
| Prime persistent REPL | 3.25 | 2.70 | 3.10 |
| Pi bash adapter | 3.15 | 2.80 | 2.80 |

## Decision

Implement a provider-neutral `exec` selection whose Pi presentation is `flow_exec`. Accept an exact
executable and argv rather than a shell program. Route execution through the existing application
command port, production SRT sandbox, and bounded command evidence. Add a write-ahead durable agent
command protocol so authorization is committed before spawn and complete evidence is settled after
execution. Charge retained command stdout/stderr on settlement. Treat any open command as uncertain,
and prohibit proof-safe fresh recovery for exec-capable agents.

Dynamic per-call approval, configurable command patterns, raw shells, environment/cwd overrides,
PTY/background jobs, full-output storage, remote execution, and persistent REPL state remain
separate capabilities.

## Specification

_Captured by specification-capture skill on 2026-08-08. Source: roadmap, Issue #54, user-approved
autonomous implementation mandate, and primary-source comparison._

### Non-goals

- Does not expose Pi/OMP ambient bash, a raw shell string, shell expansion, pipelines, redirects,
  substitutions, or compound commands.
- Does not accept environment overrides, arbitrary working directories, stdin, PTY, interactive or
  background processes, or persistent shell state.
- Does not add dynamic per-call human approval, command-pattern policy, approval caching, or a yolo
  mode. Explicit workflow selection is the authority boundary for this slice.
- Does not add network or credential access, an artifact store, spill files, download, retention,
  garbage collection, or full-output recovery beyond the bounded retained evidence.
- Does not claim arbitrary command effects are replay-safe, reconcile arbitrary workspace changes,
  or allow proof-safe fresh retry for an execution-capable agent.
- Does not add Windows descendant containment, VM-grade isolation, remote/managed execution,
  executable capability packages, or a persistent Python/REPL control plane.
- Does not change deterministic command-node or verifier semantics except to reuse their executor
  through a provider-neutral application port.

### Failure modes

- **Timeouts** — The per-command deadline and outer node deadline share cancellation. On supported
  Linux execution, expiry terminates the PID-namespace process tree, settles bounded partial evidence
  when available, and reports a typed tool failure. No automatic command replay occurs.
- **Partial failures** — A prepare append failure prevents spawn. A settlement append failure after
  execution leaves an open command, poisons the active command recorder, prevents a valid terminal
  node event, and makes recovery uncertain.
- **Invalid input** — Empty/oversized executable or args, too many args, NUL, unknown fields,
  fractional/non-positive/oversized deadlines, duplicates, and `exec` plus fresh recovery reject
  before policy authorization or process preparation.
- **Missing context** — An exec-capable node without a command journal or command executor fails
  before starting the Pi session. Missing/degraded sandbox support fails before the project process
  starts.
- **Dependency outage** — No external service participates in local execution. A missing executable
  becomes bounded failed command evidence; a missing sandbox dependency fails closed before spawn.
- **Resource exhaustion** — Each stream is bounded by the existing command cap. Settlement charges
  retained UTF-8 bytes exactly once; equality/overshoot aborts the remaining active agent session,
  permits its terminal outcome to settle, and then uses existing run exhaustion semantics.
- **Cancellation** — Cancellation terminates the current Linux PID-namespace process tree and Pi
  session. Prepared but unsettled commands remain uncertain; settled evidence is never replayed.
- **Concurrency** — `flow_exec` is sequential within one Pi session. Workflow-level node waves and
  detached-run capacity retain their existing independent bounds.
- **Unsupported platform** — macOS/Windows or a degraded Linux PID-namespace backend returns a
  bounded agent-command failure before spawning the requested project process. Ordinary command
  nodes retain their separately documented platform support.
- **Tampering** — Missing/reordered/duplicate command identifiers, altered request digests,
  mismatched policy decisions, invalid output hashes, inconsistent error/evidence pairs, terminal
  outcomes with open commands, and understated artifact totals reject replay.

### Interface contracts

Workflow selection:

```yaml
agent:
  tools: [read, edit, exec]
```

Model-facing tool input:

```json
{
  "executable": "npm",
  "args": ["test", "--", "test/unit/example.test.ts"],
  "timeoutMs": 120000
}
```

- Tool name is `flow_exec`; executable is 1–1,024 UTF-8 bytes with no NUL; at most 64 argv entries,
  each at most 8,192 UTF-8 bytes and 32 KiB aggregate; deadline defaults to 120,000 ms and is a
  positive safe integer no greater than 600,000 ms.
- The normalized request is `{version:1, executable, args, timeoutMs}` and its lowercase SHA-256
  digest binds policy and durable events.
- `process.execute` requires that exact digest. Its target is the executable while the sandboxed
  execution boundary is the node workspace.
- A node start declares command protocol `flow.agent-commands/v1`. Prepared events carry a stable
  command id, attempt-local sequence, exact request, digest, and allowed policy decision. Settled
  events carry exactly one matching success/failure outcome with bounded `CommandEvidence` and/or
  `NodeFailure`.
- Each agent command settlement requires sandbox backend/version/profile/policy provenance,
  `processContainment: linux-pid-namespace`, and a reconciled termination status, plus independent
  SHA-256 hashes and UTF-8 byte counts for the retained stdout/stderr prefixes. The
  full-stream hashes remain authoritative for complete output, including bytes beyond truncation.
- Commands are serialized within an attempt: a preparation must settle before the next preparation.
  The deadline begins before sandbox preparation and the executor does not settle an interrupted
  process until its outer POSIX process group is confirmed absent or containment failure is
  reported. Linux Bubblewrap's verified PID namespace prevents descendants from escaping that
  lifecycle. Late sandbox preparation is released but cannot spawn after the absolute deadline.
- Per-node state exposes ordered commands. Interrupted-attempt state retains its ordered commands.
  Terminal agent evidence retains the ordinary policy list and must reconcile every prepared
  command to the same unused allowed `process.execute` decision.
- The application command-execution port accepts only the normalized request plus ordinary node
  context and returns the existing `NodeExecutionOutcome`; production uses the same command
  executor instance as command and command-verifier nodes.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Selection, compilation, digest, child/transport preservation | Contract | `npx vitest run test/unit/workflow/compiler.test.ts test/unit/workflow/child-node-compiler.test.ts -t "exec"` | `exec` compiles immutably, changes digest, survives child compilation; omission works | Runtime execution |
| Strict executable/argv/deadline input | Error/contract | `npx vitest run test/unit/domain/agent-command.test.ts test/unit/infrastructure/pi/workspace-read-tools.test.ts` | Every bound and unknown field rejects before policy/executor; exact boundary values pass | Shell syntax |
| Policy and production sandbox | Integration/security | `npx vitest run test/unit/policy/broker.test.ts test/unit/infrastructure/policy/workspace-policy-broker.test.ts test/unit/infrastructure/pi/workspace-read-tools.test.ts test/integration/process/command-node-executor.test.ts` | Exact execute digest required; undeclared calls deny; injected executor uses sandbox; degradation prevents spawn | VM isolation or network enablement |
| Durable prepare/settle and replay | Domain/adversarial | `npx vitest run test/unit/run/agent-command-reducer.test.ts` | Valid histories project exactly; missing/reordered/duplicate/tampered histories reject | Automatic reconciliation of arbitrary effects |
| Model result and inspectable evidence | Integration | `npx vitest run test/unit/infrastructure/pi/pi-agent-executor.test.ts test/unit/infrastructure/pi/workspace-read-tools.test.ts test/integration/cli/main.test.ts -t "agent command"` | Nonzero/success output returns to loop; inspection exposes streams, hashes, status, duration, provenance | Full-output storage |
| Timeout, cancellation, crash/publication failure | Application/runtime | `npx vitest run test/unit/application/run-workflow-agent-command.test.ts test/unit/infrastructure/pi/agent-command-recorder.test.ts test/integration/process/command-node-executor.test.ts` | Process tree ends; prepare failure does not execute; settle failure leaves uncertainty and no automatic replay | Resuming the same model call |
| Artifact budget accounting | Domain/application | `npx vitest run test/unit/run/agent-command-reducer.test.ts test/unit/application/run-workflow-agent-command.test.ts -t "artifact|charges"` | Multibyte output charges once before terminal agent evidence; equality/overshoot exhausts | Physical disk bytes |
| Fresh recovery refusal | Recovery | `npx vitest run test/unit/workflow/compiler.test.ts test/unit/run/attempt-recovery-reducer.test.ts -t "exec|execution-capable"` | `exec` plus fresh recovery rejects; open commands never replay | Safe retry classification for arbitrary commands |
| Attached/detached/child behavioral matrix | Integration | `npx vitest run test/integration/cli/main.test.ts test/integration/supervisor/worker.test.ts -t "agent command"` | Attached CLI, detached worker, child ledger, and inspection preserve behavior and evidence | Hosted TUI or remote execution |
| Public contract and example | Docs/scaffold | `npm run build && node dist/cli/main.js validate examples/agent-command.workflow.yaml` | README, architecture, recovery, workflow/testing/roadmap docs, and example match scope/nonclaims | Dynamic approval, shell, spill, VM |

## Planned RED -> GREEN -> REFACTOR sequence

1. [x] Compile and transport the fourth agent tool selection while rejecting fresh recovery.
2. [x] Define and enforce the exact `flow_exec` input and policy-digest boundary.
3. [x] Add write-ahead command events and adversarial reducer invariants.
4. [x] Reuse the command executor through a provider-neutral application port.
5. [x] Integrate the tool into the Pi loop and reconcile terminal policy evidence.
6. [x] Charge settled output and stop on mid-agent artifact exhaustion.
7. [x] Cover timeout, cancellation, append failure, open-command recovery, and side-effect status.
8. [x] Complete attached, detached, child, and inspection paths.
9. [x] Update every public document and executable example.
10. [ ] Run focused, full, clean-room, mutation, holdout, and adversarial verification.

## Adversarial review resolutions

The first independent skeptic/verifier pass found seven material gaps. All were accepted and fixed:

- Replay now rejects a second preparation while an earlier command is unresolved and retains an
  additional settlement-order guard.
- Failure codes, side-effect states, and evidence must form one consistent state; pre-spawn timeout
  and cancellation are the only new evidence-free interruption cases.
- Interrupted process execution waits for leader exit and confirmed process-group disappearance,
  preserves SIGKILL escalation after leader close, and fails uncertainly if containment cannot be
  confirmed.
- Truncated retained stdout/stderr prefixes carry their own hashes and byte counts, independently
  of the complete-stream hashes.
- Per-command deadlines start before sandbox preparation instead of after it.
- Model-visible command results include sandbox backend, version, profile, and policy digest.
- Dedicated attached CLI, isolated child, exact inspection, and authenticated detached-worker
  tests now exercise the durable command protocol through production orchestration boundaries.

The second independent pass initially found four additional gaps. A verification pass then rejected
the first attempted PID-polling fix and found two more related defects. The final resolution is:

- Raw PID/PPID polling was removed because reparenting, zombies, PID reuse, and synchronous `ps`
  scans cannot provide safe containment. Agent commands instead require a verified Linux SRT
  Bubblewrap PID namespace plus parent-death control before spawn; macOS fails closed.
- Sandbox preparation is raced against the command deadline and checked against an absolute
  monotonic expiry immediately before spawn. A preparation adapter that ignores cancellation cannot
  create late spawn authority; late preparation is released.
- Replay requires the truncation flag to agree with the relationship between the retained-prefix
  hash and complete-stream hash, rejecting forged complete/truncated evidence.
- Replay binds termination-related failure codes to durable containment and termination facts.
- Public cancellation and quota documentation now includes command reservations and distinguishes
  logical artifact accounting from physical storage, spill, and disk limits.

The final adversarial gate found two additional pre-spawn and settlement-precedence defects. Both
were accepted and fixed:

- Linux preparation now resolves one canonical, executable, root-owned Bubblewrap binary outside
  the workspace through root-owned non-writable ancestors, passes that absolute path into SRT, and
  rejects any returned descriptor that does not bind it. A workspace-controlled `bwrap` earlier in
  model-visible `PATH` cannot impersonate the containment boundary.
- Command evidence records termination independently of the final error code. If process-tree
  termination is unconfirmed and sandbox cleanup also fails, `command_termination_failed` remains
  primary, `terminationStatus: unconfirmed` remains durable, and cleanup is bounded secondary
  context.

The subsequent holdout rerun found that textual lifecycle-token checks did not bind the complete
launch descriptor and that an unconfirmed command settlement could still be followed by terminal
agent success. Both findings were accepted:

- Flow now accepts only SRT's canonical quoted argv grammar beneath an exact `/bin/bash -c` outer
  launcher. It position-checks the trusted Bubblewrap executable, initial parent-lifecycle options,
  secure PID/user/capability/process-mount tail, single command boundary, and inner shell. Shell
  operators, substituted launchers, and lifecycle-looking option values fail before spawn.
- Agent command evidence now persists `aborted` separately from `timedOut` and replay requires
  exactly one interruption cause whenever termination is required. An unconfirmed settlement closes
  command authority, aborts the Pi session, forces uncertain attempt failure, and makes terminal
  success invalid under replay.

The next falsification round found that a preceding multi-operand Bubblewrap option could still
consume a lifecycle-looking token and that replay did not yet apply the fatal latch to later command
preparation. The complete resolution is:

- Flow parses every pre-boundary Bubblewrap option through an explicit reviewed arity allowlist.
  Required lifecycle controls must be parsed zero-arity options in the exact secure suffix; operand
  values never count, and unknown future options fail closed until reviewed.
- The reducer rejects every `node_agent_command_prepared` after an unconfirmed termination
  settlement, matching the live recorder's closed audit in addition to the existing terminal-success
  refusal.
