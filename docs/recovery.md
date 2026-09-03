# Recovery and interruption safety

Flow can resume an interrupted run when its durable ledger proves that execution stopped between
node attempts. An agent node may also opt into a bounded fresh attempt when replay proves the open
attempt applied no effects. The same opt-in can retry a completed provider execution failure. The
terminal evidence must prove that the attempt performed no effect. It must also account for every
bounded resource. Recovery remains conservative: ambiguous work is reported to the operator and is
never repeated automatically.

An interrupted agent attempt that selects `exec` never qualifies for fresh recovery. A completed
agent attempt that prepared a command, effect, or delegation also doesn't qualify. Command
attempts, model verifier attempts, and Lean proof verifier attempts remain ineligible. An open
verifier start is refused as uncertain.

## Lean proof appliance attempts

Before Docker creates a Lean proof container, Flow syncs an owner-private write-ahead lease. The
lease binds the run, workflow, node, attempt, proof request, image, profile, deterministic container
name, and full container ID when known. A process restart reopens that exact lease without following
symbolic links and reconciles the container by full ID or deterministic name.

Recovery validates the image, labels, request, profile, and effective Docker policy before it stops
and removes the container. Flow removes the lease only after Docker confirms that the exact
container is absent. Reconciliation doesn't grant retry authority: the original proof attempt
remains uncertain because the appliance might have observed or checked the proof before the
interruption. Resume records the verifier as non-success and doesn't start a replacement container.

An unknown container, changed identity or policy, failed stop, failed removal, or unconfirmed
absence remains blocked. Don't delete a lease or rename a container to force progress. Preserve the
run and lease evidence, reconcile the named container, and start a separately reviewed workflow
attempt only after absence is confirmed. Read
[Operate the Lean proof runtime](operations/lean-proof-runtime.md#recover-an-interrupted-attempt)
for the operator procedure.

## Preview release interruption

A preview archive is immutable after GitHub publishes its release. The release workflow doesn't
overwrite an existing tag, release, asset, or npm version. A failed draft upload, ambiguous publish
response, or registry error requires inspection before another action. Follow
[Recover from an interrupted release](operations/release-preview.md#recover-from-an-interrupted-release)
for the exact artifact and semantic-version rules.

## ACP editor sessions

`flow acp --actor <label>` stores its bounded session index below the selected runs directory. One
ACP session id is also the Flow run id. The descriptor fixes the canonical project, policy digest,
actor, and creation time. The durable supervisor command and `run_started` event bind the workflow
selected by `/flow-run`.

After a bridge restart, connect from the same canonical project with the same admitted policy.
Use ACP `session/list` to discover a session and `session/load` to replay its public durable state.
Use `session/resume` to restore the adapter without replay. Load and replay read only the session
descriptor and run ledger. They do not read live workflow, activation, candidate, capability,
registry, credential, or network sources.

Input EOF, an editor crash, a partial protocol write, or bridge process loss does not cancel an
already durable run. Restart the bridge and load the same session. An explicit ACP cancel or
`session/close` submits the existing deterministic durable cancellation command when a submission
exists. Closing an empty session creates no command. Repeating either operation is safe under the
supervisor command identity rules. Close blocks prompts only in that bridge connection.

A successful `session/load` or `session/resume` reopens the adapter from durable state. Use load
when the editor also needs public replay. Use resume when it needs only a new active adapter for
the same durable session.

A changed project or policy identity refuses the stored session. Do not edit the ACP descriptor or
run records to repair the mismatch. Restore the admitted project and policy, or inspect the run
with the ordinary `inspect` and `events` commands. A session-publication uncertainty requires the
same read-only reconciliation: list sessions and inspect the matching run before retrying. The
bridge has no remote, shared-user, or network recovery mode.

## Local ACP executor attempts

An ACP executor selection is part of the durable run capability snapshot. Resume the run with the
original workflow and run ID. Don't add `--acp-agent`. Flow reopens the stored manifest provenance.
It revalidates the exact runtime, model mapping, and accounting contract before process launch.

An eligible fresh recovery attempt starts a new process, private directory, and ACP session. Flow
renders the committed provider-neutral model-session record as a bounded recovery capsule in the
new prompt. The previous provider or ACP session is never resumed. The new session binding includes
the incremented attempt number and the same admitted agent digest.

Flow doesn't retry an ACP attempt automatically. A failure after the prompt starts is nonretryable
and has uncertain side-effect status because the provider might have observed work. Unconfirmed
descendant termination, cleanup uncertainty, and an open model-verifier attempt also block fresh
recovery. Inspect the durable failure and resolve the run explicitly.

## ACP qualification evaluations

Re-run `flow eval run` with the same evaluation identifier and exact qualification plan after an
interruption. Flow validates the evaluation record chain and committed schedule prefix, removes
deterministic workspace residue, and runs only the missing suffix. It never repeats a committed
trial or resumes an opaque ACP or provider session.

An unresolved adapter start becomes one interrupted harness failure for its schedule position. The
qualification report keeps that failure and cannot return `qualified`. Don't edit the ledger or
reuse its identifier with changed agents, manifests, workflow, task, controls, or environment.
Inspect the underlying run evidence. Start a new evaluation identifier only when you intentionally
begin a new qualification attempt.

Read [Qualify two local ACP agents](guides/qualify-acp-agents.md) for the complete operator
procedure and verdict meanings.

## Recover a goal workspace

The project goal workspace uses an append-only full-revision ledger at
`.flow/goal-workspace/events.jsonl`. `flow goal show` replays the bounded committed chain and returns
the current revision. `flow goal history` returns a bounded revision page. Neither command loads
the evidence events referenced by verified facts.

If a process stops before it writes a complete final line, readers ignore only that unterminated
tail. The next update truncates the tail while it holds the writer lease and then appends the new
revision. Don't truncate the file manually.

If an update reports `goal workspace commit is uncertain`, inspect the current revision before you
retry. Compare its revision and digest with the revision that you prepared. Retry only when the
exact revision is absent and no writer owns the ledger.

If an update reports `goal workspace writer settlement is uncertain`, treat both the revision and
the `.flow/goal-workspace/.writer` lease as unresolved. Confirm that no goal command is active.
Inspect the current revision and the complete owner record before you remove any stale local state.
Flow automatically retires a complete writer record only when its recorded local process no longer
exists. It rejects incomplete, malformed, linked, or otherwise unsafe writer state.

Committed corruption, a broken predecessor link, an invalid digest, an empty committed line, or an
unsafe ledger identity stops the complete replay. Preserve the project state for diagnosis. Don't
delete, reorder, or synthesize committed revisions.

An existing run doesn't consult this project ledger during resume. Its `run_started` event contains
the exact selected revision in the durable capability snapshot. Resume the run with its original
workflow and run ID. Don't add `--goal-workspace` to `resume`.

Read [Maintain a durable goal workspace](guides/goal-workspaces.md) for update and selection
procedures.

## Operator workflow

Inspecting a run is read-only and does not acquire execution ownership:

```sh
flow inspect <run-id> [--runs-dir <path>]
```

Resume with the exact workflow definition that started the run:

```sh
flow resume <workflow.yaml|workflow:name@version> --run-id <run-id> [--work-profile <fast|standard|long>] [--runs-dir <path>] [--cwd <path>]
```

Flow compiles the workflow before claiming the run. It then acquires exclusive local ownership,
replays committed events, and checks compatibility before observing any target. At a safe boundary,
it appends `run_resumed`. Successful nodes remain successful and are not executed again. Flow first
reconciles an open typed filesystem effect. The unfinished node remains refused unless its
persisted recovery policy and the resulting replay state satisfy every fresh-retry proof.
Pending nodes retain their normal dependency order and use the lesser of their declared timeout
and remaining active-execution budget. The command prints the same JSON `RunState` shape as
`flow run` when recovery can continue.

The original `run_started` event owns the durable work profile. Omit `--work-profile` to reuse it,
or provide the exact value as an automation check. A different value fails before execution or
ledger mutation. Recovery also requires every child ledger to carry its parent's durable profile.

A run that selects Agent Skills, versioned verifiers, versioned command tools, or versioned
workflows persists one
durable capability snapshot in
`run_started`. For a verifier package, replay reparses the captured manifest and reconciles its
name, exact version, driver kind, definition, manifest hash, package digest, compiled control-graph
reference, node requirement, and any committed verdict evidence. Resume resolves the package only
from that durable verifier package snapshot. It never reads `.flow/verifiers`; a caller-supplied
snapshot must have the exact durable aggregate digest or recovery refuses with `workflow_mismatch`.
For an installed package it likewise never reads `.flow/packages.lock.json`, reopens a bundle blob,
or contacts the recorded source URL. The lock and blob are admission inputs only; `run_started` is
the recovery authority. Optional `.flow/packages.metadata.json` is also an admission input only.
Expiry or revocation published after admission blocks a new catalog but does not rewrite,
terminate, or invalidate an immutable existing run snapshot. A private-registry username, token
realm, credential mode, password, Basic
value, or Bearer token is never part of the lock or run snapshot. Resume and replay never read
credential input or repeat registry authentication.
The same rule applies inside a child ledger, which may carry the parent snapshot but can bind only
its own compiled selections.

## Recover a presentation host

Presentation selection is session-local and is not run recovery authority. A restarted `flow tui`
or `flow web` command resolves a new exact `<name>@<version>` selection before host ownership. The
run ledger, replay identity, approvals, actions, workers, and child ledgers do not store that
selection or package note text.

An exact installed presentation package remains available offline through the content-addressed
package store. A restarted host does not contact the recorded HTTPS or OCI source. Run `flow
packages verify` after uncertain package-store settlement. Then use `flow presentations inspect
<name> --version <version>` before selecting the package again.

A changed local manifest, invalid note, missing exact version, local and installed collision, or
package-store mismatch rejects before supervisor, terminal, or browser ownership. Flow does not
restore a stale layout or silently use the default layout after an explicit selection fails.

Signed metadata candidates below `.flow/packages.metadata.candidates/sha256/` are inert review
state. Recovery, resume, replay, workers, and child runs never read them. A failed check before the
candidate rename leaves no candidate.

A late observation failure may leave a valid unreferenced candidate after its durable commit.
Repeat the exact check or inspect the candidate list. A
`capability_metadata_candidate_store_failed` result during candidate settlement means visibility
or directory durability could not be confirmed. Inspect the exact digest and candidate list before
retrying. Do not infer activation.

Candidate-store operations fail closed when `.flow/packages.metadata.check.lock` already exists.
Flow does not infer that a recorded process is dead and does not remove the lock automatically.
Confirm that no metadata check, list, inspect, activation, or removal operation owns the lock before
you remove that exact file. Flow does not delete crash debris automatically. Inspect and remove only
the exact `.flow/.packages.metadata.candidate.pending` directory or
`.flow/.packages.metadata.check.pending` file after the same ownership check. Candidate-store
commands fail closed while either path exists.

Activation reopens and re-verifies the candidate and then uses the existing active-metadata
mutation owner. Handle an activation `commit_uncertain` outcome like explicit local metadata
refresh. Inspect active metadata before retrying. Reconcile its exact version, digest, and signer
policy. Candidate removal never repairs, rolls back, or changes active metadata.

TUF repository state below `.flow/capability.repository/` is also admission-time authority only.
Runs, workers, children, resume, recovery, replay, inspect, and export use their frozen capability
snapshots and never consult repository generations or candidates. A pre-commit repository failure
leaves the current generation unchanged. A
`capability_repository_store_failed` result during `settle repository store commit` means the
new current record may be durable. Run `flow packages repository status` and inspect the exact
candidate digests before retrying.

Repository operations fail closed when
`.flow/capability.repository/repository.lock`,
`.flow/capability.repository/.generation.pending`, or
`.flow/capability.repository/.current.pending` already exists. Confirm that no initialization,
check, list, inspect, activation, or removal operation owns the state before removing only the
exact blocking entry. Do not remove a generation directory to repair a pending record. First
reconcile the current generation digest and candidate list from public status. Repository
activation is offline. A network request during activation indicates a boundary violation rather
than a recovery mechanism.

Repository replacement is also offline. Before the active lock rename, cancellation returns the
exact caller reason and the established generation remains active. A replacement
`commit_uncertain` result means the new lock may already be visible but its directory durability was
not confirmed. Run `flow packages list`, inspect both exact versions, and run
`flow packages verify` before retrying. A `settlement_uncertain` result means mutation-lock cleanup
also did not settle. Inspect `.flow/packages.mutation.lock`, verify that its recorded owner is no
longer active, reconcile both exact versions, remove only that exact mutation-lock file, and verify
again before retrying. Do not reinstall or remove either version until the active lock and mutation
owner are reconciled.

A settled `replaced` result reports `cleanup: retained`. The new lock is authoritative, while the
old immutable blob remains available to a reader with the prior lock. Existing runs, workers,
children, evaluations, recovery, and replay continue from their frozen package snapshots.

### Recover retired package maintenance

`flow packages prune` is a read-only preview. You can repeat it after any preview failure. Apply a
plan only with `flow packages prune --apply --expected-plan-digest <sha256>`. Flow rebuilds the plan
under `.flow/packages.mutation.lock` and refuses drift before it unlinks content.

If cancellation or a failure occurs before the first unlink, the candidate set is unchanged. Create
a new preview before another apply attempt. If cancellation or a later-candidate failure occurs
after an unlink, Flow syncs the blob directory before it returns. Create a new preview. It contains
only the retired blobs that remain.

If apply reports `settlement_uncertain`, don't assume that an unlinked name is durable. Confirm that
no package mutation is active. Inspect `.flow/packages.mutation.lock` and remove it only after you
verify that its recorded process has exited. Then run `flow packages verify` and create a new prune
preview. Don't restore or delete a blob by guessing from the prior plan.

Pruning reports logical bytes unlinked, not guaranteed physical disk space reclaimed. An existing
reader can keep an unlinked inode alive through an open handle. Let that reader finish or stop it
through its normal lifecycle. Don't modify the content-addressed directory manually.

An optional repository scheduler records a fixed startup status. Its caller can supply the prior
completed-check timestamp after restart. The scheduler reports elapsed missed intervals but waits a
new full interval and never catches up. A current clock behind the prior completion reports
`clock_rollback` and stops before network work. Consecutive `check_failed` records expose a prolonged
outage without preserving private transport or repository errors.

The foreground repository watcher holds
`.flow/capability.repository/watcher.lock` across restart-state inspection, checks, replacement, and
shutdown. A live or uncertain record blocks another watcher before network work. Flow does not
retire it automatically. Confirm that no watcher is active before removing only that exact file.
Then inspect repository status, run `flow packages verify`, and reconcile the installed version
before restarting.

A watcher can continue after one inert check failure only after another full interval. It stops on
baseline drift, clock rollback, status failure, replacement failure, or commit uncertainty. Do not
restart after replacement failure until repository and package state are inspected. A settled
replacement retains the prior immutable blob until an operator applies an exact prune plan. A
reader that already opened the old blob can finish after that path is unlinked.

The first-activation command uses the same owner record. Its state is one
`first-activation-<identity>.json` file below `.flow/capability.repository/`. A waiting record binds
the exact package, version, publisher, interval, attempt limit, consumed attempts, and clock
high-water. A prepared record also binds the exact candidate, source, bundle, and Sigstore receipt.
A settled record consumes the one-shot authority permanently.

Restart with the same exact arguments. A waiting restart waits a new full interval. A prepared
restart reopens the exact candidate without network access. It installs only when the package is
missing and active metadata still authorizes it.

If the exact package is already visible, the
restart records settlement without a second install. A settled restart returns
`already_activated` only while the exact package is still visible. A missing or conflicting settled
package fails without a repository request or reinstall.

Strict first installation rejects another active version with the same package name while it owns
the package mutation lock. It also checks the prepared clock high-water and exact authenticated
repository candidate immediately before package publication. After package commit, settlement uses
the prepared high-water instead of consulting a fresh clock. A watcher-lock release failure does
not replace an earlier operation or cancellation failure. A release-only failure reports fixed
settlement failure. It requires watcher-lock remediation.

A failed pre-rename write retains
`.first-activation-<identity>.json.pending` and blocks later inference. Confirm that no repository
watcher or first-activation command is active. Preserve the pending file for diagnosis. Inspect
repository status and run `flow packages list` and `flow packages verify`.

If the installed package
and current record are safe, remove only that exact pending file and restart with the same
arguments. The controller will reconcile from the prior durable state. Never remove a settled
record as routine cleanup. Removing it would discard the proof that the one-shot authority was
consumed.

For a workflow package, resume accepts `workflow:<name>@<exact-version>` and reconstructs the root
and every transitive packaged child from the durable snapshot before claiming the run. It verifies
manifest/source hashes, package digest, compiled source-package identity, run-start requirements,
and control graph. It never reads `.flow/workflows` or substitutes the live catalog; a changed,
removed, missing, or extra package fails with `workflow_mismatch` before an executor starts.

For a command tool package, replay reparses the durable command tool package snapshot and
reconciles its name, exact version, definition, manifest hash, package digest, compiled node
selection, control-graph command-tool declaration, and every sourced request. A sourced request is
valid only when replay can reproduce its typed input digest and exact executable, argv, and timeout
from the frozen definition. Resume never reads `.flow/tools` and never accepts a caller replacement.
An agent with a package command is command-capable even when it does not declare raw `exec`: an open
attempt remains `uncertain_operation`, and the compiler rejects fresh recovery because arbitrary
process effects cannot be reconstructed from workspace observation.

When a concurrent wave was interrupted, Flow processes every open attempt in workflow declaration
order. It first reconciles every open typed effect in that order, then appends one
`node_attempt_interrupted` disposition for every proof-safe attempt, and finally appends one
`run_resumed`. A command attempt or any other unsafe sibling still blocks new execution; already
committed reconciliation and safe dispositions remain valid evidence. Repeating resume continues
from that prefix without duplicating events.

Agent command execution has its own `flow.agent-commands/v1` write-ahead ledger. A normalized
executable/argv/deadline request and its exact allowed `process.execute` decision are committed
before spawn; the bounded outcome is committed afterward. Resume never runs an open or settled
agent command again and cannot reconcile arbitrary process side effects from filesystem
observation. The compiler therefore rejects `recovery: { mode: fresh, ... }` whenever the node
selects `exec`, and a command-capable open attempt is reported as `uncertain_operation`.

Child recovery uses the child ledger as the execution commit marker and the workspace manifest as
its isolation proof. The parent derives the same child run and workspace identities from its own run,
node, attempt, and compiled child digest. If no child event was committed, Flow may discard a stale
pre-ledger workspace and recreate the child. Once any child event exists, resume must reopen the
exact workspace manifest and snapshot digest and then apply the ordinary recovery rules to that
separate ledger; a missing or divergent workspace fails with `child_recovery_ineligible` and no
replacement child starts. A terminal child ledger remains authoritative if cleanup completed before
the parent imported its outcome. Flow idempotently confirms discard, verifies the linked evidence,
and appends only the missing parent outcome.

To submit either operation to the local supervisor, add `--detach`:

```sh
flow run <workflow.yaml|workflow:name@version> --detach --run-id <run-id> [--command-id <uuid>]
flow resume <workflow.yaml|workflow:name@version> --detach --run-id <run-id> [--command-id <uuid>]
flow supervisor status
flow events <run-id> --after 0 --follow
```

The client returns one of three durable admission outcomes. `accepted` means the exact source,
active reservation, and claim are durable and an authenticated worker has accepted ownership;
`queued` means the exact source and FIFO ticket are durable but no claim or worker exists; and
`rejected` with `queue_full` means the compact rejection is durable and no executable source
snapshot was retained. Acceptance is a process-lifecycle guarantee, not a successful workflow
result. A later client can page ledger events, follow to a terminal event, or cancel active or queued
work with
`flow cancel <run-id> --actor <label> [--reason <text>] [--command-id <uuid>]`.

The terminal host retains no separate run history or mutation authority. After a terminal failure,
signal, or operator exit, it stops input and restores the terminal exactly once. An approval or
cancellation that already crossed its mutation boundary settles through the existing durable
control before the host reports the result. Reopen `flow tui` to replay from sequence zero, or use
the JSON `inspect`, `events`, `approve`, `deny`, and `cancel` commands. A renderer failure never
advances or repairs the run ledger.

Flow generates command ids when omitted. A caller that needs retry safety across a lost response
must persist a UUID before the first request and reuse it with byte-equivalent input. A reused key
with different input is rejected. Submission commands are journaled before admission: exact retries
replay accepted, queued, or rejected outcomes and retain the original queue ticket. A snapshot left
before its admission event is inert; an exact retry can complete the missing transition with the
same identity. Once execution may have crossed the authenticated worker boundary, uncertainty is
reconciled only from that matching worker and never causes a second spawn.

A command or graph approval wait returns process exit code 3 and can be decided after the original
client exits:

```sh
flow inspect <run-id>
flow approve <run-id> <request-id> --actor <label> [--runs-dir <path>]
flow deny <run-id> <request-id> --actor <label> [--reason <text>] [--runs-dir <path>]
```

Approval and denial claim the run and append the event family required by the pending request.
Command approval does not execute; resume separately consumes a still-valid grant. Graph approval
immediately completes the pure control node, but downstream work still requires an explicit resume.
The actor label is caller-supplied audit attribution rather than authenticated identity.

Live agent-command approval uses the same CLI but a different ownership path. The attached process
or detached worker keeps the Pi tool promise open and remains the only ledger writer. A decision
client publishes an immutable sidecar; the owner validates it and appends the decision before one
matching command preparation. Ordinary approval therefore needs no `resume`. If the owner process
dies while the tool call is suspended, the pending request remains inspectable but is not a safe
committed boundary: Flow cannot reconstruct Pi's opaque transcript or promise and refuses recovery
with `uncertain_operation`. A sidecar without an owner-appended decision never grants authority.

## Recovery boundaries

| Last committed state | Recovery behavior |
| --- | --- |
| `run_started` or a completed executable/control transition | Append `run_resumed` and apply the next declaration-ordered legal transition |
| A result source succeeded but no result transition is durable | Append `run_resumed`, reparse the durable source with the persisted schema, and publish or fail the result without invoking an executor |
| `node_result_published` is durable | Verify source, schema, canonical value, and hashes during replay; continue after the result without republishing it |
| All nodes succeeded or were omitted but `run_succeeded` is absent | Append `run_resumed`, append `run_succeeded`, and execute no node |
| `node_failed` is durable, no limit is exhausted, and `run_failed` is absent | Append `run_resumed`, append `run_failed`, and do not retry the failed node |
| A completed node outcome reaches a model-token, reported-cost, active-time, or artifact limit but `run_budget_exhausted` is absent | Replay the exact retained payload bytes, append `run_resumed`, append `run_budget_exhausted`, and execute no node |
| A start limit is exhausted and pending work remains | Append `run_resumed`, append `run_budget_exhausted`, and execute no node |
| `command_approval_requested` is pending | Append `run_resumed`, retain `waiting_for_approval`, and execute nothing |
| `command_approval_granted` is unexpired | Append `run_resumed`, consume the exact grant in `node_started`, and execute once |
| `command_approval_granted` has expired unused | Append `run_resumed`, record expiry, create a fresh request, and execute nothing |
| `command_approval_denied` is durable but `run_failed` is absent | Append `run_resumed`, append `run_failed`, and execute nothing |
| A live `agent_command_approval_requested` has no terminal decision because its owner died | Preserve the exact request, refuse with `uncertain_operation`, and do not synthesize a Pi tool continuation or command preparation |
| An agent-command grant was committed but not consumed before its owner died | Preserve the unconsumed authority, refuse with `uncertain_operation`, and execute nothing |
| `workflow_approval_requested` is pending | Append `run_resumed`, retain the exact request and `waiting_for_approval`, and execute nothing |
| `workflow_approval_approved` is durable | Append `run_resumed` and apply only the next graph-declared transition |
| `workflow_approval_denied` is durable but `run_failed` is absent | Append `run_resumed`, append `run_failed`, and execute nothing |
| One or more opted-in agent `node_started` events are below their attempt caps, have accountable start capacity, and have no effects or only effects proven not applied | Reconcile every open typed filesystem effect and append each `node_attempt_interrupted` in declaration order; append one `run_resumed`, then admit fresh attempts under the persisted concurrency limit |
| An opted-in agent `node_started` has an applied, committed, unknown, open, legacy writable, attempt-exhausted, or unaccountable budget state | Preserve any reconciliation prefix, refuse with `recovery_retry_ineligible`, and invoke no executor |
| A command or model verifier `node_started` has no matching outcome | Refuse with `uncertain_operation`; don't repeat its command or model invocation |
| A Lean proof verifier `node_started` has no matching outcome or a prior proof-container lease | Reconcile only the exact leased container, require confirmed absence, refuse with `uncertain_operation`, and don't repeat the proof attempt |
| An unconfigured `node_started` has no matching outcome | Preserve any reconciliation prefix, refuse with `uncertain_operation`, and append no retry disposition or `run_resumed` |
| Run is `succeeded`, `failed`, `cancelled`, or `resource_exhausted` | Refuse with `terminal_run` |
| Workflow identity, version, digest, work profile, budget, node set, persisted control graph, or committed transition order differs | Refuse with `workflow_mismatch` |
| Durable capability snapshot; skill, verifier, command-tool, or workflow-package requirement; exact version/kind; or package-use evidence differs | Refuse with `workflow_mismatch`; do not read or substitute the live package catalog |
| A new run is resumed with a different normalized execution directory | Refuse with `execution_context_mismatch` |
| No child event is durable, but a stale deterministic child workspace exists | Discard the uncommitted workspace, recreate it from the parent, and start the child once |
| A child ledger is nonterminal and its exact work profile, manifest, snapshot digest, or workspace is missing or divergent | Refuse with `child_recovery_ineligible`; do not create a replacement child or repeat uncertain work |
| A valid nonterminal child workspace is in the old run-store location | Validate the old exclusion identity, translate a nested parent path when necessary, and move and sync the complete identity directory to the private project-sibling collection. Across filesystems, use a bounded verified staging copy. Reopen it, record `run_resumed.workspaceRelocation`, and then continue recovery. |
| A child ledger is terminal but its parent outcome is absent | Treat the child ledger as authoritative, idempotently confirm workspace discard, verify its linked typed result and resources, and append only the parent outcome |
| A parent child outcome is durable but the parent run is nonterminal | Re-reduce every settled child ledger recursively and compare its work profile, link, terminal sequence, outcome, typed result, duration, workspace provenance, and all five resource totals with the imported projection; refuse divergence with `child_recovery_ineligible` before appending `run_resumed` |
| An optimization candidate succeeded but no evaluation is durable | Append `run_resumed`, recompute metric/invariants from its canonical child result, reopen an exact durable capture or capture the same bounded delta, and record one evaluation; a partial or divergent capture fails closed |
| `node_optimization_evaluated` chose promotion but prepare is absent | Reuse the captured delta identity and enter promotion once; never rerun the child |
| `node_optimization_promotion_prepared` has no settlement | Reconcile the exact local journal and affected paths, then append committed, rolled-back, or unknown settlement |
| Promotion settlement is committed but cleanup or check completion is absent | Retry idempotent workspace cleanup and append only the missing cleanup/check transitions; never reapply the delta |
| Promotion settlement is rolled back or unknown | Fail the check with no side effects or uncertain side effects respectively; retain diagnostic artifacts and start no downstream node |
| A check is complete but later candidates or the controller are absent | Append `run_resumed`, apply its durable continue/stop guard, omit or schedule only the next finite candidate, and derive controller completion from checks |

A started attempt is uncertain because its command, model, or external tool may have performed an
effect before the process stopped. Flow does not infer failure, success, or idempotency from the
absence of a result. Command nodes never receive an automatic recovery policy.

Typed result publications, condition decisions, loop checks and completions, omissions, and joins
are safe committed boundaries because they do not invoke an executor. Recovery replays their
persisted control graph and validates each source attempt, field, and hash. A result additionally
reparses the original durable source, reapplies the bounded schema, reproduces canonical JSON, and
checks its schema and value hashes. Other controls validate the selected case or loop decision,
omission reason, loop iteration/guard, controller result, and join mapping against the scheduler's
canonical next transition. Persisted loop topology additionally requires registered ordered checks,
structurally isomorphic body clones, and the same exact stop contract in every iteration. It never
reevaluates a result, condition, or committed loop check from the current workspace or a changed
workflow file. If a crash occurs after one of these events is synced, resume continues
from the following transition without repeating its source node. A retry of an interrupted
iteration-qualified agent increments that instance's attempt; it does not advance the loop.

Optimization checks are also resource-neutral control nodes, but promotion contains an external
filesystem saga. Evaluation persists canonical baseline/candidate metrics, expected and actual
invariants, complete sorted before/after delta entries, and a recomputable manifest digest before
promotion. The adapter then stores candidate and rollback blobs plus a local journal before asking
the application to append `node_optimization_promotion_prepared`. It cannot begin an affected-path
mutation unless that callback succeeds.

The promotion journal advances through deterministic forward and rollback steps. A crash can be
observed at the durable-temporary, applied-step, rollback-step, or local-commit boundary. Recovery
checks the journaled step and the one-step crash window against exact before/after identities,
removes only promotion-owned temporary paths, and either completes compensation, confirms the
committed after-state, or records `unknown/affected_path_diverged`. It never treats a partially
matching path set as success. The run event settlement is distinct from the local journal: a
committed local journal with a missing event is reconciled forward, while a committed event is
never applied again.

Cleanup follows only rejection or a conclusive promotion settlement. A crash after filesystem
cleanup but before its event causes the same workspace-id cleanup to run again; the production
operation is idempotent. A retained workspace is never silently replaced. Replay independently
recomputes typed observations and the delta digest, binds prepare/settlement to the exact promotion
id, and requires cleanup before check completion when candidate evidence says retained.

Writable agent attempts add more precise, but non-terminal, evidence. `node_started` declares
`flow.effects/v1`. Flow syncs `node_effect_prepared` before an atomic file rename, file-create link,
or nonrecursive `mkdir`. The event records the stable effect identity, operation kind, target,
request digest, after hash, and mode. An edit or complete replacement also records its before hash.
A file or directory create records a null before hash because the path is absent.

Flow later syncs exactly one settlement. The value is
`committed/directory_synced`, `not_applied/commit_not_entered`, or
`unknown/post_commit_failure`. A process death can leave an unresolved prepared effect,
or a settled effect without a node outcome. Inspection preserves that distinction.

For each unresolved prepared filesystem effect, recovery enters the same target queue and
cross-process lock as normal mutations. For a file effect, it rejects non-regular targets before
opening them. It opens without following symbolic links and hashes the initially observed size in
fixed chunks. It then compares the regular-file SHA-256 and POSIX mode.

For a directory effect, recovery rejects a non-directory target. It reads the directory entries
only until it finds the first entry and then rechecks the target identity. A nonempty directory
becomes `unknown/target_not_empty`. Only an unchanged empty directory with mode `0755` matches the
prepared after-state.

The edit observation limit is 8 MiB. The create observation
limit is 256 KiB. Directory observation uses a bounded empty-state comparison. Recovery appends
`node_effect_reconciled` while it holds the target lock.

If the target's parent has disappeared, the sibling lock cannot exist. Recovery
rechecks the path and can publish only `target_missing` under the in-process target queue.
It publishes nothing if any target is observable. An exact after-state becomes
`applied/target_matches_after`. An edit or complete replacement's exact before-state becomes
`not_applied/target_matches_before`.

A missing file or directory create remains unknown because recovery cannot distinguish a
pre-mutation crash from an applied object that another actor later removed.

Missing, wrong-type, unreadable, oversized, divergent, wrong-mode, or raced targets become
`unknown` with a bounded reason. The event retains a digest and mode only for a stable file or
directory observation. It stores no file bytes, directory entry names, or raw operating-system
error message and never changes the target.

Recovery provenance is separate from execution settlement. Observing the after-state does not
prove that the original directory sync, provider response, usage report, or whole node completed.
It therefore blocks a fresh attempt. Observing the exact before-state proves only that this prepared
file mutation was not applied. Every effect on the attempt must independently reach that result. Repeated
recovery skips already settled or reconciled effects. If observation or event publication fails
partway through multiple effects, the durable prefix remains and only later open effects are
eligible next time. A live or malformed target lock leaves the effect open rather than publishing
stale evidence.

### Proof-safe fresh attempts

An agent node opts in through:

```yaml
recovery:
  mode: fresh
  maxAttempts: 3
  backoff:
    initialDelayMs: 30000
    maxDelayMs: 120000
```

`maxAttempts` counts the initial attempt. The compiler accepts 2 through 16 and inserts no default.
At run start, Flow persists the node id, mode, cap, and required effect protocol so replay never
consults a changed workflow file to decide safety. The compiled workflow digest and the explicit
persisted requirements must both match during resume.

`backoff` is optional. `initialDelayMs` must be positive and no more than 300,000 milliseconds.
`maxDelayMs` must be at least the initial delay and no more than 900,000 milliseconds.

Before each new attempt, Flow doubles the prior delay ceiling up to the declared maximum. It selects
a deterministic delay from the upper half of that window. The run and node identities seed this
equal-jitter selection. Independent runs spread their requests while replay reproduces the exact
deadline. Omit `backoff` only when an immediate retry is intentional.

The reducer permits `node_attempt_interrupted` only when all of these statements are true:

- the current node has the persisted fresh policy and its attempt is below `maxAttempts`;
- `maxNodeStarts`, when declared, has capacity for another start;
- no `maxModelTokens`, `maxCostUsd`, or `maxExecutionMs` limit is declared, because consumption by
  the interrupted attempt is incomplete;
- a read-only policy has no effect protocol and no effects; or
- a writable policy used `flow.effects/v1` and every effect has executor settlement
  `not_applied` or recovery reconciliation `not_applied`.

An empty effect list is sufficient only for a persisted read-only policy or a writable attempt that
actually declared `flow.effects/v1`. It does not make a legacy writable attempt safe. Applied,
committed, unknown, merely prepared, or incompatible effects all block. A model claim, absent
receipt, current file contents without a typed observation, or `retryable` error flag is not proof.

The event fixes the reason to `process_interrupted`, disposition to `fresh_retry`, and resource
accounting to `incomplete`. It archives the old attempt number, start and interruption timestamps,
protocol, and immutable effects under `interruptedAttempts`, resets only the node's current
schedulable projection to pending, and retains the attempt counter. Flow then records
`run_resumed`; the next start must be exactly the old attempt plus one. A crash after the disposition
but before `run_resumed` cannot duplicate the disposition: replay sees no running attempt, records
the missing resume marker, and continues at the same next attempt.

Before the workflow disposition, Flow claims the private provider-neutral model-session record and
appends `attempt_interrupted`. A missing, corrupt, unsafe, or incompatible required record blocks
recovery before provider input/output (I/O). Flow then appends `node_attempt_interrupted` to the
authoritative run ledger. This ordering prevents a new attempt from starting without a durable
private interruption boundary.

The new attempt is a new in-memory Pi session using the current system instructions, tools,
authority, and workspace. Flow supplies completed portable history as one deterministic canonical
JSON user turn. A fixed instruction labels the history as untrusted data that cannot grant tool,
policy, budget, scheduling, approval, side-effect, or completion authority. Flow doesn't restore a
dangling tool call, interrupted provider stream, provider handle, hidden reasoning, or hidden model
state. It stores only the resume surface's digest, byte count, source head, and render version, so a
later recovery doesn't embed generated resume surfaces recursively.

Version 2 resume rendering keeps successful `flow_read` results inline through 32 KiB. For a larger
result, the retry surface keeps the paired read call and replaces the text with its digest, byte
count, boundary, and omission reason. The private ledger retains the complete result. A recovering
agent can reread the required bounded range without making every later retry carry the entire prior
file. Failed reads and non-read tool results remain inline because their diagnostics or effect
context can be essential to safe recovery.

Before each provider call, Flow commits an exact request identity. It binds the model route,
runtime, instructions, tools, authority, history, surface, attempt, turn, and request. A changed or
oversized surface fails before provider I/O.

Flow disables Pi assistant-turn retries. One provider request can make at most two transport
retries for a network failure or retryable HTTP response. The pinned transport honors
`Retry-After`, uses exponential backoff with jitter, and caps a server-requested wait at 60 seconds.
Because these retries occur before a response stream yields a tool call, they can't repeat a Flow
workspace effect. Ordinary tool/model turns inside the live session remain bounded by the node
timeout. Read
[Inspect and recover portable model sessions](guides/model-sessions.md) for the public inspection
fields, limits, and remediation table.

Artifact accounting does not block this fresh retry because an open attempt has no committed
terminal evidence payload. Only a later durable success/failure outcome contributes its command,
agent, verifier, or child payload bytes. If Flow later persists streamed artifacts before a terminal
outcome, that storage contract must add an explicit interruption-accounting rule rather than
silently changing this behavior.

Fresh retry is also distinct from completion proof. The retried agent must still produce its own
terminal evidence, and downstream deterministic verifier nodes still decide criterion acceptance.

### Retry or continue after a completed provider failure

The embedded Pi adapter classifies only these completed provider failures as retryable:

- Pi returns a terminal provider `error` without a stable model-context failure code.
- The provider runner throws an error that isn't a Flow capability-evidence or semantic-evidence
  validation failure.

Flow treats an `insufficient_quota`, `credit_balance_exhausted`, or
`billing_hard_limit_reached` provider response as the stable, non-retryable
`pi_provider_quota_exhausted` failure. This rule is distinct from an ordinary
`rate_limit_exceeded` response, which remains a retryable provider error. Restore the provider
credit balance or quota, then start a new run. Preserve and inspect the failed run because a
terminal quota failure can't resume. Flow records only the stable failure code and safe message in
node evidence. It doesn't persist the provider's raw error text.

Flow keeps cancellation, timeout, retained-report byte exhaustion, policy failure, stable
model-context failure, stable provider failure, validation failure, and operator denial
non-retryable. A side-effect-free transient provider failure can start a fresh attempt. A settled
provider `length` stop can also start a fresh attempt when the exact durable model-session record is
available. Either failure after workspace edits can continue only when every edit settled as
committed. Recorded commands, delegations, uncertain edits, and other failure classes remain
ineligible. These rules prevent a generic provider error from overriding stronger durable
evidence.

Fresh recovery doesn't restore provider-private reasoning or a partial stream. It renders only the
committed portable model-session history. A `length` response with no portable text, tool call,
tool result, or effect can therefore use a charged attempt without adding useful progress. The
shared `maxAttempts` ceiling still includes the initial attempt and every output-limited or
transient-provider retry. This fail-closed ceiling prevents an unproductive response pattern from
becoming an unbounded loop.

Provider transport retry and Flow attempt recovery are separate bounded layers. Transport retry
repeats only the current pre-stream provider request. It doesn't increment the Flow attempt or
repeat completed tool work. Flow attempt recovery runs only after the transport layer is exhausted.
It creates a new in-memory session from the durable portable history. This recovery charges a node
start.

After an eligible attempt completes, Flow first appends `node_failed`. This event closes the model
session and charges the attempt's node start, duration, artifacts, model tokens, and reported cost.
Flow then appends `node_retry_scheduled` only when all of these statements are true:

- The node has a persisted `recovery: { mode: fresh, ... }` policy.
- The failed attempt is below `maxAttempts`.
- The failure is retryable.
- The attempt is side-effect-free, or it has only committed durable workspace edits.
- A committed-edit attempt has a closed, matching model-session record for the failed attempt.
- The attempt has no command or delegation record. Any edit history contains no open, unknown,
  uncertain, reconciled, or not-applied effect.
- No declared run budget is exhausted.
- When model tokens or cost are bounded, terminal evidence contains a complete usage observation.
- When execution time is bounded, terminal evidence is present.

`node_retry_scheduled` fixes the reason to `retryable_failure`, the disposition to `fresh_retry`,
and resource accounting to `complete`. When `backoff` is declared, the event also records the
derived `notBefore` deadline. The reducer verifies that deadline against the persisted policy and
run identity.

The reducer archives the terminal error, evidence, timestamps, protocols, effects, commands,
delegations, and model-session summary under `failedAttempts`. It then returns only the current
node projection to `pending`. The scheduler waits until `notBefore`, and replay rejects an early
`node_started` event. The next start must use the next attempt number. For a committed-edit
continuation, that attempt receives a new in-memory Pi session and a digest-bound resume capsule.
It doesn't repeat or continue the failed provider stream.

If Flow stops after `node_failed` but before `node_retry_scheduled`, resume replays the charged
failure and appends the missing retry disposition once. If Flow stops during a declared backoff,
resume waits only for the remaining time before it continues from the pending next attempt. A run
without the opt-in records the ordinary terminal outcome. The same rule applies when
bounded-resource evidence is incomplete or a resource or attempt ceiling is reached. Flow performs
no additional provider request in these cases.

This retry starts a new Flow attempt and a new in-memory Pi session. It doesn't continue the failed
provider request, hide the failed attempt, or add an adapter-owned retry layer. Inspect
`failedAttempts`, the run resources, and `node_retry_scheduled` before you diagnose repeated
provider failures.

### Rolling context epoch recovery

An opted-in rolling context epoch adds a private write-ahead boundary inside the model-session
record. `rolling_context_epoch_started` must become durable before a summary provider call.
`rolling_context_epoch_settled` closes that exact epoch and generation attempt as accepted,
rejected, or interrupted. Only one complete accepted settlement can become the current checkpoint.

Recovery applies this order:

1. Claim and validate the private model-session record under its exclusive owner.
2. Repair only an unterminated final JSONL fragment under the existing committed-prefix rule.
3. If the record ends with an unmatched rolling context epoch start, append an interrupted
   settlement with `process_interrupted`.
4. Append the private `attempt_interrupted` boundary.
5. Apply the authoritative workflow proof gate and append `node_attempt_interrupted` only when the
   attempt is safe to repeat.
6. Start a fresh in-memory Pi session with a bounded, content-free checkpoint bootstrap.
7. Reconstruct the latest complete accepted checkpoint from original primary events.
8. Restore the exact objective and committed tail inside the request-admission boundary.
9. Remeasure the exact next serialized task request before inference.

Recovery never promotes an unmatched start, rejected candidate, partial provider response, or
in-memory summary. It doesn't continue provider-native conversation state. A later rolling epoch
uses the prior accepted summary plus newly eligible exact events, while its cumulative range still
binds the complete original source prefix.

The internal `flow_context_checkpoint` call is only candidate transport. Recovery replays the
accepted canonical checkpoint from the model-session record. It doesn't replay or re-execute the
tool call, reasoning content, or provider-native response item.

The private event keeps the complete tool result when it also contains a compact artifact
projection. Recovery revalidates every referenced artifact before each summary serialization. It
uses the complete result when a reference is unavailable before count admission. If the reference
surface changes between admission and inference serialization, payload identity verification
blocks inference with `pi_model_context_checkpoint_invalid`.

| Recovered state | Result |
| --- | --- |
| No accepted rolling checkpoint | Keep the complete exact source history and apply the normal fresh-session rules. |
| One complete accepted checkpoint with matching source, policy, model capacity, and runtime bindings | Reconstruct the checkpoint and retain the two most recent completed requests exactly. |
| Complete pre-checkpoint history exceeds the generic resume-surface limit | Use the bounded checkpoint bootstrap. Don't render the complete pre-checkpoint history into Pi. |
| Unmatched epoch start | Record one interrupted settlement before the attempt interruption. Don't infer a summary result. |
| Rejected or interrupted settlement after an older accepted checkpoint | Keep the older accepted checkpoint current. |
| Changed policy, route, runtime, model context window, model maximum output, instructions, tools, authority, source range, protected constraints, or rendered identity | Fail with `pi_model_context_checkpoint_invalid` before provider I/O. |
| Missing, corrupt, oversized, unsafe, or live-owned private record | Block recovery and preserve the record for diagnosis. |
| Provider count unavailable after restart | Record content-free measurement failure and fail with `pi_model_context_measurement_unavailable` before inference. |
| Artifact projection unavailable before summary admission | Use the complete committed tool result and measure that exact summary payload. |
| Artifact projection changes after summary admission | Fail with `pi_model_context_checkpoint_invalid` before summary inference. |

Inspect the run before and after the ordinary resume command:

```sh
flow inspect <run-id>
flow resume <workflow.yaml> --run-id <run-id>
flow inspect <run-id>
```

Don't edit checkpoint text, ranges, digests, or bindings. Don't delete an unmatched start or copy a
checkpoint between sessions. Preserve an invalid run for audit and start a new reviewed run when
the exact replay proof cannot pass. Read
[Keep long model sessions within provider capacity](guides/rolling-context.md) for configuration,
inspection fields, and failure-code actions.

## Ownership and crash handling

Every process that may append or execute for a run publishes complete owner metadata atomically.
A second process refuses a run owned by a live local process. When the recorded process no longer
exists, one claimant can atomically replace its ownership; concurrent claimants still produce only
one winner. Process-ID reuse may conservatively block recovery but cannot authorize two owners.

For foreground execution, that owner is the CLI process. For detached execution, one worker owns
one existing `runWorkflow` or `resumeWorkflow` call. The local supervisor never claims the run,
appends graph events, constructs an executor, or contacts a model provider.

The supervisor maintains immutable source snapshots for admitted jobs, a separate admission ledger,
active-run claims, private worker descriptors, and durable mutating-command records. A submission
record binds the exact input and policy digests before admission and transitions monotonically to
queued, accepted, rejected, or uncertain. The admission ledger serializes capacity reservation,
FIFO dispatch, queued cancellation, uncertainty, and release; it is synced before those facts are
acknowledged and periodically compacted to a replay-equivalent snapshot. A worker starts in an
adoption gate and does not schedule until it has published `running`, the supervisor authenticates
its worker id, run id, PID, random token, and job digest, and the identity response has flushed.
If a resume worker records recovery evidence and then receives a typed recovery refusal, it persists
that code together with the replayed run status. Its process and capacity slot become terminal while
an uncertain authoritative run remains `running`, never mislabeled as failed. If the proof gate
passes, the same worker records the interruption disposition and continues the ordinary scheduler;
the supervisor does not implement a second retry mechanism.
Duplicate exact submissions converge on the recorded result; conflicting submissions remain
rejected even after the original active claim disappears. Concurrent clients also serialize daemon
auto-start through an owner-only startup record, so only one caller can remove a stale socket and
launch a generation.

On supervisor restart, detached workers continue in their own process groups and queued jobs remain
in the admission ledger. A replacement generation bound to the same policy reconciles only live
claims and active admission identities, adopts workers that answer the token-bound handshake,
releases proven terminal work, and dispatches the oldest queued ticket into each free slot. Stale or
mismatched PID metadata is never signalled. If the worker itself disappears with an open node
attempt, the ledger remains authoritative and a later resume applies the persisted proof gate. An
unconfigured or ineligible attempt remains uncertain; the uncertain admission conservatively
continues to consume capacity.

Cancellation is recorded durably before dispatch. A repeated exact command id returns its committed
result; a different request using that id conflicts. If acknowledgement is lost after dispatch,
Flow reconciles a terminal cancellation from the ledger and otherwise reports uncertainty instead
of blindly repeating the abort. Cancellation during a node retains its available evidence and
records the actor, request id, and cancelled node; committed resource exhaustion still takes
precedence. Queued cancellation is a two-phase admission transition: once its durable record wins
the dispatch race, Flow completes the command and removes the job without creating an active claim,
worker descriptor, model session, command sandbox, or run ledger.

A supervisor generation is bound to the exact effective capacity digest. Stateful requests carrying
a different digest fail before mutation. Shutdown refuses while active or queued admission remains;
an explicit idle shutdown archives that policy generation so a later process may bind changed
values. Editing configuration never rewrites or reorders an existing queue.

Event replay is read-only and page-based. `--after` is an exclusive sequence cursor, `--limit` is
bounded to 256, and follow mode advances only after validating the next contiguous page. A page is
terminal only when it reaches a terminal ledger event.

These mechanisms coordinate processes on one host and filesystem. They are not a distributed
lease, remote service, authenticated user boundary, or security sandbox. Do not share one run
directory across independent hosts.

JSONL records are committed only when newline-terminated. Recovery ignores a final unterminated
fragment and truncates it immediately before the next append. An invalid earlier record, mismatched
run directory, or corrupt owner record fails closed and is preserved for diagnosis.

## Adaptive candidate, activation, and evaluation recovery

Candidate admission is a read-only, complete observation of the manifest, baseline, and tuning
evidence. Agent Skill candidate admission also observes the complete baseline package. A source
change stops admission. The operator must inspect and validate the new bytes. Candidate validation
never changes the baseline workflow or package.

Model-route admission observes one candidate file and one exact baseline workflow. It binds the
target root agent node and its before and after model tuples. A source change, target change, or
route mismatch stops admission. The candidate contains no credential or provider response.

An Agent Skill package candidate is a directory publication. Flow writes a private same-parent
staging directory and syncs the exact manifest and package tree. Flow reopens and validates the
complete candidate. It revalidates every generation source, confirms that the final path is absent,
and publishes under the exact output lock.

A failure before rename leaves no final candidate. A failure after rename but before parent-directory sync reports
`publication_uncertain`. The operator inspects the exact final directory before retry. Flow does not
regenerate or replace it automatically.

The publisher lock is `.<output-name>.generation.lock`. A private staging directory uses
`.<output-name>.generation.<uuid>.tmp`. Flow does not retire these paths by age or PID guess. After a
crash, first verify that no generation process owns the exact output. If the final directory exists,
run `candidate validate` against it and treat it as an uncertain committed candidate. If the final
directory is absent, inspect and remove only the exact lock and staging directory before a new
generation attempt.

Never remove a lock while its generation process may still be active.

An evaluation header binds the candidate, baseline, evidence, declared surface, and projected
workflow. A model-route header also binds the ordered baseline and candidate route controls.
Evaluation resume re-admits the supplied plan. It rejects removal, replacement, source changes, or
route substitution. It continues only the missing schedule suffix.

Each evaluation trial has one durable adapter-start record. Flow synchronizes this record before an
adapter can contact a model or start an external harness. The record names the exact plan, schedule
position, trial, profile, adapter, workspace snapshot, and start time.

A terminal trial record retires the matching start record. If Flow restarts with an unresolved
start, it records one interrupted harness failure. It does not call the adapter again. A conflicting
start record makes the evaluation store corrupt.

The dedicated context compaction evaluator uses the same adapter-start rule. It stores evidence
below `.flow/evaluations/context-compaction/<evaluation-id>/`. Resume re-admits the exact three-mode
plan and continues only its missing schedule suffix. A recovered unresolved trial gets one
`harness_failure` with unavailable metrics. Flow never converts missing compaction telemetry to
zero. The dedicated ledger rejects an unterminated final record instead of repairing it.

Inside a model session, `context_compaction_started` commits before summary provider I/O. Recovery
settles an unmatched start as `interrupted` before it closes the interrupted model attempt. One
smaller second generation can then reconstruct its source from durable primary events. It cannot
continue provider-native state or trust an in-memory summary candidate.

Read [Evaluate reference-first context compaction](guides/context-compaction.md) for the complete
three-mode recovery and report contract.

A native external resume also re-admits the complete external identity. Pi identity includes Node
and both Pi package closures. OMP identity includes an attested Bun executable, both OMP package
closures, runtime Markdown, and the dependency-resolution graph. A change to the driver, local
closure, SRT closure, protocol, configuration, policy, platform, containment, or broker contract
rejects the old evaluation.

For a child in an old workspace location, Flow first validates and moves the workspace. The first
recovery event is `run_resumed.workspaceRelocation`. A parent writes this child event before it
starts recovery in the child. Nested recovery applies the same order at each level.

The legacy activation store keeps its existing recovery contract. It validates the complete next
index and physical store limits first. It writes immutable candidate and baseline artifacts before
it writes the selecting index. A known failure before index replacement removes new unindexed
artifacts and keeps the old head. A failure after replacement but before directory sync returns
`commit_uncertain`. The operator must inspect the index before retry.

For package introduction, the paired baseline artifact contains the original workflow and no
package. The candidate artifact contains the projected workflow and exact generated package. Once
activation commits, attached runs, detached workers, resume, recovery, replay, inspect, export, and
rollback use these durable bytes. They do not reopen the review directory, blueprint, evidence,
baseline file, network, registry, or credential source.

For model routing, the paired artifact contains complete baseline and candidate workflows. The
candidate workflow differs only at the declared root agent model tuple. After activation, runtime
and recovery use the selected durable workflow. They do not reopen the route file, baseline file,
evaluation directory, provider catalog, or credential source.

For phase routing, the composed artifact contains the complete `before` and `after` profiles and
both deterministic workflow projections. Evaluation reconstructs an evaluation-only baseline state
with the `before` profile and uses the artifact candidate state for `after`. Recovery reads the
selected profile from the immutable run capability snapshot and rechecks each prepared request's
exact target, route, and decision identity. It doesn't infer a missing decision, use a fallback, or
reopen the candidate, baseline, evaluation directory, or provider catalog.

The mutation lock identifies its host, process, and random token. Flow retires it only after the
same host reports that the process does not exist. A live, foreign, changed, or invalid lock owner
fails closed.

Flow removes old index and blob temporary files while it holds the mutation lock.
It checks each strict name, file type, size, and stable identity before removal.
A file that another process removes before observation needs no recovery action.
A new lock temporary name contains the host and process identity.

Flow can remove an empty or partial file when its name identifies a dead process on this host.
Flow removes a complete legacy lock temporary file only when its valid content identifies a dead process on this host.
Temporary state has count and byte limits.
State above a count, per-file, or aggregate byte limit fails closed.
Blob recovery permits the complete maximum-source activation artifact.

The index contains a hash-chained transition history. Store admission rejects malformed indexes,
missing selected artifacts, changed artifacts, invalid UTF-8, symbolic links, and exceeded limits.
An exact retry after an uncertain commit returns the current selected state.

Each run saves the complete activation snapshot in its `run_started` event. An Agent Skill
activation also saves the exact selected package.
Recovery uses those bytes after the live index changes or disappears. It also uses them after the
candidate, evidence, or skill directory changes or disappears. Detached workers and child ledgers
receive the saved snapshot. Replay rejects changed workflow, package, activation, or capability
digests.

Effective composition uses `.flow/effective-harness/`. The `states/` directory contains immutable
complete states. The `artifacts/` directory contains immutable composed candidates. The atomic index
contains workflow origins, activated retained dependencies, heads, and hash-chained transitions.
Staged states and artifacts are inert until an evaluated activation selects them. They still count
toward the physical limits of 256 states and 256 artifacts.

Activation publishes the complete baseline state, candidate state, and candidate artifact before
the index rename. Apply rechecks the exact current head while it owns the shared activation lock. A
failure before the index rename leaves the old head authoritative and permits an exact retry. A
failure after the rename reopens the index. Flow returns the settled transition when it can prove
the commit. Otherwise, it reports an uncertain commit and does not guess.

The effective store validates canonical project scope, strict names, regular files, and stable file
identity. Bounded chunked reads recheck the opened inode after reading. The store enumerates both
physical directories with a streaming entry ceiling and validates indexed and inert staged blobs on
every reopen. It also validates exact digests, store limits, and the complete transition chain. A
symbolic link, unknown name, cross-project state, missing dependency, changed dependency, or
contradictory index fails closed. The operator must repair or restore the exact retained data.

Flow does not consult live sources.

Flow does not garbage-collect staged candidates or remove a retained rollback target automatically.

At a physical limit, preserve every activated dependency and retained rollback target. Remove only
an exact inert staged artifact and any state that no retained artifact or index entry needs, then
retry composition.

Rollback changes only the live head for future runs. It selects a verified retained state by
digest. It then appends a rollback transition. It does not change an existing run, restore old
policy, rewrite source files, or delete any state or artifact. Tuning-evidence export remains an
atomic no-overwrite operation.

## Retained artifact recovery

The project retained-artifact store separates immutable run references from mutable physical
availability. A missing, changed, or pruned blob doesn't erase the run reference. Inspection reports
the unresolved availability, and reads fail with a fixed error.

Blob publication precedes catalog publication. If publication stops in that interval, an exact
prune preview can report the safe finalized blob as an orphan. Publication can also stop after it
creates the final hard link. The next lock owner then verifies and removes the temporary link before
it opens the finalized blob.

If catalog publication succeeds but the producing run event does not, `flow artifacts list` still
shows the retained reference and producer tuple. Compare that tuple with the run ledger before you
release it. An active reader owns the same nonblocking lock as pruning and mutation. Retry a busy
operation only after the reader settles.

Cancellation before a durable mutation preserves the caller's reason and adds no catalog authority.
After catalog publication or the first blob removal in an approved plan, Flow ignores late
cancellation. It settles the exact committed operation and returns its verified result.

`artifact commit is uncertain` means that a blob or catalog mutation may be durable. Don't retry
blindly. List and inspect the current catalog, then create and review a fresh prune plan.
`artifact store settlement is uncertain` means that lock cleanup also failed. Stop all Flow
processes that use the project and follow the lock procedure below before another artifact command.

The store doesn't automatically break `.flow/artifacts/mutation.lock`. If every artifact command
reports that the store is busy after a process stops:

1. Stop all Flow processes that use the project.
2. Back up `.flow/artifacts`.
3. Confirm that no Flow process still owns the project.
4. Remove only `.flow/artifacts/mutation.lock`.
5. Run `flow artifacts list`, then inspect affected references.
6. Preview pruning and review every descriptor before you apply the exact plan.

Don't edit the catalog, blob filenames, or blob bytes. Preserve unexpected or unsafe state for
diagnosis.

## Error codes and outcomes

| Code | Meaning | Operator action |
| --- | --- | --- |
| `uncertain_operation` | A node attempt started without a durable outcome, even if its edits were reconciled | Inspect the node and its settlement/reconciliation provenance; start a new reviewed run rather than editing the ledger |
| `recovery_retry_ineligible` | The node opted into fresh recovery, but interruption, attempt, effect, protocol, or resource proof forbids the next start | Inspect `interruptedAttempts`, `failedAttempts`, effects, recovery requirement, and budget; don't hand-edit the ledger or rerun under a weakened workflow |
| `reconciliation_unavailable` | An open typed effect was found but this embedding did not supply a reconciler | Use the production CLI/worker composition or configure a reviewed reconciler; do not retry the node |
| `reconciliation_incomplete` | A reconciler returned no observation or attempted multiple publications | Preserve the ledger and diagnose the adapter contract before trying recovery again |
| `terminal_run` | The run already has a terminal event | Use `flow inspect`; start a new run for new work |
| `workflow_mismatch` | The supplied workflow or persisted workflow-derived requirements do not match the exact compiled run contract | Locate the exact workflow revision used to start the run; treat unexpected ledger requirements as corruption |
| `execution_context_mismatch` | The requested working directory differs from the one persisted by a new run | Resume from the exact original execution directory |
| `child_recovery_ineligible` | A durable child cannot be resumed from its exact recorded workspace identity, or its recovered state cannot safely continue | Preserve both ledgers and workspace state; inspect their provenance and start a new reviewed root run rather than deleting or replacing evidence |
| `candidate_promotion_stale` | An affected parent path or removed-directory closure no longer matches the captured baseline | Preserve the newer parent state and candidate evidence; rerun from a fresh reviewed baseline |
| `candidate_promotion_rolled_back` | Promotion failed after prepare and deterministic compensation restored the prior best | Inspect the journal and failure; do not hand-apply the candidate or mark it accepted |
| `candidate_promotion_uncertain` | Reconciliation cannot prove a complete committed or compensated affected-path state | Preserve the run, candidate workspace, and promotion journal; resolve manually and start a new reviewed run |
| `candidate_workspace_cleanup_failed` | A conclusive candidate workspace could not be discarded | Inspect permissions/storage and preserve the run; do not delete ledger evidence |
| `request_mismatch` | The supplied approval request is not the current pending request | Inspect the run and decide only the displayed request id |
| `not_waiting` | The run no longer accepts an approval decision | Inspect for a prior decision, expiry, start, or terminal outcome |
| `not_owner` | Another live process owns execution | Inspect without claiming, or wait for that process to exit |
| `not_found` | No ledger exists for the run ID | Verify `--run-id` and `--runs-dir` |
| `corrupt` | Committed ledger or ownership data is invalid or ambiguous | Preserve the run directory and diagnose it; do not hand-edit authoritative events |
| `policy_mismatch` | The client and durable/live supervisor generation resolved different effective capacity policies | Inspect `flow config show` and `flow supervisor status`; let work become idle, then explicitly shut down the old generation. If it already exited, temporarily restore its prior values so it can restart and be shut down safely |
| `queue_full` | Active and queued detached capacity are both exhausted | Retry later with the same persisted command id, or deliberately change operator capacity after an idle shutdown |
| `pi_model_context_floor_exhausted` | The exact protected model surface has no safe input floor or no older range is eligible | Preserve the run; select a larger-capacity model or reduce authored exact input in a new reviewed workflow |
| `pi_model_context_epochs_exhausted` | Rolling pressure would require more than eight epochs | Preserve and inspect the run; start a reviewed new run |
| `pi_model_context_measurement_unavailable` | Provider token counting is unsupported or failed its bounded contract | Inspect the content-free failure category and exact adapter route; don't bypass measurement |
| `pi_model_context_capacity_exceeded` | Bounded rolling attempts didn't produce an admitted task request | Inspect capacity evidence; use a larger-capacity model or a smaller reviewed exact surface |
| `pi_model_context_checkpoint_invalid` | The admitted payload, checkpoint, range, policy, or runtime binding doesn't replay exactly | Preserve the record and compare reviewed inputs; start a new run when the proof cannot pass |
| `rolling_context_unsupported_acp` | The opted-in node selected an ACP executor without an exact serialization boundary | Use embedded Pi or remove the opt-in in a separately reviewed workflow |

## Guarantees and non-guarantees

Flow guarantees that committed successful nodes are not scheduled again during accepted recovery,
that one local process owns append/execution/approval decisions, that cancellation observed after
claim or reconciliation but before retry disposition adds no retry authority, that a required command cannot
start without a matching unexpired single-use grant, that committed resource use produces the same
remaining allowances and exhausted decision after replay, and that unsafe refusal paths do not add
`node_attempt_interrupted`, `run_resumed`, or invoke an executor. A supported open edit may add only
its typed reconciliation event before either refusal or an accepted disposition. For an accepted fresh retry, Flow guarantees the
interruption disposition is durable first, attempt numbers increase exactly by one, and every prior
attempt remains inspectable. Detached admission additionally guarantees that every
worker consumes a prior durable slot, queued work is FIFO by stable ticket, queue-full work creates
no worker, and an exact command retry reproduces its prior admission result. Historical approval
requests are revalidated against the budget remaining at their exact event boundary, not against
final run consumption.

For Flow-owned workspace edits and complete replacements, Flow guarantees that rename is not entered before
the prepared event is acknowledged, committed settlement follows directory sync, terminal receipts
exactly match settled effects, crash-window evidence remains replayable, and a recovery observation
is published under the same target lock without mutating the file. The only exception is a missing
target whose parent is also absent: because cooperating Flow edits cannot acquire that sibling lock
or create the target, recovery may publish only a rechecked missing result under the target queue.
Any observable target remains unresolved. These guarantees authorize a fresh surrounding attempt
only when the separately persisted policy and every eligibility check above also pass.

For optimization promotion, Flow guarantees that no affected path is entered before durable
prepare, all rollback bytes are durable first, a changed affected path is never overwritten, a
committed settlement is never applied again, rejected candidates never mutate the parent, and an
unknown reconciliation blocks the graph. Stable intermediate symlinks are rejected as stale, and
directory ancestors are rechecked at mutation and crash-cleanup boundaries; unsafe cleanup is
skipped and reconciliation becomes unknown. This is deterministic same-host filesystem recovery,
not an atomic multi-filesystem transaction: a hostile process with the same user authority can
still race between a pathname check and the corresponding filesystem operation.

Flow does not guarantee exactly-once effects in arbitrary external systems, authenticated approval
or cancellation identity, trusted time, mid-node restoration of Pi sessions, automatic retry of
ambiguous work, host-reboot continuation, multi-host recovery, or a billing-authoritative
zero-overshoot model-cost cap.
It also does not perform offline admission-policy retirement. Those capabilities require explicit
identity, provider reservation, and supervisor designs beyond this recovery slice.
