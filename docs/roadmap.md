# Delivery roadmap

The roadmap is organized around externally verifiable capability gates rather than dates.

Gates 0–2 are implemented. Gate 3 includes policy, approvals, exclusive file and directory
creation, hash-anchored edits, durable effect receipts, and sandboxed argument-vector command
execution.

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

Gate 8 provides an installable preview, source-build diagnostics, guided foundation and provider
checks, and one useful bounded provider-backed coding change.

Gate 9 adds bounded long-horizon context and semantic code feedback. Gate 10 adds standards-based
executor interoperability and evidence-gated specialized execution. Their evaluation-only
experiments don't become default user paths without separate evidence and approval.

Gate 11 starts the public compatibility program. Its first slice closes the npm entry boundary and
adds a real historical corpus with a read-only check. It classifies public surfaces and assesses a
future library API without exporting one.

Gate 12 selected Approach A, the evidence-first usable checkpoint, as the next release thesis. It
keeps unrelated deferred capabilities outside delivery commitments until their flows, authority
changes, dependencies, failure behavior, and falsifiable evidence gates are explicit.

Gate 13 applies that thesis to one production GitHub issue lifecycle. A user must be able to install
Flow and use it in another repository. The proof must cover implementation, independent review,
deterministic verification, hosted checks, explicit approval, and verified merge.

Remaining targets include executable extensions, remote or multi-user UI hosts, stronger
isolation, measured product benchmarks, and a future stable compatibility program.
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
- Full-SHA complete replacement of an existing UTF-8 file accepts bounded desired content without
  replaying the prior content. It preserves mode and shares the edit lock, effect protocol, and
  recovery contract. *(Implemented.)*
- Exclusive creation records an absent pre-state and after hash for one new UTF-8 file. It coordinates with edits on the same target. It never replaces an existing path. Recovery fails closed when it cannot distinguish non-application from later deletion. *(Implemented.)*
- Explicit nonrecursive directory creation records an absent pre-state, canonical empty-directory
  digest, and mode `0755`. It requires an existing parent, shares the target lock and effect limit,
  and never accepts or replaces an existing path. *(Implemented.)*
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
- Flow-owned workspace file and directory mutations persist typed prepare and settlement evidence
  across interruption. Exact edits and complete replacements share one file-effect protocol.
  *(Implemented.)*
- Supported open filesystem effects are reconciled before any future retry decision. *(Implemented
  for exact file hash and mode or empty-directory and mode observation under the shared target
  lock.)*
- Interrupted agent attempts can start a fresh numbered attempt only after a persisted opt-in and
  within a bounded attempt cap. Replay must prove that every effect was not applied. *(Implemented
  for read-only and `flow.effects/v1` writable attempts. Applied, unknown, open, legacy writable,
  and unaccountable resource states remain blocked.)*
- A supervisor owns detached workers, health, cancellation, and event replay. *(Implemented with strict project/operator capacity configuration, durable bounded FIFO admission, explicit accepted/queued/rejected outcomes, queued cancellation without execution, authenticated restart adoption, policy binding, and bounded cursor replay.)*
- Budgets cover attempts/node starts, model tokens, reported cost, active execution time, and retained
  executor-output artifacts. *(Implemented.)* Replay derives exact UTF-8 accounting and terminal
  exhaustion. Physical content-addressed retention is separate and doesn't change the run budget.
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

- **Implemented:** The `0.1.0-alpha.3` usability checkpoint reads one reviewed version from the
  package manifest. It requires matching shrinkwrap and release notes, then derives every workflow
  release name. It rejects a missing, malformed, linked, oversized, reused, or inconsistent
  identity before publication. This checkpoint corrects the npm organization scope while
  preserving `0.1.0-alpha.2` as immutable GitHub-only historical evidence.

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

**Implemented in current source.**

- Store one revisioned objective, bounded facts, invariants, evidence-backed verified facts, open
  questions, and one next action.
- Use compare-and-set revisions for every update and keep completion under the deterministic goal
  and criterion evaluator.
- Persist workspace state without continuation authority and require an explicit run or resume
  action after recovery.
- Present a public workspace view that excludes private evidence and supplemental-memory contents.

### Slice 9.2: Retain artifacts by reference

**Implemented in current source.**

- Store an oversized tool result or intermediate artifact under a content digest.
- Bind its exact byte count, media type, producer identity, and retention state.
- Put only a bounded preview and opaque reference in model context. Reopening a reference must pass
  through Flow policy and byte limits.
- Add deterministic inspection, retention, pruning, and missing-artifact behavior.
- Never reconstruct a missing or changed artifact from a model summary.
- Add reviewed catalog archival or segmentation for projects that approach the immutable
  4,096-reference catalog bound. *(Not implemented.)*

### Slice 9.3: Add read-only semantic code tools

**Implemented in current source.**

- Add a Flow-owned language server protocol (LSP) port for diagnostics, definition, references, and
  hover or type information.
- Require an operator-selected language server with exact executable and configuration identity.
  Run it under the selected containment profile with no undeclared network access.
- Confine requests to admitted project paths, bound every request and response, and record result
  provenance. The LSP port cannot edit files or advance the workflow.

### Slice 9.4: Select an explicit work profile

**Implemented in current source.**

- Add visible `fast`, `standard`, and `long` work profiles, then record and display the effective
  value.
- Resolve new runs from operator selection, workflow preference, then `standard`, and preserve that
  value across every lifecycle.
- Keep selection under operator or workflow authority so models, providers, packages, and ACP
  sessions cannot promote it.
- Give each model-backed attempt a bounded view of five remaining resource dimensions.
- Render missing limits as `unbounded`.
- Keep the profile informational, with no changes to budgets, scheduling, models, tools, approvals,
  policy, accounting, or completion.

### Slice 9.5: Preserve a provider-neutral session record

**Implemented in current source.**

- Store a bounded append-only record of admitted user, model, tool, usage, and settlement events
  separately from the authoritative workflow ledger.
- Derive a model-visible surface from that record. A resumed session must start a fresh model turn.
- Do not continue an interrupted provider stream or retry an uncertain effect.
- Bind each request to its exact model route, system instructions, tool catalog, and authority
  snapshot.
- Use this identity to explain a changed request surface during replay.

### Slice 9.6: Evaluate reference-first compaction

**Implemented in current source.**

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

**Implemented in current source.**

- Let one supplemental-memory proposal declare only `supports`, `contradicts`, `refines`,
  `supersedes`, or `derived_from` relationships for exact entry versions in one target.
- Bind each relationship to one through four exact durable run events. Reject missing, ambiguous,
  corrupt, cancelled, cross-agent, stale, duplicate, cyclic, or excessive relationship input before
  staging.
- Change one memory entry and only its incident relationships atomically. Replacement and removal
  require explicit removal or rebinding of every affected relationship.
- Preserve contradictions as unresolved claims without truth, winner, symmetry, transitive, or
  time-based inference.

The immutable lifecycle adds these guarantees:

- Bind the complete relationship state through paired evaluation, activation, execution, recovery,
  replay, and rollback. Model-generated memory cannot declare relationships.
- Give only the exact target a bounded content-free relationship block. Public views expose counts
  and integrity digests without memory bytes, evidence locators, or private failure details.

Read [Manage supplemental-memory relationships](guides/supplemental-memory-relationships.md) for the
operator workflow, limits, and recovery actions.

### Slice 9.8: Generate capability reference documentation

**Implemented in current source.**

- Generate the public tool and capability catalog from the production composition.
- Fail documentation verification when a registered public tool, schema, limit, or provider seam
  differs from the generated reference.
- Keep explanatory guidance in its canonical task or architecture document rather than copying the
  generated catalog into the root README.

Read [Tools and capabilities](reference/tools-and-capabilities.md) for the generated reference.

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

**Slices 10.1a, 10.1b, and 10.1c are implemented.**

#### Implemented identity and admission

- Validate one strict ACP v1 manifest and bind one exact local binary or Node package closure.
- Accept one public operator selection for validation, attached runs, and detached runs. Store the
  selection only in the run capability snapshot, independent of workflow YAML and its digest.
- Propagate the exact identity through all run paths and public output. Reject identity drift before
  executor invocation or recovery.
- Preserve token and reported-cost missingness. Reject an unenforceable budget before its first run
  event.

#### Implemented process and authority boundary

- Route a selected prompt-only agent or model verifier through an ACP v1 implementation behind the
  existing `AgentExecutor` port. Preserve the exact embedded Pi outcome when no ACP agent is
  selected.
- Start one fresh admitted process, private directory, and ACP session for every attempt. Bind the
  session to the run, workflow, node, attempt, and agent digest.
- Select the declared provider, model, and reasoning configuration exactly. Reject unavailable,
  refused, fallback, or changed configuration.

#### Implemented authority containment

- Advertise no ambient client authority. Reject workflows that request tools, skills, tool
  packages, or command approval.
- Use SRT to deny project, home, and protected-path access. Permit private writes, one provider
  domain, and one masked credential lease.
- Deny tool calls, permission requests, and undeclared methods. Record a fixed category and
  terminate the attempt.

#### Implemented settlement and evidence boundary

- Bound protocol state, output, timeout, cancellation, EOF, and cleanup. Require complete
  process-tree termination and record uncertainty for failures after prompt delivery.
- Translate settled output and usage into provider-neutral evidence. Include executor, session,
  sandbox, termination, and accounting provenance.
- Carry the same provenance into model-verifier evidence and replay validation.

#### Implemented fresh recovery

- Start a fresh process and session for eligible explicit recovery. Supply the bounded durable
  recovery capsule instead of resuming opaque provider or ACP state.
- Continue an eligible provider-failed agent from the exact model-session ledger after earlier
  workspace edits or settled raw-`exec` results. Require a durable committed settlement for every
  edit and complete process evidence for every command. Refuse continuation after a delegation or
  unconfirmed command termination. Also refuse continuation after a sandbox-cleanup failure.
- Retry a completed, nontruncated strict-invalid model-verifier response only under an explicit
  bounded policy. Preserve each failed attempt and its resource use. Keep semantic verdicts,
  truncated responses, provenance failures, and interrupted verifier requests nonretryable.

#### Implemented hosted proof

- Prove Linux x64 filesystem, network, credential, and descendant containment in hosted runtime
  tests.

#### Implemented cross-agent qualification

##### Paired evidence

- Admit exactly two distinct ACP agent identities against one shared agent-to-result workflow,
  shared controls, and canonical private result verification.
- Run the deterministic paired schedule through the ordinary evaluation store. Bind each trial to
  its workflow, capability snapshot, executor, containment, termination, usage, and result
  evidence.
- Publish qualified, not-qualified, or insufficient-evidence reports with complete scheduled
  denominators, latency, token and cost accounting, failures, and explicit limitations.

##### Live proof

- Provide an opt-in live test for two operator-maintained production agents. Missing configuration
  skips without a claim. Configured credential, runtime, model, accounting, or provider failures
  fail without fallback.

No agent pair is prequalified by implementation tests. A compatibility claim requires that pair's
own complete `qualified` report. A broader Flow-brokered authority profile remains planned. The
prompt-only profile remains the production default and does not treat ACP permission requests as an
authorization boundary.

Read [Local ACP v1 integration](acp.md#run-a-local-acp-executor) for operator steps, containment,
recovery, accounting, and public-output behavior. Read
[Qualify two local ACP agents](guides/qualify-acp-agents.md) for the paired qualification program.

### Slice 10.2: Evaluate phase-aware model routing

**Implemented.**

- Closed operator-authored profiles assign planner, executor, verifier, and escalation labels to
  exact root or embedded-child model targets.
- Each provider request records the exact profile, target, route, selection, fallback,
  escalation, and decision identity in its durable model session.
- One paired evaluation requires verified holdouts, non-inferior quality, complete cost and latency,
  explicit efficiency thresholds, and safety gates.
- Only the exact composed artifact with a complete `qualified` report can activate. Missing
  evidence, silent fallback, and opaque ACP routing fail closed. Provider-generated summary routing
  also fails closed.

- Learned or model-selected routing can be an evaluation target only. It remains outside production
  authority.

Read [Evaluate and activate phase-aware model routing](guides/phase-routing.md).

### Slice 10.3: Add an optional proof verification profile

**Implemented on hosted Linux x64.**

- Prepare one reproducible OCI appliance from fixed Lean, Mathlib, SafeVerify, lean4export, Nanoda,
  image, BuildKit, seccomp, and profile inputs. Require two clean builds with the same image ID.
- Admit the exact attestation and image before every proof attempt. Run without network,
  credentials, a project mount, or an ambient home. Verify the kernel policy before reading input.
- Accept a bounded specification, one exact formal statement, and one separate proof. An optional
  proof-generating agent uses one exact provider and model route with deny fallback.
- Require exact human approval that binds the specification and statement identities. Compiler,
  SafeVerify, Nanoda, closed-axiom, identity, and confirmed-cleanup evidence must agree before proof
  acceptance.
- Preserve bounded private proof material and content-free public inspection. Attached, detached,
  cancellation, recovery, replay, and export retain the same identities and block automatic retry
  after an uncertain prior effect.
- Qualify one exact profile only from complete declared evidence. Keep proof, human faithfulness,
  ordinary tests, cost, latency, policy, and cleanup separate from every other required criterion.

Read [Verify an exact Lean statement](guides/lean-proof-verification.md) and
[Operate the Lean proof runtime](operations/lean-proof-runtime.md).

### Slice 10.4: Bound later delegation experiments

**Implemented as a local evaluation-only experiment.**

- Define dynamic delegation as a reviewed evaluation candidate with an exact manager, objective,
  child workflow, and typed result. Bind the exact package closure, embedded Pi executor, and
  complete five-dimensional child budget.
- Give only the exact candidate manager one empty-input `flow_delegate` tool. Limit depth and calls
  to one, run the child in the foreground, and remove delegation authority from the child snapshot.
- Reuse isolated child-run identity, workspace, ledger, cancellation, cleanup, result, and resource
  evidence. Add durable parent preparation and settlement so recovery can reconcile the exact child
  without rerunning the manager.
- Require paired `delegation-fit` and `sequential-control` holdouts under identical root workflow,
  package, model, budget, network, retry, task, verifier, seed, and ordering controls.
- Report complete observations, invocations, skips, child outcomes, resource changes, constraint
  failures, and missingness by task class. Keep public output content-free and reject composition or
  activation for every verdict.
- Keep remote Agent2Agent (A2A) execution blocked until Flow defines remote identity and
  authenticated authority propagation.
- Require multi-host settlement, tenant isolation, and operator remediation before enabling A2A.

Read [Evaluate bounded one-shot delegation](guides/evaluate-bounded-delegation.md).

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

## Gate 11: Public compatibility and integration boundary

Gate 11 defines what alpha consumers can depend on and proves selected cross-release behavior. It
doesn't make a prerelease stable or convert internal TypeScript exports into a library API.

### Slice 11.1: Define the public compatibility contract

- **Implemented in current source:** Expose only the `flow` executable from the npm package. The
  empty `exports` map rejects package-root and undeclared-subpath imports.
- **Implemented in current source:** Package one versioned immutable corpus with the exact
  alpha.1 installation workflow. It also includes one terminal run ledger from the verified
  immutable alpha.1 archive.
- **Implemented in current source:** Provide `flow compatibility check` as a read-only, offline
  command. It returns one bounded report, an ordered result for every artifact, stable categories,
  and a fail-closed overall result.
- **Implemented in current source:** Reuse the production workflow compiler, workflow digest,
  strict JSON parser, run-event parser, and reducer. The check doesn't use a simplified
  compatibility-only interpretation.
- **Implemented in current source:** Reject input that is missing, malformed, oversized,
  unsupported, identity-mismatched, or semantically changed. The check doesn't modify the corpus or
  a project.
- **Implemented in current source:** Make the packed-archive gate install the archive and run the
  historical check. The gate tests the import boundaries. Package-root and deep imports must fail.
- **Implemented in current source:** Classify CLI invocation, authored schemas, public output,
  durable records, capability packages, presentation packages, and compiled modules. Define alpha
  version, channel, deprecation, migration, and rollback rules without a stable claim.
- **Implemented in current source:** Audit a possible library API across user, operator, and system
  flows. The audit covers authority, coupling, lifecycle, errors, resource limits, versioning,
  package boundaries, and ACP relevance.

The immutable alpha.3 release doesn't gain this command retroactively.

### Slice 11.2: Release the first compatibility-governed checkpoint

- **Implemented in current source:** Advance the manifest-owned preview identity to alpha.4. Keep
  alpha.3 immutable and retain its first-publication `latest` exception as historical evidence.
- **Implemented in current source:** Reproduce the library-boundary audit with the pinned TypeScript
  compiler. Report production-file, exported-declaration, static-reachability, layer, and documented
  CLI-form counts from current source.
- **Implemented in current source:** Add a separate npm staging workflow. It verifies the immutable
  GitHub release, source revision, asset set, and provenance. It also checks the installed package,
  package import boundary, and unused npm version before it requests stage-only authority.
- **Implemented in current source:** Use GitHub OpenID Connect and npm staged publication without a
  long-lived token. Keep human artifact comparison, two-factor approval, and rejection outside CI.
- **Implemented in current source:** Document each operator state. The states cover qualification,
  GitHub publication, npm staging, approval, public verification, channel behavior, and recovery.

Alpha.4 is the first package governed by Slice 11.1. It doesn't add a supported library import,
expand the corpus without release-produced evidence, or claim stable compatibility.

### Slice 11.3: Keep long model sessions within safe provider capacity

- **Implemented in current source:** Add one explicit rolling context policy for embedded Pi agent
  nodes. Omission preserves existing behavior. The published alpha.4 package remains unchanged.
- **Implemented in current source:** Intercept Pi's exact serialized OpenAI Responses or Anthropic
  Messages payload before inference. Use the same-origin provider count endpoint. Preserve exact
  versus estimated uncertainty. Reject unavailable measurement without a token heuristic fallback.
- **Implemented in current source:** Record write-ahead capacity checks and rolling epoch starts and
  settlements in the private append-only model-session record. Bind cumulative and delta source
  ranges. Also bind payload, surface, runtime, policy, and public-state identities.
- **Implemented in current source:** Preserve the objective, Flow authority, current instructions,
  tools, protected constraints, and complete tool pairs. Keep the two most recent completed
  requests exact. Project only eligible older artifact-backed results and closed history.
- **Implemented in current source:** Limit one epoch to two internal checkpoint-tool summary
  attempts. Limit one session to eight epochs and 16 summary calls. Require a 4,096-byte minimum
  reduction. Add summary usage to node and run budgets.
- **Implemented in current source:** Reconstruct only complete accepted checkpoints after restart.
  Settle unmatched starts as interrupted and verify bindings against original events. Require the
  inference payload to match the admitted serialized payload.
- **Implemented in current source:** Fail an opted-in ACP node and unsupported Pi adapter closed.
  Keep provider-native persistence, automatic opt-in, approximate capacity, and library exports
  outside this slice.

Read [Keep long model sessions within provider capacity](guides/rolling-context.md) for operator
guidance and [Architecture](architecture.md#rolling-context-admission) for ownership and non-goals.

### Deferred candidates

Gate 11 doesn't commit its deferred candidates to a release. The
[next-version capability research](next-version-research.md) consolidates these candidates with
their research maturity, dependencies, authority changes, and decision gates. It includes corpus
expansion, programmatic boundaries, context economy, bounded verifier-directed recovery, stable
compatibility, and the higher-authority capabilities deferred by earlier gates.

Gate 11 doesn't export `CompiledWorkflow`, `RunEvent`, `RunState`, `runWorkflow`, local stores,
supervisor services, infrastructure adapters, or the CLI composition root. ACP remains an editor and
agent boundary. It doesn't become Flow's workflow, ledger, policy, package, or evaluation API.

Read the [Compatibility policy](compatibility.md) for the current contract and the
[Library API assessment](library-api-assessment.md) for the evidence and alternatives.

## Gate 12: Shape the next version

Gate 12 selects one primary release thesis before implementation. Research prototypes cannot gain
production authority, activate themselves, or change a supported contract.

### Slice 12.1: Inventory deferred capabilities

**Implemented in current documentation.**

- Map each deferred capability to a user, operator, or system flow.
- Classify decision evidence as assessed, partial, or initial.
- Record missing research, authority change, prerequisites, and a falsifiable research exit.
- Keep standards at their owning client, agent, presentation, workflow, or security boundary.
- Preserve one canonical detailed register in
  [Next-version capability research](next-version-research.md).

### Slice 12.2: Select one release thesis

**Implemented by the approved Approach A decision.**

- Use the evidence-first usable checkpoint for the next version.
- Serve a local command-line operator who needs to complete one issue in another GitHub repository.
- Keep Git, GitHub credentials, publication, hosted-check observation, approval, and merge in the
  trusted host controller. The model receives no new delivery authority.
- Use another compatibility-governed alpha checkpoint unless qualification establishes a stronger
  support contract. Assign no version until the release gate freezes it.
- Require local fault and recovery coverage, hosted Linux x64 and macOS x64 package checks, and one
  complete external-repository acceptance pilot. Preserve every failed attempt and human
  intervention.
- Keep long-horizon repair, programmatic integration, remote operation, and stronger isolation as
  separate research tracks.

### Slice 12.3: Complete decision-grade research

- Produce one reviewed dossier for every proposed delivery capability.
- Compare two to four implementable approaches and retain the simplest viable control.
- Define non-goals and behavior for timeout, partial failure, invalid input, missing context,
  dependency outage, resource exhaustion, cancellation, restart, and upgrade.
- Pin primary sources, standards versions, dependency identities, and licenses.
- Freeze held-out tasks, controls, budgets, thresholds, stopping rules, and abort criteria before
  evaluation.

### Slice 12.4: Freeze the version gate

- Convert only accepted dossiers into bounded slices and independently verifiable acceptance
  criteria.
- State compatibility, migration, rollback, security-review, release, and support obligations.
- Require the product benchmark gate before a capability can make a production or superiority
  claim.
- Publish every attempted evaluation result, including failures, missingness, and human
  interventions.

### Gate 12 failure behavior and non-goals

| Condition | Required behavior |
| --- | --- |
| Research evidence is missing, leaked, or environment-mismatched | Report insufficient evidence and keep the capability outside delivery scope. |
| A prototype requires authority beyond its dossier | Stop and return to design review without widening policy. |
| A standard changes during research | Pin the observed version and reassess the contract; don't infer compatibility. |
| A candidate improves average quality but increases false acceptance or policy violations | Reject production adoption. |
| No release thesis wins approval | Keep the current release line and continue bounded research without assigning a version. |

Gate 12 does not promise implementation of every deferred capability. It does not establish a
stable release, hosted service, public library, remote API, executable-package ABI, or multi-tenant
security boundary.

## Gate 13: Complete one GitHub issue end to end

Gate 13 delivers the selected evidence-first checkpoint. Completion requires a released command
that another user can apply to one supported `github.com` repository without building Flow.

### Slice 13.1: Implement the recoverable host controller

**Implemented in current source.**

- Freeze all task and repository inputs before mutation. These inputs include the open issue,
  canonical repository, base commit, plan, workflows, budgets, and model. Also freeze candidate
  paths, holdout, checks, branch, and merge policy.
- Keep model work network-denied and credential-free. Give implementation only admitted workspace
  writes, and give independent review read-only access.
- Prepare and settle worktree, commit, push, pull-request, readiness, and merge effects through a
  replay-validated durable ledger.
- Reconcile an interrupted effect against exact local or GitHub identity before retry. Preserve
  uncertainty when absence or completion can't be proved.
- Bind an optional per-node model-response cap into the workflow and recovery identity. Continue
  an output-limited response only from a settled durable model session. Don't infer safety from a
  timeout or missing response.
- Require one draft pull request and reuse that pull request after repair. Require exact-head checks
  from named GitHub Apps, an exact operator merge command, and a post-merge topology proof.

### Slice 13.2: Bind exact independent-review evidence

**Implemented in current source.**

- Send the reviewer the frozen issue and complete criterion IDs and descriptions. Also send the base
  and candidate identities, changed paths, exact bounded diff, and deterministic verification
  summary.
- Bind the review request and structured result to the exact candidate, issue, workflow, and frozen
  contract. Reject incomplete criteria, malformed JSON, P1 through P3 findings, and candidate drift.
- Store exact diff and command evidence only in owner-protected private state. Keep public events and
  inspection content-free.
- Require explicit operator authority for the bounded repository-data transmission before the
  first model-backed acceptance run.

### Slice 13.3: Prove the external-project lifecycle

**Implemented against the source-built controller.**

- Use the packed release-candidate command through separate operating-system processes against
  `digital-twin` issue 6.
- Start from a frozen clean base. Predeclare the holdout, verification commands, hosted-check names,
  source app identities, budgets, stopping rules, and repair ceiling.
- Preserve all attempts. For each failure, identify the responsible boundary and add a regression
  test. Fix the general Flow defect, and repeat from an admitted state.
- Require independent review with no P1, P2, or P3 findings. Also require successful local and
  exact-head hosted checks, explicit gate-bound approval, and a proved merge.
- Reopen the durable run from a fresh service instance and use separate CLI invocations to prove
  process-boundary recovery.

The accepted issue 6 run reached `merged` after an unchanged private holdout, fresh independent
review, exact-head hosted CI, and a separate digest-bound merge command. The 52-run denominator and
all operator interventions remain in the
[issue 6 lifecycle field report](field-reports/digital-twin-issue-6-alpha4.md). The controller ran
from current source on macOS. The candidate ran its required check on hosted Linux x64. This result
doesn't qualify the older published alpha.4 package or every supported host.

### Slice 13.4: Qualify and publish the usable checkpoint

**Pending exact-head Flow review, package qualification, and separate release authorization.**

- Update all public lifecycle documentation from the accepted evidence. This set includes the task
  guide, workflow-authoring guide, operations runbook, specification, architecture, project status,
  release notes, and field report.
- Test every published plan and workflow example through production admission. Check every command
  against the shipped CLI help.
- Verify one packed archive on hosted Ubuntu 24.04 x64 and macOS 15 x64. Include issue-command
  discovery, read-only validation, and compatibility checks.
- Complete independent code and test review. Merge only with no P1, P2, or P3 findings and all
  required checks successful.
- Publish a new immutable GitHub prerelease only after a separate exact publication authorization.
  Stage and approve npm through the existing two-factor release procedure.

### Gate 13 failure behavior and non-goals

| Condition | Required behavior |
| --- | --- |
| The operator hasn't authorized bounded provider transmission | Stop before model execution and preserve the target repository. |
| The base, issue, plan, workflow, provider, model, or hosted-check contract changes | Reject the stale run or gate. Freeze and review a replacement contract. |
| A local or hosted check is missing, stale, skipped, or unsuccessful | Don't create or accept a merge gate. |
| Review finds a P1, P2, or P3 issue | Block publication or merge, fix the candidate, and require fresh candidate-bound evidence. |
| A Git or GitHub response is lost | Reconcile the prepared effect. Don't repeat it from process memory or manual inference. |
| The pilot doesn't prove the complete lifecycle | Report the attempt and keep the release unqualified. Don't convert partial success into a readiness claim. |

Gate 13 doesn't support forks, merge queues, GitHub Enterprise, multiple remotes, or cross-host
relocation. It also excludes autonomous merge approval, administrator bypass, remote multi-user
control, and a hostile multi-tenant boundary. One accepted pilot doesn't prove compatibility with
every repository, language, model, or issue.

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
- Three adaptive issue series in a separate repository produced reviewed, merged implementations.
  The first used nine full attempts and exposed one false acceptance. The second used 11 full
  attempts and four bounded repair workflows, and strengthened review rejected one workflow
  success. The third used 52 full lifecycle runs. Private holdout and independent review rejected
  incomplete candidates before one exact approval-bound merge.
  Every full and repair attempt remains in its reported denominator. These results are product
  evidence, not benchmarks, model-quality conclusions, or proof of autonomous repair selection.
  Read the
  [issue 4 field report](field-reports/digital-twin-issue-4-alpha4.md) and
  [issue 5 field report](field-reports/digital-twin-issue-5-alpha4.md), and the
  [issue 6 lifecycle field report](field-reports/digital-twin-issue-6-alpha4.md).
- A public claim that Flow beats the legacy plugin remains pending measured held-out evidence.

Before extending that field sequence, freeze each later task's base, workflow, external holdout,
and repair ceiling. Preserve every failure in the denominator. Report every human intervention.
Publish accepted patches through ordinary review and hosted CI.

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
