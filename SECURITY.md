# Security policy

## Reporting a vulnerability

Do not file a public issue for a suspected vulnerability. Use the repository's private [GitHub security advisory](https://github.com/synaptiai/flow-harness/security/advisories/new) form and include reproduction steps, affected revision, impact, and any known mitigation.

The maintainers will acknowledge a complete report, assess severity, coordinate a fix, and publish disclosure information when users can take protective action.

## Supported code

Before the first stable release, security fixes target the latest revision on `main`. There is no promise of backports to earlier commits or `0.x` package snapshots.

## Current trust boundaries

The embedded Pi runtime runs with the invoking user's operating-system permissions. Command descendants run through a required native OS sandbox. These are different boundaries and should not be treated as equivalent.

- Agent sessions receive a Flow-owned system prompt and exact Flow-owned `read`, `ls`, and hash-anchored `edit` tools whose canonical paths are confined to the execution workspace. Edit is declaration-gated, requires a current full-file SHA-256, changes only one existing UTF-8 file, coordinates cooperating Flow processes on the same host, atomically replaces the target, and denies run state and sensitive project paths. Pi built-in tools are disabled.
- Pi project extensions, skills, templates, themes, and context discovery are disabled.
- Command nodes preserve explicit argument arrays through an audited encoder and run inside the fixed SRT `workspace-write-network-deny-v1` profile.
- The profile denies network, undeclared Unix sockets, ambient credentials, host writes to run state or sensitive project metadata, and home reads outside the workspace except for the exact canonical SRT seccomp helper required on Linux. On Linux, SRT can hide a read-denied directory with an ephemeral mask. A write call in that mask can report success, but it cannot change the host path. That runtime-support file is re-exposed read-only when Flow is installed elsewhere. Ordinary workspace writes remain allowed by design.
- Same-workspace, same-policy concurrent commands share SRT's process-global session but receive distinct temporary directories and per-command filesystem configurations. A command for a different workspace or policy waits for every active wrap to release, then Flow resets and reinitializes the session before admitting it. Cancellation while queued starts no process, and a poisoned session fails queued work closed.
- Child workflows run from owner-only, content-verified reflink-or-copy working-tree snapshots. Flow excludes `.flow` and the configured run-store path, rejects special files and bounded-size overflow, and records the snapshot identity in both ledgers. Ordinary child workspaces are discarded after terminal settlement. Successful compiler-generated optimization candidates normally remain retained until their typed check rejects or conclusively promotes and cleans them. This prevents ordinary child writes from changing the parent working tree; it is not an atomic filesystem snapshot, VM-grade sandbox, or boundary against the invoking user. Host-side Pi retains that user's authority subject to Flow's tool broker, while child command descendants still use SRT.
- Candidate capture separately bounds changed entries, logical file bytes, and serialized durable evidence. A cancellation after candidate success but before its check retains the isolated candidate for diagnosis; no evaluation, promotion, parent mutation, or later candidate starts. Operators should treat retained candidate workspaces as untrusted artifacts.
- Flow creates new child workspaces in an owner-only project-sibling collection. The collection name is `.<project-name>.flow-workspaces`. A hash of the canonical physical run-store path separates workspace groups. Filesystem aliases for one run store select one workspace group. Thus, the project workspace, the protected project `.flow` directory, and the configured run store do not contain the collection. Attached runs use the canonical configured project root. Detached jobs save the same optional root in their immutable identity. For an old detached record, Flow can infer the project root from the durable `.flow/runs` ancestor. Flow rejects a linked collection or owner directory.
- The broker denies reads and writes for each historical `.flow-workspaces` or named `.<name>.flow-workspaces` path segment. Before a command starts, SRT scans at most 200,000 execution-root entries. It adds each existing private collection as a literal protected path and rejects linked or indirect collections. For a selected child workspace, SRT also denies reads from every ancestor collection. This rule prevents a read from any sibling workspace and keeps writes to the selected child available. The snapshot copier omits these collections. Every child command keeps the complete protected-path deny list. The broker and SRT derive the local `.flow` denial from the child workspace. SRT permits host writes only in that child workspace and its private temporary directory. On Linux, Flow rejects a command root that strictly contains the configured project root. This rule prevents a command from creating a future reserved collection that Linux SRT cannot match before the path exists.
- Recovery can find a workspace in the old run-store location. Flow first validates the old manifest with its old exclusion identity. For a nested child, Flow translates the moved parent path to the old parent path. Flow moves and syncs the complete identity directory when both locations use one filesystem. Across filesystems, Flow makes a bounded staging copy, verifies stable source and target hashes, syncs it, publishes it with one rename, and removes the old identity last. Flow reopens the moved workspace. Its first recovery event records the exact old and new paths in `run_resumed.workspaceRelocation`. Thus, a parent records each child relocation before it starts recovery in that child. Flow does not create new workspaces in the old location.
- Any dependency error or warning, initialization error, unsupported platform, or invalid sandbox launch descriptor fails before command spawn. There is no host-execution fallback.
- Command nodes run only on Linux and macOS. Windows execution fails before spawn until full descendant-process containment is available.
- Run events are synced before scheduler advancement. Writable agent attempts durably prepare each
  edit before rename and, while journal publication remains available, settle it as committed, not
  applied, or post-commit unknown. If settlement publication rejects, the attempt journal is
  poisoned and the effect remains unresolved. Authorization, effect events, and terminal receipts
  are distinct replay-validated evidence; replay rejects terminalization while an effect remains
  unresolved, terminal evidence with an invented or omitted receipt, and committed-record
  corruption.
- Recovery of an unsettled prepared edit uses the same target queue and cross-process lock as
  mutation, rejects non-regular targets before opening them, opens without following symlinks,
  hashes only the initially observed size in fixed chunks totaling at most 8 MiB, and appends a
  bounded hash/mode observation before releasing the lock. If missing ancestry prevents the sibling
  lock from existing, only a rechecked still-missing result may be published; any observable target
  remains unresolved. Recovery does not store target bytes, raw operating-system errors, or repair
  the workspace. The observation is not an executor settlement and cannot authorize node retry or
  claim that a provider turn completed.
- Approval-required command nodes persist the exact executable, ordered arguments, normalized
  working directory, timeout, digest, request identity, and grant lifetime before any node start or
  sandbox preparation. Approval is single-use, expires predictably, and does not weaken the command
  sandbox. Denial and expiry execute nothing.
- Approval-required agent commands persist the exact live tool request and context before command
  preparation. A same-user decision client publishes an immutable owner-only sidecar, but only the
  active run owner can validate it and append authority to the ledger. Grant consumption and
  command preparation are atomic; denial, cancellation, invalid identity, expiry, and reuse execute
  nothing. Receipt reads are non-blocking, no-follow, regular-file-only, strict UTF-8, and byte
  bounded before parsing. Invalid identity closes without execution; transient receipt-read failure retries with
  bounded abortable backoff and grants no authority. This approval gate supplements rather than
  replaces policy and sandbox containment.
- Graph approval nodes persist a canonical prompt and ordered references to complete durable
  command, agent, or accepted verifier evidence, including source attempts, fields, and hashes. Truncated evidence
  fails before a request. Approval completes only the pure control node; it grants no command,
  model-tool, sandbox, credential, or policy authority. Denial executes nothing.
- Typed result nodes parse only complete durable direct-dependency evidence through a closed,
  depth-, node-, and byte-bounded schema. Duplicate JSON object keys, including escape-equivalent
  names, fail closed; so do trailing input, non-finite numbers, unpaired surrogates, undeclared
  object properties, truncated sources, and oversized values. Publication records canonical JSON
  with source, schema, and value hashes, but replay trusts none of those claims until it reproduces
  them from the original durable evidence. Result nodes invoke no executor and grant no authority.
- Model verifier nodes receive only their author rubric and declared complete direct-dependency
  evidence in a separate Pi session with a dedicated system prompt, empty tool set, disabled
  extensions/skills/context discovery, and hard aggregate input and response bounds. Strict JSON
  parsing, source hashes, and replay validation prevent malformed output from becoming acceptance.
  These controls do not make model verdicts prompt-injection-proof or deterministic; untrusted
  evidence may still influence the evaluator. Use sandboxed command verifiers and hidden checks for
  release authority. A command verifier inherits the normal command sandbox and conservative
  side-effect classification.
- Versioned verifier packages are strict project-local `VERIFIER.yaml` data, not executable plugin
  bundles. Discovery refuses symlinks, special or extra entries, duplicate identities, source
  races, malformed exact versions, and size overflow. Admission snapshots the exact manifest and
  binds its digest to the compiled node and verdict evidence; detached, child, and resumed work does
  not reload a changed live source. A command package still runs only through SRT, and a model
  package supplies only a rubric to the zero-tool verifier. Packages cannot add hooks, tools,
  credentials, network, provider choice, graph edges, or policy. Workflows and package manifests
  remain trusted local configuration and must be reviewed before execution.
- A `ToolPackage` is strict project-local `TOOL.yaml` data that contributes one declarative command
  tool through the existing agent-command boundary; it is not loaded as code. Selection binds an
  exact version and manifest digest to one agent, while model inputs may replace only complete argv
  elements admitted as data by a closed Flow-owned driver profile. The initial registry accepts
  only a non-evaluating `/usr/bin/printf` data profile and one exact hardened `/usr/bin/git` status
  profile; project packages cannot add shells, interpreters, dispatchers, alternate executable
  identities or paths, subcommands, or profiles.
  Flow derives `process.execute` and retains the existing policy, optional live approval,
  Linux PID-namespace containment, write-ahead command journal, output bounds, budgets, and replay
  checks. Discovery refuses symlinks, extra payloads, source races, duplicate or reserved names,
  unsupported authority, and malformed templates. Packages cannot add environment, credentials,
  cwd, shell text, network, hooks, providers, middleware, graph changes, or policy. Workflows and
  manifests remain trusted local configuration; command output and arguments may contain sensitive
  data and are persisted in the run ledger.
- A `WorkflowPackage` is strict project-local `WORKFLOW.yaml` data containing bounded ordinary Flow
  workflow source. Admission snapshots exact local or installed bytes and recompiles roots and
  children with a closed snapshot-only resolver. Package cycles, source drift, digest mismatch,
  ambiguous versions, and replay substitution fail closed. A `WorkflowPackage` cannot register
  executable modules, hooks, tools, drivers, providers, credentials, policy, or sandbox authority;
  every selected node remains subject to the standard compiler, scheduler, approvals, containment,
  evidence, budgets, and child isolation.
- Remote capability bundles contain only the same Agent Skill, verifier, declarative command tool,
  and inert workflow source ABIs. `flow packages install` is the only network operation: it requires one canonical
  public HTTPS URL and caller-supplied lowercase SHA-256, follows no redirect, sends no ambient
  credentials, pins a validated public DNS answer into the TLS connection, and bounds the whole
  request. The digest is checked before strict JSON and package parsing. Installation runs no
  package code, dependency manager, hook, or driver.
- Installed bytes are stored once at `.flow/packages/sha256/<digest>.flowpkg`; activation is the
  deterministic `.flow/packages.lock.json` entry published last under an owner-checked local lock.
  Missing, corrupt, replaced, symlinked, identity-inconsistent, or colliding state fails closed.
  Mutation locks are never reaped automatically: an operator must verify that no mutation is active
  before removing an exited owner's exact lock. A `commit_uncertain` result requires local lock/blob
  inspection and verification before retry. New store-directory entries are parent-synced before a
  lock can reference them; bounded reads and traversal budgets remain enforced during source races.
  Local inspection/removal and workflow execution never fetch the recorded source. A digest proves
  byte identity, not publisher identity, freshness, revocation, or rollback protection. Treat the
  URL, digest, lock, and package content as trusted project configuration and review them before
  selecting a package.
- Run budgets persist checked start, token, reported-cost, and active-time accounting and can reduce
  node timeouts before execution. They are scheduler controls, not provider-side billing
  reservations, account quotas, CPU/memory limits, or a substitute for containment. One in-flight
  model response may settle above its remaining allowance; Flow records it and starts no further
  work.
- Bounded loops are finite compiler constructs rather than model-controlled recursion. Each loop
  has at most 32 iterations and 16 body nodes; the complete expansion is limited to 256 nodes and
  its persisted graph to 512 KiB. Checks use exact, non-truncated durable evidence, later
  iterations require the immediately prior durable `continue`, and exhausting the bound fails
  closed. Arbitrary cycles, nested loops, and unbounded continuation are rejected.
- Bounded optimization is also compiler-expanded rather than model-controlled. Metric and invariant
  JSON Pointers are schema-checked, the baseline must come from deterministic command evidence,
  and only a strict typed improvement may enter promotion. The ledger persists bounded path-level
  before/after identities and recomputes their manifest digest during replay. Promotion opens no
  leaf or stable intermediate path through a symlink, refuses special entries, verifies the parent
  snapshot and every affected path before prepare, rechecks directory ancestors at mutation
  and crash-cleanup boundaries, removes only regular-file or symlink staging entries, preserves
  unrelated parent changes, and stores rollback bytes durably before mutation. A per-promotion
  owner lock coordinates cooperating processes. Per-component checks
  narrow but cannot eliminate pathname TOCTOU against a hostile same-user process, and these
  controls do not protect private run state from that authority. Use stronger whole-harness
  isolation for adversarial workloads.
- Detached control metadata is stored below the selected run root in owner-only directories and
  files. Local Unix sockets use an owner-validated, non-symlink short temporary directory; worker
  control requires a random token plus matching worker, run, PID, and job-digest identity.
- An owner-only startup record serializes socket cleanup and daemon launch. A live or PID-reused
  holder blocks replacement rather than allowing two generations to race over one endpoint.
- Supervisor requests use strict versioned single-frame JSONL with byte, field, and event-page
  bounds. Workflow source and worker tokens are never returned by status. Mutating cancellation is
  durably journaled before dispatch and is attributable, digest-bound, and idempotent.
- Detached admission is bound to a canonical effective policy digest. Active reservations and a
  durable FIFO queue are hard-bounded; overflow rejection retains no workflow snapshot. A project
  may narrow but cannot widen the operator capacity ceiling. This limits trusted same-user workload
  growth but does not contain a worker or impose provider, CPU, memory, or billing quotas.
- Admission records use owner-only no-follow files, append/fsync before acknowledgement, strict
  transition replay, final-tail repair, and atomic replay-equivalent snapshot compaction. A policy
  change requires an explicit idle supervisor shutdown; committed queues are never hot-rebound.

Automation that depends on retry idempotency must generate and persist `--command-id` before the
first request. A key generated internally but lost with the response cannot identify a later retry.

The supervisor boundary coordinates trusted processes belonging to the same operating-system user.
It is not a sandbox against that same user or root, not a remote authentication service, and not a
multi-host lease. A hostile process with the same account authority can read or replace that
account's state despite file modes. Run Flow under a dedicated OS identity or stronger isolated
environment when local peers are outside the trust boundary.

SRT is a beta native sandbox based on Seatbelt on macOS and bubblewrap, namespaces, and seccomp on Linux. It reduces command authority but is not equivalent to a microVM and cannot defend against a kernel or sandbox-runtime vulnerability. It also does not contain the host-side Pi process or make host-side pathname authorization atomic against a concurrently hostile workspace process. Use a reviewed container, microVM, Gondolin, OpenShell, or managed boundary for hostile or multi-tenant work.

Workflow files remain trusted orchestration configuration: command nodes can execute arbitrary programs within the declared workspace-write boundary. Review workflows before running them and scope host credentials outside the Flow process where possible.

`flow approve` and `flow deny` route the current typed command, live agent-command, or graph request
and record a caller-supplied actor label. Agent-command decisions remain sidecar submissions until
the active owner commits them. The label is audit attribution, not authenticated identity, RBAC, or
a signature. Request ids are locators rather than bearer secrets. The private run-directory
permissions and authority of the invoking local account are the administrative boundary. Do not
expose the run directory or approval CLI to untrusted users.

Command output, agent text, verifier reasons and raw model responses, executable arguments, and failure messages are persisted in the run ledger as evidence. They can contain secrets emitted by tools or providers. Keep `.flow/runs` private, apply repository ignore rules, and redact sensitive output at its source.

An evaluation fixture is untrusted workload input. Flow admits only bounded regular files and
directories, rejects links, special entries and `.flow`, copies each trial into a fresh isolated
workspace, and rechecks its identity before execution. The built-in evaluator receives no adapter
output other than the final workspace and exposes no private assertion body to the evaluated
profile. These controls do not contain the host-side Pi process or a hostile same-user process and
do not make native isolation equivalent to a VM. Run adversarial fixtures under a dedicated OS
identity or stronger boundary.

Private verifier transport does not prevent author-side holdout contamination. Expected answers,
hashes, hidden checks, evaluator logic, or prior result-bearing history placed in a fixture,
instruction, profile prompt, package, or model-visible repository file are available to the harness.
Review provenance, separate tuning from holdout tasks, and rotate exposed tasks. Content digests prove
the admitted bytes, not that those bytes were previously confidential or statistically independent.

Evaluation headers intentionally omit absolute source paths, workflow bodies, prompts, and verifier
assertions, retaining only verifier digests and assertion counts, but trial ledgers and exports expose
assertion paths, observed file hashes, bounded failure reasons, provider-derived usage, and run
identifiers. Store `.flow/evaluations` with the same privacy as `.flow/runs`. Digest chaining,
single-writer ownership, fatal UTF-8 decoding, direct-directory and no-follow file checks, and
offline replay detect many local substitutions;
they are not signatures and cannot defend state from root or the same trusted account.

A prompt candidate is trusted orchestration input with a closed change surface. Flow reads each
candidate, baseline, and tuning-evidence file as a bounded no-follow regular file. Flow verifies
stable path identity and all declared hashes. It changes only declared root-agent prompt fields.

A candidate cannot change tools, skills, packages, graph edges, models, policy, approvals, budgets,
verifiers, retries, credentials, network access, or executables. A candidate cannot authorize its
activation. It never edits the baseline.

Prompt candidate generation uses one model turn with no tools, skills, packages, or workspace
access. The selected provider receives the permitted current prompts and tuning-only packets. It
does not receive omitted regression records, holdout records, verifier data, trial workspaces, or
activation state through this command. Treat the provider as an external data recipient.

Flow treats the model response as untrusted input. It accepts prompt replacements only. It checks
the baseline and evidence file identities again, validates every hash, compiles the projected
workflow, and uses a no-replace publication step. An invalid response, changed source, collision,
timeout, pre-commit cancellation, or interrupted pre-publication write creates no final candidate
file. A cancellation observed after the hard-link commit returns `publication_uncertain`. One
complete final candidate can exist. Generation does not start an evaluation and cannot activate a
candidate.

Activation requires an operator command and a complete superior evaluation. Preview binds the
candidate, evaluation proof, current head, actor, and reason to one proposal digest. Apply holds a
cross-process lock and requires that exact digest.

Flow stores immutable candidate and baseline activation artifacts below `.flow/activations`. One
atomic index selects an exact artifact. The artifacts contain prompt text. Protect this directory
and `.flow/runs` as sensitive data. Each new run stores its exact selected activation snapshot.
Resume and detached execution use only that saved snapshot. Attached execution protects the
canonical project `.flow` directory. A detached job saves the same protected path and gives it to
the worker.

Rollback selects a stored candidate or baseline artifact for future runs. It does not change active
runs or delete artifacts. Flow does not add evaluation proof, activation digests, actor labels, or
reasons to model input. Direct model file tools cannot read or list `.flow` or protected run paths.
SRT denies the same paths to agent commands. An unsandboxed raw command keeps the operating-system
authority of the Flow process and can read same-user project files. Use SRT or a stronger boundary
when command output must not expose these files.

The tuning packet omits regression rows, holdout rows, and verifier evidence. Its parser rejects
contradictory outcomes, incomplete pairs, impossible schedules, and invalid totals. The packet is
not a confidentiality boundary for the evaluation-store owner.

Packet, candidate, and activation SHA-256 values identify exact content. They are not signatures or
authorship proof. A trusted same-user project owner can replace and re-digest project state. This
threat is outside the current boundary.
