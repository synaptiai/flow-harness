# Flow

Flow is a provider-neutral coding-agent harness with deterministic workflow graphs, durable
evidence, and fail-closed sandboxed command execution.

> **Pre-alpha source preview:** Flow is under active development, its contracts may change, and
> `@synaptiai/flow-harness` is not published to npm. Build and run it from a reviewed source
> checkout. Do not use it as a security boundary for hostile or multi-tenant workloads.

Flow is a standalone product. It does not depend on Claude Code and does not preserve
compatibility with the earlier Flow plugin. Pi supplies the initial model-facing agent loop;
Flow owns scheduling, policy, containment, evidence, and completion.

## What works today

| Capability | Status |
| --- | --- |
| Strict workflow and goal compilation | Implemented |
| Sequential dependency-ordered execution | Implemented |
| Durable JSONL run ledger and inspection | Implemented |
| Safe-boundary recovery with exclusive local ownership | Implemented |
| Durable exact command approval with approve/deny CLI | Implemented |
| Durable provider-neutral resource accounting and run budgets | Implemented for starts, model tokens, reported cost, and active execution time |
| Strict project/operator configuration with inspectable monotonic limits | Implemented |
| Bounded detached supervisor, durable FIFO queue, authenticated workers, cancellation, and event replay | Implemented on Linux and macOS |
| Deterministic criterion verification | Implemented |
| Bounded Pi agent nodes with Flow-owned `read`, `ls`, and hash-anchored `edit` tools | Implemented |
| Write-ahead durable evidence and typed recovery observation for each workspace edit | Implemented for hash-anchored edits; whole-node retry remains prohibited |
| Fail-closed sandboxed command process trees | Implemented on Linux and macOS |
| Dynamic agent-tool approval, graph loops, and broader model tools | Planned |
| VM-grade isolation of the host-side agent runtime | Planned |

The executable format is `flow.synapti.ai/v1alpha1`. There is no compatibility or migration
promise before the first stable release.

## Run the source preview

### Prerequisites

- Git
- Node.js 22.19 or newer
- npm with lockfile support
- Linux or macOS

On Ubuntu or Debian, install the native sandbox dependencies:

```sh
sudo apt-get update
sudo apt-get install --yes bubblewrap socat ripgrep
```

Linux also requires unprivileged user namespaces, network namespaces, and seccomp support. macOS
uses the built-in Seatbelt facility. Windows command nodes fail before process creation because
descendant containment is not implemented there.

Ubuntu 24.04 and newer restrict capability-bearing unprivileged user namespaces by default. On a
dedicated development or ephemeral CI host, enable the capability required by SRT for the current
boot:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

This changes host-wide user-namespace hardening. On a shared host, keep the restriction and use a
reviewed AppArmor profile that grants `userns` only to the required sandbox binaries instead. See
SRT's [platform-specific dependency guidance](https://github.com/anthropic-experimental/sandbox-runtime#platform-specific-dependencies).

### Build and verify

```sh
git clone https://github.com/synaptiai/flow-harness.git
cd flow-harness
npm ci --ignore-scripts
npm run check
npm run build
```

`npm ci --ignore-scripts` installs only the exact lockfile. Use `npm install` only when
intentionally changing dependencies.

### Execute the example

Initialize the checkout as a Flow project and inspect the effective operator/project policy:

```sh
node dist/cli/main.js init .
node dist/cli/main.js config show
```

The project file is `.flow/config.yaml`. Flow discovers the nearest project from subdirectories and
uses it as the default run-store root. See [Configuration](docs/configuration.md) for capacity
limits, operator ceilings, and policy-change behavior.

```sh
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
```

The example needs no model credentials. Its terminal verifier runs inside the production command
sandbox and the final command exits successfully only when the declared goal criterion is
accepted. Authoritative events are written to:

```text
.flow/runs/first-run/events.jsonl
```

The inspected result identifies graph state, criterion decisions, bounded command output and
hashes, plus the sandbox backend, exact version, profile, and semantic policy digest.

### Run in the background

Add `--detach` to `run` or `resume` when work must survive the submitting client:

```sh
node dist/cli/main.js run <workflow.yaml> --detach --run-id background-run \
  --command-id 019fd722-4144-7a72-9c86-6f9af022b2e8
node dist/cli/main.js supervisor status
node dist/cli/main.js events background-run --after 0 --follow
```

The local supervisor journals the exact submission identity and applies the effective capacity
policy before launch. With the defaults, one worker may be active and 32 additional jobs wait in a
durable FIFO queue. A submission returns `accepted` only after its worker authenticates, `queued`
with its stable queue ticket when it is waiting, or `rejected` with `queue_full` when the configured
queue is full. Accepted means the worker is ready; it does not mean the workflow has succeeded.
`events` replays authoritative ledger records in bounded pages and `--follow` continues until a
terminal event. To cancel active or queued work with attribution:

```sh
node dist/cli/main.js cancel background-run --actor local:daniel --reason "operator requested" \
  --command-id 019fd722-4144-7a72-9c86-6f9af022b2e9
node dist/cli/main.js supervisor shutdown
```

Cancellation uses a durable idempotent command record. Active cancellation terminates the node
process tree, preserves settled evidence, and records `cancelled`; queued cancellation creates no
run ledger, active claim, or worker. Shutdown is intentionally refused while active or queued work
exists. If the supervisor itself exits, workers continue and queued admission remains durable; a
replacement generation reconciles both before accepting new work. This is same-host execution, not
a remote or multi-host service.

`--command-id` is optional and must be a UUID. Flow generates one when omitted. Automation should
generate and persist the ID before its first detached submission or cancellation, then reuse the
same ID and exact input after an acknowledgement loss. Reusing an ID with different input is a
conflict. Submission acceptance, deterministic rejection, and uncertain launch are durable; an
uncertain submission is reconciled only from its authenticated worker, while an uncertain
cancellation is reconciled from the ledger rather than dispatched again.

### Approve an exact command

The approval example stops before sandbox preparation or process spawn and exits with code 3:

```sh
node dist/cli/main.js run examples/approval-gated-command.workflow.yaml --run-id approval-demo
node dist/cli/main.js inspect approval-demo
```

Inspect the pending executable, ordered arguments, working directory, timeout, operation digest,
request id, and grant lifetime. Record a decision with an explicit local actor label:

```sh
node dist/cli/main.js approve approval-demo approval-2 --actor local:daniel
node dist/cli/main.js resume examples/approval-gated-command.workflow.yaml --run-id approval-demo
```

Approval records consent but does not execute. `resume` must compile the exact starting workflow and
use the same execution directory. The grant is single-use and defaults to five minutes; if it
expires before the node starts, Flow records expiry and returns to a new durable request. A pending
request itself does not time out or imply consent. To reject it instead:

```sh
node dist/cli/main.js deny approval-demo approval-2 --actor local:daniel --reason "not authorized"
```

The actor label is append-only attribution supplied by the caller, not authenticated identity.
Anyone who can control the private run directory or invoke Flow with the same local permissions is
inside this slice's administrative trust boundary.

### Bound a run

The budget example is credential-free and demonstrates run-wide start and active-execution limits:

```sh
node dist/cli/main.js validate examples/budgeted-foundation.workflow.yaml
node dist/cli/main.js run examples/budgeted-foundation.workflow.yaml --run-id budget-demo
node dist/cli/main.js inspect budget-demo
```

A workflow can declare any non-empty combination of `maxNodeStarts`, `maxModelTokens`,
`maxCostUsd`, and `maxExecutionMs`. Missing `budget` means unbounded. Flow persists the compiled
limits at run start and reconstructs `resources`, remaining allowance, and exhausted dimensions
from the event ledger. Agent usage comes from Pi session statistics but is translated into
Flow-owned token fields and integer micro-USD before persistence.

Reaching a model-token, reported-cost, or active-execution ceiling records
`resource_exhausted`, exits with code 1, and starts no downstream work. A node-start limit prevents
the next start but does not invalidate a graph that completed with its final allowed start. Node
timeouts are reduced to the remaining active-execution allowance; an approval request displays and
binds that reduced timeout. Approval wait and client-detached wall time do not consume active time.

Model usage and cost become authoritative only after the provider response settles, so one response
can exceed its remaining allowance. Flow records the full observation and stops; it does not claim
to enforce a prepaid hard billing cap, infer prices, or reconcile provider invoices.

To inspect the coding-agent shape without contacting a provider, validate the implementation
template:

```sh
node dist/cli/main.js validate examples/implement-and-verify.workflow.yaml
```

The template declares `read`, `ls`, and `edit` for one agent node followed by a deterministic
command verifier. Adapt its prompt, model, and verification command before running it; unlike the
credential-free foundation example, execution requires a configured Pi provider and may change the
selected workspace.

### Recover interrupted work

Inspect the durable state first, then resume with the exact workflow that started the run:

```sh
node dist/cli/main.js inspect interrupted-run
node dist/cli/main.js resume examples/verify-foundation.workflow.yaml --run-id interrupted-run
```

Flow continues only from a committed node boundary. It skips nodes whose success is durable and
records `run_resumed` before starting new work. Writable agent attempts declare a versioned effect
protocol; each edit is durably prepared before atomic rename and settled after the commit boundary.
`inspect` can therefore distinguish no observed edit, not applied, committed, and post-commit
unknown effects. If an interruption leaves a prepared edit open, `resume` coordinates with the same
target lock used by edits, compares the current regular-file hash and mode, and appends one typed
recovery observation: applied, not applied, or unknown with a bounded reason. A durable
`node_started` without a matching node outcome is still uncertain: Flow names the node and attempt,
exposes its effect journal and recovery provenance, refuses with `uncertain_operation`, and executes
nothing. Repeating recovery does not duplicate an observation.
Terminal,
mismatched, corrupt, missing, or actively owned runs are also refused without changing committed
events. New runs also bind the normalized execution directory. Approval waits are safe committed
boundaries: an undecided request remains waiting, a valid grant starts once, and an unused expired
grant returns to a fresh request. Budget limits, consumption, and exact approval timeouts are also
revalidated; recovery terminalizes a committed exhausted settlement without rerunning its node. See
[Recovery and interruption safety](docs/recovery.md) for the complete contract.

Detached execution changes who owns the live process, not the recovery rules. A worker remains the
exclusive scheduler and run-ledger owner. If it disappears after `node_started` but before an
outcome, Flow still reports `uncertain_operation` and never silently repeats the work.

## Security boundary

Each command and descendant receives workspace write access, a private temporary directory, an
explicit environment allowlist, and no network. The actual run store, `.flow`, `.git`, environment
files, and key files are write-protected. If the sandbox is unavailable or reports degraded
isolation, Flow does not spawn the command.

On Linux, Flow explicitly re-exposes the canonical packaged SRT seccomp helper as a read-only
runtime-support file when Flow is installed outside the selected workspace. The rest of the user
home remains denied.

Agent nodes are different: the host-side Pi runtime runs with the invoking user's operating-system
permissions and receives only explicitly declared Flow-owned `read`, `ls`, and `edit` tools. Reads
return a full-file SHA-256 version. An edit must name that version and exact unique replacements for
one existing UTF-8 file; stale versions fail rather than merge. Flow preflights the complete edit,
coordinates cooperating same-host Flow processes, atomically replaces the target, protects the run
store, nested `.flow` and `.git` state, environment files, and key files, and records separate
authorization decisions, write-ahead effect events, and before/after terminal receipts. A prepare
event is synced before rename. While journal publication remains available, settlement is synced as
committed only after directory sync, as not applied before rename, or as unknown after a post-rename
failure. A rejected settlement append poisons the attempt journal and leaves the prepared effect
unresolved rather than inventing an outcome. Replay requires every prepared edit, including a
not-applied edit, to retain its distinct allowed write decision. Recovery observations remain
separate from executor settlements: matching the after-state later does not prove that the original
directory sync or model turn completed and never authorizes automatic node retry. Reconciliation
hashes only the bounded size observed before opening the no-follow handle, in fixed chunks totaling
at most 8 MiB, while holding the shared target lock. If the target's parent has also disappeared and
the sibling lock cannot exist, only a still-missing classification may be published; any observable
target remains open. Recovery persists no file bytes or raw OS error text and never repairs the
target. Directory
listings consume one logical policy authorization rather than one decision per entry. Create,
delete, rename, shell, and network
tools are not exposed. Filesystem operations are canonically resolved and authorized by the Flow
policy broker. Pi's ambient tools, extensions, skills, templates, context discovery, built-in edit
semantics, and executable-downloading helpers are disabled.

Supervisor control state is stored in an owner-only directory under the selected run root. Its
Unix-domain sockets use a short owner-only temporary path so valid deep project paths also work on
macOS. Random worker tokens and identity handshakes prevent stale PID metadata from authorizing
control. These controls coordinate trusted processes of one operating-system user; they are not a
sandbox against that same user or root.

SRT is a beta native sandbox rather than a microVM. Use a reviewed container, microVM, Gondolin,
OpenShell, or managed sandbox for hostile workloads. Read the [security policy](SECURITY.md) before
running unattended work.

## Product thesis

A coding model is not a workflow engine, authorization boundary, evidence store, or recovery
system. Flow separates those responsibilities:

- Models solve bounded tasks inside workflow nodes.
- A deterministic scheduler controls graph transitions.
- A policy broker controls model-requested operations.
- A sandbox contains command process trees.
- An append-only event ledger records authoritative run state.
- A local supervisor owns detached process discovery and control without owning graph transitions.
- Durable resource accounting and run budgets stop further work at replayable boundaries.
- Mutation-free evaluation decides whether deterministic evidence accepts each criterion.
- Provider-specific behavior remains behind execution adapters.

The compiled graph—not model prose—decides what runs next. A confident completion narrative cannot
override missing or failing evidence.

## Documentation

- [Architecture](docs/architecture.md)
- [Capability sourcing](docs/capability-sourcing.md)
- [Configuration](docs/configuration.md)
- [Workflow specification](docs/workflow-spec.md)
- [Recovery and interruption safety](docs/recovery.md)
- [Testing and evaluation](docs/testing-and-evaluation.md)
- [Delivery roadmap](docs/roadmap.md)

## Community

- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
