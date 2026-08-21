# Delivery roadmap

The roadmap is organized around externally verifiable capability gates rather than dates.

Gates 0–2 are implemented. Gate 3 includes policy, approvals, hash-anchored edits, durable effect
receipts, and sandboxed argument-vector command execution.

Gate 4 includes recovery, same-host ownership, effect reconciliation, durable budgets, detached
workers, bounded queueing, cancellation, replay, and worker adoption.

Gate 5 includes conditions, joins, bounded concurrency, loops, graph approvals, typed results,
verifiers, child workflows, and isolated optimization promotion.

Gate 6 includes Agent Skills, verifier packages, command tool packages, workflow packages, inert
bundles, content-addressed installation, publisher-authenticated OCI acquisition, challenge-scoped
private registry credentials, audit, removal, and offline recovery.

Deterministic inert bundles, content-addressed installation, and exact publisher-authenticated OCI
installation are implemented.

Flow supports paired harness evaluation with fixed controls, fresh fixtures, private verification,
digest-chained evidence, offline reports, and constrained comparison.

Gate 7 includes tuning-only prompt and Agent Skill candidates. It includes zero-tool prompt,
selected-resource Agent Skill, and bounded Agent Skill package generation. It also includes exact
prompt overlays and authority-preserving skill-resource projections. New single-skill package
projections, paired evaluation, reviewed activation, durable run snapshots, and rollback are also
implemented.

Gate 8 remains the delivery priority. Slices 8.1 through 8.4 provide an installable preview,
source-build diagnostics, guided foundation and provider checks, and one useful bounded
provider-backed coding change.

Gate 9 adds bounded long-horizon context and semantic code feedback. Gate 10 adds standards-based
executor interoperability and evidence-gated specialized execution. Gate 8 must close before a
Gate 9 or Gate 10 experiment becomes a default user path.

Remaining targets include executable extensions, remote or multi-user UI hosts, and stronger
isolation.
Each first-party host accepts exact A2UI-profile presentation packages.
These packages arrange a closed Flow-owned widget catalog. Catalog v2 also adds bounded attributed
static notes without behavior or run authority. Explicit
signed project metadata now provides local-clock
expiry, revocation, exact-target admission, and monotonic rollback refusal. An explicit signed
public channel stages inert candidates for reviewed activation. A standards-based TUF repository
can optionally watch one already-installed package and atomically apply patch updates. Same-major
minor updates require explicit policy. A separate finite command can install one exact first
version and then terminate.

The operator-selectable container command profile is implemented behind the Flow-owned sandbox
port. Its pinned Linux x64 runtime gate passed in hosted CI. This profile is a shared-kernel
containment milestone. It is not VM-grade or multi-tenant isolation.

## Gate 0: Repository foundation

- Architecture, capability ownership, failure modes, and non-goals are documented.
- The toolchain provides formatting, linting, type checking, tests, builds, and reproducible installation.
- Contribution and security guidance exist before accepting external packages.

## Gate 1: Executable graph vertical slice

- A workflow is parsed and rejected with structured diagnostics when invalid.
- Dependencies determine node execution order without model discretion.
- Node and run transitions are appended to a durable ledger before advancement.
- A failed node prevents dependent nodes from executing.
- A real Pi adapter implements the production agent-execution boundary.
- The CLI builds, exposes help, validates a workflow, and exercises a sample run path.

## Gate 2: Evidence-based completion

- Goals and criteria have versioned contracts.
- Evidence is linked to a run, node, attempt, and criterion.
- Deterministic verification controls acceptance.
- Evaluators are isolated from implementation rationale and workspace mutation.
- Missing or inconclusive evidence cannot become success.

## Gate 3: Policy and safe effects

- All model-requested tools pass through a Flow-owned broker.
- Policy classifies reads, writes, execution, network, credentials, and destructive operations.
- Approval binds an exact operation and expires predictably. *(Implemented for deterministic command nodes and each live agent `exec` request.)*
- Timeouts terminate Linux PID-namespace process trees or POSIX process groups and record partial output.
- Side-effect uncertainty blocks automatic retry.
- Full-SHA hash-anchored edit of an existing UTF-8 file records before/after effect receipts, coordinates cooperating same-host Flow processes, and fails closed on stale content. *(Implemented.)*
- A Flow-owned sandbox port isolates command execution from the selected backend. *(Implemented for SRT and the operator-selected container command profile.)*
- The initial fixed profile denies network and ambient credentials. It permits workspace work,
  protects durable state, and records provenance. *(Implemented for native SRT and
  `flow-container-v1`. The container profile also denies local TCP and Unix socket creation. The
  real Linux x64 container runtime gate passed in hosted CI.)*
- Missing or degraded containment fails before command spawn. *(Implemented; agent `exec` currently requires verified Linux PID-namespace containment.)*
- Explicit agent `exec` uses the same sandboxed command executor, exact process authorization, optional per-call human approval, write-ahead prepare/settle events, bounded output evidence, and replay-derived artifact accounting. *(Implemented.)*
- Container and managed sandbox adapters can satisfy higher-isolation deployment profiles. *(The
  shared-kernel Docker adapter is implemented. VM-grade and managed backends remain planned.)*

## Gate 4: Recovery and long-running work

- Runs resume from authoritative events after process interruption. *(Implemented at committed node boundaries.)*
- Only one same-host process owns append and execution for a run; exited ownership is recoverable. *(Implemented.)*
- Flow-owned workspace edits persist typed prepare/settle evidence across interruption. *(Implemented.)*
- Supported open edits are reconciled before any future retry decision. *(Implemented for exact hash/mode observation under the shared target lock.)*
- Interrupted agent attempts may start a fresh numbered attempt only under a persisted opt-in, bounded attempt cap, and replay proof that every effect was not applied. *(Implemented for read-only and `flow.effects/v1` edit attempts; applied, unknown, open, legacy writable, and unaccountable resource states remain blocked.)*
- A supervisor owns detached workers, health, cancellation, and event replay. *(Implemented with strict project/operator capacity configuration, durable bounded FIFO admission, explicit accepted/queued/rejected outcomes, queued cancellation without execution, authenticated restart adoption, policy binding, and bounded cursor replay.)*
- Budgets cover attempts/node starts, model tokens, reported cost, active execution time, and retained executor-output artifacts. *(Implemented with replay-derived UTF-8 artifact accounting, terminal equality/overshoot settlement, attached/detached inspection, concurrency-wave quiescence, and child ceiling reservation plus exact tree roll-up. External artifact storage, spill, download, retention, and garbage collection remain separate.)*
- Human wait states survive client detachment. *(Implemented for command and evidence-bound graph waits plus live attached/detached agent command calls; opaque continuation after the owner process dies remains separate.)*

## Gate 5: Graph and loop completeness

- Exact-output conditions, guarded branches, omission propagation, and explicit joins are executable and replay-safe. *(Implemented; arbitrary expressions are not.)*
- Concurrent static DAG fork/join is executable with a strict per-run node limit and deterministic quiescent waves. *(Implemented; dynamic fan-out is not.)*
- Bounded loops, general approval nodes, and general verifier nodes are executable. *(Implemented through finite acyclic loop expansion, pure evidence-bound approval nodes, and typed verifier nodes with sandboxed command plus evidence-isolated zero-tool model drivers. Strict local versioned verifier packages are implemented in Gate 6.)*
- Typed results publish bounded canonical JSON from exact durable evidence and compose with conditions, approvals, model verifiers, and loop checks. *(Implemented with a closed schema subset, strict duplicate-key/I-JSON parsing, RFC 8785 canonicalization, source/schema/value hashes, attached and detached execution, inspection, and replay verification.)*
- Optimization loops declare a metric, baseline, direction, invariants, candidate bound, stagnation rule, and rollback strategy. *(Implemented through finite acyclic candidate/check expansion, strict typed numeric evaluation, exact scalar invariants, persisted path deltas, stale affected-path refusal, write-ahead promotion with rollback blobs, typed reconciliation, accept-best state, attached/detached execution, and replay-verified inspection.)*
- Child runs use isolated workspaces and typed results. *(Implemented with embedded bounded workflows, deterministic child identities, independent JSONL histories, exact parent snapshots through a portable reflink-or-copy backend, tree-wide budget admission/accounting, cancellation and recovery, typed result composition, and attached/detached execution. Ordinary child changes are discarded; only compiler-registered optimization candidates may enter the bounded promotion protocol. Native snapshot backends remain.)*
- Packages cannot bypass graph dependencies or joins.

## Gate 6: Capability ecosystem

- Agent Skills packages are discovered with progressive disclosure. *(Implemented for strict local and digest-pinned installed project packages with explicit per-node selection, immutable attached/detached/child/recovery snapshots, and bounded `skill://` reads.)*
- Package provenance, digest, license, permissions, compatibility, trust state, and observed use are recorded. *(Implemented with permission requests that cannot widen Flow authority.)*
- Evaluator contributions use versioned manifests. *(Implemented for strict local and digest-pinned installed command/model verifier packages with exact version selection, immutable snapshots, and digest-bound verdict evidence.)*
- Tool contributions use versioned manifests. *(Implemented for strict local and digest-pinned installed declarative command tools with exact per-agent selection, closed Flow-owned data-position command profiles, typed scalar-to-literal-argv rendering, immutable snapshots, independently reconciled raw-exec authority, and reuse of the existing policy/approval/sandbox/journal boundary. Executable package code remains deferred.)*
- Capability distribution is deterministic, reviewable, and provider-neutral. *(Implemented.)*
  Flow supports strict `.flowpkg` packing and explicit public HTTPS plus SHA-256 installation. It
  also supports exact digest-only OCI installation, optional challenge-scoped private credentials,
  and offline Sigstore publisher verification. The store uses content-addressed blobs,
  deterministic lock state, fail-closed collisions, local audit commands, and network-free
  execution.

  Explicit offline-imported signed metadata adds expiry, revocation, exact-target admission, and
  rollback refusal. Signed-channel discovery adds bounded inert candidate staging. A
  standards-based TUF repository adds explicit local root trust, threshold rotation, and
  freshness. It also adds consistent snapshots, bounded delegated targets, atomic offline
  generations, reviewed activation, and explicit atomic same-surface replacement. Replacement uses
  two-target transition metadata and retains old immutable content for prior readers. The gate also
  includes an optional no-overlap check scheduler and a foreground single-package watcher. The
  watcher binds an exact installed package and publisher, defaults to patch-only updates, can
  explicitly allow same-major minor updates, and stops on replacement uncertainty. Mutable tags and
  private credentials remain deferred. A finite one-shot first activator binds one exact missing
  package, exact version, exact publisher, full interval, and check limit. It requires current
  active Flow metadata, consumes durable waiting, prepared, and settled states, and cannot reinstall
  a removed settled package.
  Explicit retired-blob maintenance now provides deterministic preview, digest-bound apply,
  bounded physical storage, generation-pinned readers, and interruption settlement. Online root
  bootstrap, major or policy-package replacement, automatic rollback, and background collection
  remain deferred.
- Workflow contributions use versioned manifests. *(Implemented for inert exact-version workflow source with packaged root/child selection, ordinary recursive compilation, immutable transitive snapshots, deterministic bundle distribution, detached execution, and fail-closed recovery. Parameterized templates and executable modules remain deferred.)*
- Policy contributions use versioned manifests.
  Flow implements strict local and digest-pinned installed inert narrowing packages.
  Operator requirements and project additions use exact selection.
  Deterministic conjunction produces immutable snapshots before admission.
  Detached, child, and recovery paths remain fail closed.

- Flow has a stable, bounded first-party terminal presentation host. *(Implemented with a
  renderer-neutral Flow document, terminal-safe text, durable cursor replay, and steering through
  the existing approval and cancellation controls.)*
- Flow has a stable, bounded first-party local browser presentation host. *(Implemented. It uses
  explicit IPv4 loopback, a fragment-held 256-bit capability, and fixed offline assets. It also has
  authenticated document streaming, current-action binding, reload, and responsive Chromium
  evidence.)*
- Bounded static content is implemented through the attributed A2UI catalog-v2 note leaf.
  Executable, dynamic, remote, or package-rendered UI contributions remain planned. The A2UI-profile
  presentation manifest is implemented for both first-party presentation hosts. A local
  ACP v1 stdio bridge now carries the same public presentation and exact controls to an editor. It
  uses captured policy, bounded peer waits, durable close/cancel settlement, and restart replay.
  Remote, multi-user, reverse-proxied, ACP v2, A2A, and AG-UI hosts remain separate work.
- The first-party host does not admit package markup, code, or renderers.
- OMP-inspired high-value tools are benchmarked before adoption.

## Gate 7: Adaptive harness

- Flow can produce evidence-bound prompt candidates. *(Implemented from canonical tuning-only
  evidence with exact prompt-only manifests and zero-tool model generation.)*

- Flow can generate and validate one evidence-bound Agent Skill resource candidate. It can evaluate,
  activate, and roll back that candidate against its exact immutable baseline package. *(Implemented
  with an explicit existing-resource allowlist and one zero-tool model turn. Activation uses
  operator preview and exact apply.)*

- Flow can generate and validate one evidence-bound Agent Skill package candidate for a workflow
  that selects no skill. *(Implemented as a bounded review directory and one zero-tool model turn.
  The operator owns a content-free blueprint for 1–16 inert UTF-8 files. Exact paired evaluation,
  reviewed activation, durable offline execution, and rollback restore the package-free baseline.)*

- Flow can validate and compose one static model-routing candidate for one existing root agent.
  *(Implemented with exact before and after tuples, paired profile controls, durable evaluation,
  reviewed effective-state activation, offline execution, and state-digest rollback.)*

- Flow can validate and compose one child-specialist candidate for one agent in one embedded child
  workflow. *(Implemented for one instructions replacement or one exact selection of Agent Skills
  already present in the immutable package closure. Complete-state paired evaluation, reviewed
  activation, attached child execution, offline evidence, and state-digest rollback use the
  existing effective harness.)*

- Flow can validate and compose one supplemental-memory candidate for one existing root or embedded
  child agent. *(Implemented for one immutable bounded add, replace, or remove operation. The
  existing effective harness owns complete evaluation, activation, execution, recovery, replay,
  content-free inspection, and rollback.)*

- Flow can generate one supplemental-memory add or replacement proposal from tuning evidence.
  *(Implemented.)* The operator selects the target and operation. Generation uses one exact-model
  zero-tool turn, strict bounded JSON, and stable evidence and active-head admission. It publishes
  one inert candidate with no-replace semantics and content-free public views.

- Conversation persistence, live retrieval, and automatic or runtime model-written memory remain
  planned. Dynamic delegation, remote agents, dynamic routing, multi-node routing, and fallback
  candidates also remain planned.
  Agent Skill installation, signing, publication, executable-resource generation, and multi-skill
  candidates remain planned.

- Prompt, Agent Skill, model-route, child-specialist, and supplemental-memory candidates use the
  paired held-out and regression evaluation gate. *(Implemented.)*

- Activation is versioned, reviewable, scoped, and rollbackable. *(Implemented with operator
  preview, exact apply, paired artifacts, and baseline or version rollback.)*

- Reviewed changes compose into one complete effective harness state. *(Implemented for prompt,
  Agent Skill resource, Agent Skill package, model-route, child-specialist, and supplemental-memory
  surfaces. Activation order retains improvements. Runs store exact offline state, and rollback
  selects any retained state while current policy remains separate.)*

- Base safety, workflow semantics, and evaluator definitions remain immutable during a candidate
  run. *(Implemented for prompt projection, one-skill resource projection, and one new-skill
  package projection, one exact model-route projection, and one declared child agent axis.
  Non-routing candidates cannot change models. A route candidate changes only one root agent tuple.
  A child-specialist candidate changes only instructions or an exact selection from the existing
  package closure. A supplemental-memory candidate changes one bounded entry for one exact agent.
  No candidate can change unrelated graph, tool, package, policy, approval, budget, verifier, retry,
  or sandbox fields.)*

## Gate 8: Usable public preview

Gate 8 lets a new user install Flow, verify the local environment, and complete one useful run
without building the repository or interpreting internal configuration. The preview retains the
current pre-stable compatibility and security boundaries.

### Slice 8.1: Install the preview

- **Implemented:** One versioned package provides the `flow` command on Linux and macOS. A minimal
  launcher rejects unsupported public host requirements before it imports the complete CLI.

- **Implemented:** One clean reviewed revision produces one bounded archive and canonical release
  evidence. GitHub-hosted Ubuntu 24.04 x64 and macOS 15 Intel verify the same archive. They verify
  its installed tree, command discovery, help, project initialization, credential-free workflow,
  and local browser path.

- **Implemented:** GitHub build provenance binds the archive and evidence to the source workflow.
  A protected job creates a complete draft and publishes it only when release immutability is
  enabled. It cannot publish npm or assign `latest`.

- **Operator publication:** The first npm version requires an interactive two-factor-authenticated
  publication of the exact GitHub archive under `preview`. Later revisions use stage-only trusted
  publishing. A human retains two-factor-authenticated approval.

### Slice 8.2: Diagnose the environment

- **Implemented:** Add `flow doctor` as a read-only preflight command.
- **Implemented:** Check the Node.js version, project discovery, configuration, filesystem access, selected sandbox,
  and the requirements of the selected execution profile.
- **Implemented:** Check provider credentials, Docker, and Prime requirements only when the selected path needs
  them. Never print a credential, private path, raw provider response, or nested private cause.
- **Implemented:** Return stable categories, actionable remediation, and a nonzero exit status for each blocking
  requirement.

### Slice 8.3: Complete a quick start

- **Implemented:** Add `flow quickstart` to create a minimal project without replacing an existing
  file.
- **Implemented:** Validate and run the credential-free foundation workflow, then show the run identity
  and evidence location.
- **Implemented:** Offer one explicit provider-backed path that validates configuration before
  model work.
- **Implemented:** Offer the local browser presentation after Flow records a terminal run. The
  noninteractive command remains deterministic and never opens a browser.

### Slice 8.4: Prove a useful agent path

- **Implemented:** Add one explicit provider-backed coding workflow. It reads one reviewed fixture
  and makes one exact hash-bound change. It has no command or network tool.

- **Implemented:** Run deterministic exact-byte verification and expose usage, policy decisions,
  edit receipts, verifier evidence, and criterion state through `flow inspect`.

- **Implemented:** Document Anthropic and OpenAI setup, reported-cost boundaries, cancellation,
  cleanup, and inspection-first recovery.

- **Implemented:** Use fixed Flow-owned provider failure diagnostics. Exclude credentials and raw
  provider responses. Exclude nested private causes and partial output from failure text.

### Gate 8 failure behavior and non-goals

| Condition | Required behavior |
| --- | --- |
| Installation is incomplete or incompatible | Reject before project mutation and identify the missing public requirement. |
| Quick start fails before publication | Remove private staging and leave existing files unchanged. |
| Quick start has an uncertain publication | Report a fixed uncertain state and require inspection before retry. |
| An optional provider or runtime is unavailable | Keep credential-free commands usable and fail only the selected dependent path. |
| A diagnostic exceeds its deadline or output bound | Stop the check and return a fixed bounded diagnostic. |

Gate 8 does not provide a stable workflow-format promise, a hosted Flow service, VM-grade
isolation, or a hostile multi-tenant security boundary. It does not make optional providers,
Docker, or Prime prerequisites for credential-free use.

## Gate 9: Long-horizon context and semantic feedback

Gate 9 helps an agent retain the objective, retrieve evidence, and use semantic code information
without making conversation text or model summaries authoritative. Each capability remains bounded,
replayable, and visible in the selected profile.

### Slice 9.1: Maintain a durable goal workspace

- Store one revisioned objective, bounded facts, invariants, evidence-backed verified facts, open
  questions, and one next action.
- Use compare-and-set revisions for every update and keep completion under the deterministic goal
  and criterion evaluator.
- Persist workspace state without continuation authority and require an explicit run or resume
  action after recovery.
- Present a public workspace view that excludes private evidence and supplemental-memory contents.

### Slice 9.2: Retain artifacts by reference

- Store an oversized tool result or intermediate artifact under a content digest.
- Bind its exact byte count, media type, producer identity, and retention state.
- Put only a bounded preview and opaque reference in model context. Reopening a reference must pass
  through Flow policy and byte limits.
- Add deterministic inspection, retention, pruning, and missing-artifact behavior.
- Never reconstruct a missing or changed artifact from a model summary.

### Slice 9.3: Add read-only semantic code tools

- Add a Flow-owned language server protocol (LSP) port for diagnostics, definition, references, and
  hover or type information.
- Require an operator-selected language server with exact executable and configuration identity.
  Run it under the selected containment profile with no undeclared network access.
- Confine requests to admitted project paths, bound every request and response, and record result
  provenance. The LSP port cannot edit files or advance the workflow.

### Slice 9.4: Select an explicit work profile

- Add visible `fast`, `standard`, and `long` work profiles. Record the selected profile in the run
  ledger and show it in public inspection.
- Keep profile selection under operator or workflow authority. The model cannot silently promote
  its own profile.
- Give the model a bounded view of remaining starts, tokens, reported cost, active time, and
  retained-artifact capacity. Budget visibility cannot change the enforced budget.

### Slice 9.5: Preserve a provider-neutral session record

- Store a bounded append-only record of admitted user, model, tool, usage, and settlement events
  separately from the authoritative workflow ledger.
- Derive a model-visible surface from that record. A resumed session must start a fresh model turn.
- Do not continue an interrupted provider stream or retry an uncertain effect.
- Bind each request to its exact model route, system instructions, tool catalog, and authority
  snapshot.
- Use this identity to explain a changed request surface during replay.

### Slice 9.6: Evaluate reference-first compaction

- Remove or replace large tool results with artifact references before requesting a model summary.
- Keep the original objective, active constraints, policy identity, unresolved approvals, and
  effect uncertainty outside model-generated summaries.
- Record compaction start, selected range, output identity, token change, and settlement without
  rewriting the complete session record.
- Detect interrupted compaction, require a smaller result, and bound attempts while retaining the
  prior surface on failure.
- Compare no compaction, reference-only context, and reference-plus-summary context through paired
  held-out evaluation.
- Measure constraint retention, task success, tokens, cost, and latency before enabling automatic
  compaction.

### Slice 9.7: Extend reviewed memory relationships

- Let a supplemental-memory proposal declare a closed relationship such as `supports`,
  `contradicts`, `refines`, `supersedes`, or `derived_from`.
- Bind each relationship to exact source evidence, scope, and validity. Evaluate stale,
  contradictory, and inapplicable retrieval before activation.
- Keep generation, review, activation, rollback, and execution separate. A model cannot activate a
  proposal or write runtime memory.

### Slice 9.8: Generate capability reference documentation

- Generate the public tool and capability catalog from the production composition.
- Fail documentation verification when a registered public tool, schema, limit, or provider seam
  differs from the generated reference.
- Keep explanatory guidance in its canonical task or architecture document rather than copying the
  generated catalog into the root README.

### Gate 9 failure behavior and non-goals

| Condition | Required behavior |
| --- | --- |
| Goal-workspace revision is stale | Reject the update without changing the current workspace. |
| An artifact is missing, changed, or over its bound | Reject the read and preserve the reference as unresolved evidence. |
| The language server fails, times out, or returns malformed data | Return a bounded tool failure without falling back to an uncontained server. |
| Session persistence is interrupted | Preserve committed events, append a typed interruption boundary, and never invent a successful tool result. |
| Compaction loses a protected constraint or cannot reduce context | Reject the candidate surface and keep the prior surface unchanged for retry or inspection. |
| Memories conflict or have unknown validity | Present no automatic conclusion and require review or deterministic resolution. |

Gate 9 does not make conversation history, a goal workspace, an LSP response, retrieved memory, or a
model summary authoritative workflow evidence. It does not resume an interrupted model generation,
grant a new tool, or let the model select its own budget, profile, or continuation authority.

## Gate 10: Interoperable specialized execution

Gate 10 evaluates standards-based and specialized executors behind existing Flow authority. A new
executor receives only its declared workflow input and Flow-brokered capabilities.

### Slice 10.1: Run a local ACP executor

- Implement an Agent Client Protocol (ACP) v1 provider behind the existing `AgentExecutor` port.
- Start one exact local agent subprocess and bind its session to the Flow run and attempt.
- Translate committed results into provider-neutral evidence.
- Do not forward ambient editor filesystem, terminal, credential, or Model Context Protocol (MCP)
  authority. Route every permitted operation through existing Flow policy, approval, containment,
  and settlement boundaries.
- Evaluate at least two independent ACP agents against the same workflow and controls before
  claiming interoperability.

### Slice 10.2: Evaluate phase-aware model routing

- Declare closed planner, executor, verifier, and escalation roles without letting the model create
  a route.
- Record each call's provider, model, reasoning setting, selection rule, route result, cost, latency,
  and fallback or escalation decision.
- Start with deterministic operator rules and paired candidates.
- Enable no silent fallback or learned router until held-out evidence accepts its quality, cost, and
  reliability tradeoff.
- Keep routing algorithms provider-neutral.
- Allow a research router or model only as an evaluation target, not as Flow's durable authority.

### Slice 10.3: Add an optional proof verification profile

- Run an exact Lean toolchain and optional proof-specialized model behind existing executor and
  verifier ports.
- Retain the source specification, generated statement, proof, compiler and kernel results, tool
  versions, and dependency identity as bounded evidence.
- Treat kernel acceptance as proof of the declared formal statement, not proof that the statement
  matches the user's intent. Require separate specification-faithfulness evidence or human review.
- Measure proof coverage, statement faithfulness, cost, latency, and ordinary test results. Formal
  verification complements deterministic builds and tests and does not replace them.

### Slice 10.4: Bound later delegation experiments

- Define dynamic delegation as a reviewed evaluation candidate with an exact child objective and
  package closure.
- Bind its budget, depth, executor, result schema, and cancellation boundary.
- Reuse existing child-run and detached-job evidence instead of creating an untracked background
  task system.
- Keep remote Agent2Agent (A2A) execution blocked until Flow defines remote identity and
  authenticated authority propagation.
- Require multi-host settlement, tenant isolation, and operator remediation before enabling A2A.

### Gate 10 failure behavior and non-goals

| Condition | Required behavior |
| --- | --- |
| An ACP agent requests undeclared client authority | Deny the request and record the fixed authority category. |
| An executor disconnects with an open effect | Record uncertainty and block automatic retry. |
| A selected model is unavailable | Apply only an explicit recorded escalation rule or fail the call. |
| A router returns malformed, ambiguous, or unattributed output | Reject the decision and use no inferred route. |
| Lean accepts an unfaithful or incomplete specification | Keep deterministic and human verification requirements active. Do not claim task completion from the proof alone. |
| A delegated or remote task exceeds a budget or loses identity | Cancel or block it and reject unattributed results. |

Gate 10 does not make ACP a package ABI or durable event model. It does not make A2A, a routing
library, a specialized model, or a proof assistant mandatory. It does not allow executable package
plugins, model-written control loops, unrestricted code-as-action, automatic memory activation, or
unreviewed background delegation. These capabilities require separate evidence and, for executable
authority, stronger isolation.

## Product benchmark gate

- Reproducible harness evaluation is implemented for two Flow profiles. It includes paired
  scheduling, immutable trial evidence, offline inspection and export, explicit missingness, and
  constrained comparison.
- A native Pi adapter also supports paired Flow-versus-Pi evaluation. It uses a pinned driver, SRT,
  private host inference, durable adapter starts, installed-byte identity, Linux PID-namespace
  containment, and parent-owned process evidence.
- A native OMP adapter supports paired Pi-versus-OMP evaluation. It uses pinned OMP packages, an
  attested official Bun executable, SRT, private host inference, installed-byte identity, and
  parent-owned process evidence.
- A Prime Agent adapter supports paired Flow-versus-Prime evaluation on Linux x64. It uses a fixed
  OCI image, persistent IPython, private host inference, durable leases, and confirmed removal.
- A public claim that Flow beats the legacy plugin remains pending measured held-out evidence.

The standalone harness is compared against the legacy plugin on held-out repository tasks using equivalent model configurations. Record:

- Verified success rate
- Cost per accepted task
- Total context processed
- Model turns and tool failures
- Wall-clock duration
- Human interventions and policy violations
- False completion claims
- Crash and resume success
- Performance across multiple providers

For Gates 8–10, also record:

- Time from installation to the first accepted credential-free and provider-backed runs.
- Constraint retention across reference-only and compacted session surfaces.
- Quality, cost, latency, attribution, and fallback behavior for each routing profile.
- Formal-proof coverage and specification faithfulness for proof-enabled profiles.

Prefer hidden deterministic tests over LLM judges. Require measured improvement before claiming
that Flow beats the plugin. Feature count is not sufficient evidence.
