# Security policy

## Reporting a vulnerability

Do not file a public issue for a suspected vulnerability. Use the repository's private [GitHub security advisory](https://github.com/synaptiai/flow-harness/security/advisories/new) form and include reproduction steps, affected revision, impact, and any known mitigation.

The maintainers will acknowledge a complete report, assess severity, coordinate a fix, and publish disclosure information when users can take protective action.

## Supported code

Before the first stable release, security fixes target the latest revision on `main`. There is no promise of backports to earlier commits or `0.x` package snapshots.

## Current trust boundaries

The embedded Pi runtime runs with the invoking user's operating-system permissions. Command
descendants run through a required native OS sandbox. These boundaries aren't equivalent.

- Agent sessions receive a Flow-owned system prompt and exact Flow-owned `read`, `ls`, and hash-anchored `edit` tools whose canonical paths are confined to the execution workspace. Edit is declaration-gated, requires a current full-file SHA-256, changes only one existing UTF-8 file, coordinates cooperating Flow processes on the same host, atomically replaces the target, and denies run state and sensitive project paths. Pi built-in tools are disabled.
- Pi project extensions, skills, templates, themes, and context discovery are disabled.
- Command nodes preserve explicit argument arrays through an audited encoder and run inside the fixed SRT `workspace-write-network-deny-v1` profile.
- The profile denies network, undeclared Unix sockets, ambient credentials, host writes to run state or sensitive project metadata, and home reads outside the workspace except for the exact canonical SRT seccomp helper required on Linux. On Linux, SRT can hide a read-denied directory with an ephemeral mask. A write call in that mask can report success, but it cannot change the host path. That runtime-support file is re-exposed read-only when Flow is installed elsewhere. Ordinary workspace writes remain allowed by design.
- Same-workspace, same-policy concurrent commands share SRT's process-global session but receive distinct temporary directories and per-command filesystem configurations. A command for a different workspace or policy waits for every active wrap to release, then Flow resets and reinitializes the session before admitting it. Cancellation while queued starts no process, and a poisoned session fails queued work closed.
- The operator can select the container command profile on Linux x64. It projects one fixed
  `flow-container-v1` policy from the prepared Prime OCI attestation. Each command uses one Docker
  container and an exact argument vector.

- The fixed container policy has one read-write workspace bind and explicit read-only runtime
  support binds. It has a read-only root, no task network, and no IPC. It has no added capabilities
  and no new privileges.

- A command-only seccomp projection denies socket creation and socket-specific syscalls. The command
  inherits no network socket. Local TCP and Unix socket binding fail.

- Fixed resource limits also apply. The process-count ceiling uses the command container cgroup.
  Flow omits `RLIMIT_NPROC` because the command uses the host operator UID for workspace access.
  Linux accounts that rlimit across unrelated same-UID host processes.

- Nested protected paths are masked inside the workspace. Flow derives project `.flow` protection
  from the trusted project root. A broad workspace that contains that project, a protected parent,
  or an overlapping runtime support bind rejects before Docker mutation.

- Bounded, cancellation-aware sensitive workspace discovery masks existing environment files,
  private-key files, project `.flow` state, and private Flow workspace collections. Existing Git
  metadata stays readable through one inspected read-only path. Linked or special Git metadata is
  masked. This is not an atomic host filesystem snapshot. It does not contain concurrent changes
  by the trusted host user or root.

- A bounded workspace content snapshot binds readable file bytes and modes, directories, symlink
  targets, and masked exclusions. Masked secret content does not enter the digest. Flow observes
  at most 100,000 entries and 10 GiB of regular-file content. It re-observes the snapshot
  immediately before launch and rejects drift.

- Container sandbox evidence uses the SHA-256 digest of the complete submitted Docker
  configuration. It binds the attested fixed policy, exact command, workspace bind, masks, and
  read-only paths. It also binds the workspace snapshot, environment, and resource controls. Public
  evidence does not contain the private configuration or host paths.

- The container command profile uses the shared Linux kernel and Docker daemon. It is not VM-grade
  or multi-tenant isolation.

- Container command recovery writes an owner-only intent before Docker create and adds the inspected
  full ID before launch. Cleanup uses the exact full container ID and requires confirmed absence.
  It removes the private directory and durable record only after that proof. A live owner, changed
  runtime, foreign object, unresolved create, or uncertain cleanup blocks later container commands.
  Flow never removes a container by name alone.

- The active process retains failed preparation and lease settlement. It retries that settlement
  before any later create. The durable scanner correctly treats the same process as live.

- The optional Lean proof profile uses a separate digest-attested Linux x64 image. Preparation
  verifies fixed source archives and base images. It makes two clean final builds and compares their
  immutable image IDs. It also measures the checker artifacts and publishes an owner-only local
  attestation. Missing or inconsistent identity evidence fails before proof-container creation.

- A proof container has no network, credential lease, host bind mount, project write, or ambient
  home directory. It has a read-only root and one bounded `nosuid`, `nodev`, and `noexec` tmpfs
  workspace. Docker drops all capabilities except supervisor `CAP_SETUID` and applies
  `no-new-privileges`, seccomp, private namespaces, and fixed cgroup and rlimit ceilings.

- Before reading a proof request, the root supervisor checks its PID, credentials, capabilities,
  no-new-privileges, and seccomp mode. It also checks mounts, cgroup v2 limits, process limits,
  environment, and network interfaces. It compiles untrusted proof source as UID and GID 10001.

  The target tree exists and is locked before the separate submission tree is created. Each phase
  has a separate home. The supervisor copies each bounded no-follow artifact into the root-owned
  verifier directory before it starts the next phase. The proof phase can't change the frozen
  target. It receives the exact statement and proof, but not the source specification.

- Each proof compiler and checker uses a separate process group. The supervisor kills and reaps the
  complete group before it freezes artifacts or starts another checker. Unconfirmed descendant
  removal fails the proof attempt.

- Proof acceptance requires exact request and runtime identity. It also requires successful Lean
  compilation and SafeVerify replay under the closed axiom policy. Nanoda must independently accept
  the exported environment, and Flow must confirm container removal. Human approval separately
  binds the source specification to the formal statement. A proof or model verdict can't replace
  that approval.
  It also can't replace ordinary test evidence.

- Proof recovery uses an owner-only write-ahead lease. The lease binds the run, workflow, node,
  attempt, request, image, profile, deterministic name, and full container ID when known. Recovery
  checks the inspected container and effective host policy. It confirms removal and then blocks
  automatic proof retry. Identity drift or uncertain cleanup retains the lease and can't become
  success.

- The proof appliance shares the Docker daemon and Linux kernel with the host. Root, the trusted
  host operator, a Docker compromise, a kernel defect, and hostile multi-tenant isolation remain
  outside this boundary.

- `flow web` binds one explicit IPv4 loopback listener to an ephemeral port. A random 256-bit
  capability enters the initial URL fragment, tab-scoped `sessionStorage`, and later authorization
  headers. The fixed client clears the fragment after startup and clears the stored capability when
  terminal observation settles. A related browser context can receive an initial storage copy, but
  the fixed client never opens one. It never uses a cookie, `localStorage`, a request URL, or durable
  Flow state. API requests require the exact host and browser Fetch Metadata context, and action
  requests also require the exact origin.

- The browser host serves fixed offline assets under a closed content policy. It exposes no CORS,
  cookie, service worker, external resource, raw event, or package code. It retains one bounded
  complete public presentation document and one observer. Header, body, JSON, output, and delivery
  limits fail closed.

- The browser boundary protects against other operating-system users and ambient web origins. It
  also protects against accidental disclosure. It does not protect against a malicious same-user
  process.

- Container command execution uses Docker's structured attach, start, and wait API operations.
  Flow attaches before start, separates multiplexed task output, and gives the long wait the command
  cancellation signal. Private Docker response, socket, path, and stream errors map to fixed public
  stages. Docker control output cannot become durable task evidence. A control failure after
  possible start retains bounded task evidence and reports uncertain command side effects.

- The container profile does not put provider credentials, Docker control access, or a model runtime
  inside the command container. The host-side Flow and Pi processes retain the invoking user's host
  authority. Root, the trusted host operator, a Docker daemon compromise, or a host-kernel defect is
  outside this boundary.

- Child workflows run from owner-only, content-verified reflink-or-copy working-tree snapshots. Flow excludes `.flow` and the configured run-store path, rejects special files and bounded-size overflow, and records the snapshot identity in both ledgers. Ordinary child workspaces are discarded after terminal settlement. Successful compiler-generated optimization candidates normally remain retained until their typed check rejects or conclusively promotes and cleans them. This prevents ordinary child writes from changing the parent working tree; it is not an atomic filesystem snapshot, VM-grade sandbox, or boundary against the invoking user. Host-side Pi retains that user's authority subject to Flow's tool broker, while child command descendants still use SRT.
- Candidate capture separately bounds changed entries, logical file bytes, and serialized durable
  evidence. A cancellation after candidate success but before its check retains the isolated
  candidate for diagnosis. It performs no evaluation, promotion, or parent mutation, and starts no
  later candidate.
  Operators must treat retained candidate workspaces as untrusted artifacts.
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
  and inert workflow source ABIs. The two install commands are the only package network operations.
  The HTTPS form requires one canonical public URL and caller-supplied lowercase SHA-256. It follows
  no redirect and sends no ambient credentials.

- The OCI form requires one canonical HTTPS repository with public pinned addresses. It also
  requires an exact manifest digest, certificate issuer, and certificate identity. It accepts only
  the fixed two-layer Flow artifact. It requests one exact repository-pull scope. Flow pins public
  DNS answers, denies unsafe redirects, checks descriptor bytes, and uses shipped offline Sigstore
  trust material. Installation runs no package code, dependency manager, hook, or driver.

- Anonymous OCI access remains the default. Optional private access requires one bounded username
  with visible non-space ASCII characters. It also requires the paired `--password-stdin` switch.

- Flow validates the exact HTTPS Bearer realm, service, and pull scope. It does this before reading
  at most 16,384 UTF-8 secret bytes. It sends Basic only to that token realm. It sends Bearer only
  to the original registry. It requests no refresh token.

- The selected registry controls its challenged authorization realm and service. Flow validates
  and preserves those values but cannot prove common ownership across origins. The operator must
  trust the registry and its delegated token service. A registry-specific credential limits this
  residual delegation risk. The returned Bearer token is opaque. Flow confines it to the original
  registry and exact digest reads but cannot verify its embedded grants.

- Flow stores no OCI login, username, realm, credential mode, or authorization value. It reads no
  Docker configuration, credential helper, password argument, or environment credential.

- Installed bytes are stored once at `.flow/packages/sha256/<digest>.flowpkg`; activation is the
  deterministic `.flow/packages.lock.json` entry published last under an owner-checked local lock.
  Missing, corrupt, replaced, symlinked, identity-inconsistent, or colliding state fails closed.
  Mutation locks are never reaped automatically: an operator must verify that no mutation is active
  before removing an exited owner's exact lock. A `commit_uncertain` result requires local lock/blob
  inspection and verification before retry. New store-directory entries are parent-synced before a
  lock can reference them; bounded reads and traversal budgets remain enforced during source races.
  Local inspection/removal and workflow execution never fetch the recorded source or contact a
  signature service. A signed OCI lock entry records exact registry and publisher admission data.
  A signature authenticates the admitted publisher for the exact bytes. It does not prove safety,
  correctness, freshness, revocation state, or rollback protection. Treat the source, digest,
  publisher policy, lock, and package content as trusted project configuration. Review them before
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
- A run work profile is durable model guidance, not an authority or resource control. `fast`,
  `standard`, and `long` cannot change the selected model, tools, approvals, policy, scheduler, or
  numeric limits. A model-facing `unbounded` value means only that Flow has no configured limit for
  that dimension. Provider and host limits still apply.
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

The native Pi and OMP evaluation profiles run in separate SRT processes on Linux. Flow requires the
verified PID namespace. Flow protects the plan root, evaluation state root, configured project
`.flow` root, private workspace collections, and provider credential locations. The child receives
no provider credential. The host broker owns provider access.

The profile exposes only workspace-confined `read` and `edit` tools. Flow rejects absolute and
relative paths that resolve outside the canonical trial workspace. The SRT policy supplies a
second filesystem boundary and denies task network access.

The parent and child use private pipes with signed, ordered, bounded JSONL frames. The session key
does not enter the plan, environment, command line, workspace, or model context. The parent owns
process and termination evidence.

Pi admission binds Node and the installed closures for Flow, Pi, Pi AI, and SRT. OMP admission binds
an official Bun executable through a built-in release attestation. It also binds the installed
closures for Flow, OMP, OMP AI, and SRT. The OMP closure includes runtime Markdown and the exact
package-resolution graph. Flow observes the directories that can change resolution. Flow checks
observed file and directory identities before each later trial. A change rebuilds the digest and
rejects the admitted identity.

The OMP child receives a trusted `NODE_PATH` that names only search containers that selected a
bound package. Ambient `NODE_PATH` does not enter the child. SRT grants read access to each exact
selected package root. It does not grant read access to a search container or an unselected sibling
package. Flow rejects admission if a selected package root contains an unselected nested package.

Immediately before process start, Flow compares the prepared SRT evidence with the admitted
runtime identity. The check covers containment, backend, version, profile, and policy digest. A
difference stops the trial before process start.

The Prime Agent evaluation profile uses a separate Docker OCI boundary on Linux x64. An explicit
preparation command builds the fixed image twice and records one protected local attestation.

The container has no external network route, host bind mount, Docker log, health check, or provider
credential. The host broker owns every model request. Private loopback supports only the IPython
kernel inside the container network namespace.

Flow applies exact CPU, memory, swap, PID, I/O, file, descriptor, byte, and inode limits. One
daemon-global slot prevents concurrent Prime containers. Host admission keeps capacity for Flow,
the broker, and cleanup.

Node and Python use different user identities. The fixed seccomp policy blocks cross-process memory
access. The trusted Node driver signs protocol frames. The supervisor verifies and relays them.

The supervisor also owns workspace transfer. It removes all Python processes before result export.

Each Prime attempt stores one durable OCI lease. Recovery accepts only the exact nonce, name, image,
policy, daemon endpoint, and full container ID. Uncertain removal blocks later Prime execution.

Public evaluation evidence omits the Docker socket, daemon ID, device identity, container name, and
lease path. Offline inspect and export do not load Docker, Prime Agent, or Python.

SRT is not a microVM. It cannot protect against a kernel defect, an SRT defect, root, or a process
with the same trusted account authority. Use a stronger runtime for hostile or multi-tenant tasks.

Docker isolation is not a virtual machine. The Prime boundary does not protect against a host
kernel defect, Docker daemon compromise, root, or the trusted host operator.

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
