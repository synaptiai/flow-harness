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
- The profile denies network, undeclared Unix sockets, ambient credentials, writes to run state or sensitive project metadata, and home reads outside the workspace except for the exact canonical SRT seccomp helper required on Linux. That runtime-support file is re-exposed read-only when Flow is installed elsewhere. Ordinary workspace writes remain allowed by design.
- Same-policy concurrent commands share SRT's process-global session but receive distinct temporary directories and per-command filesystem configurations. Flow rejects a different concurrent workspace or policy and resets the session only after every active wrap releases.
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
- Run budgets persist checked start, token, reported-cost, and active-time accounting and can reduce
  node timeouts before execution. They are scheduler controls, not provider-side billing
  reservations, account quotas, CPU/memory limits, or a substitute for containment. One in-flight
  model response may settle above its remaining allowance; Flow records it and starts no further
  work.
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

`flow approve` and `flow deny` record a caller-supplied actor label. The label is audit attribution,
not authenticated identity, RBAC, or a signature. Request ids are locators rather than bearer
secrets. The private run-directory permissions and authority of the invoking local account are the
administrative boundary. Do not expose the run directory or approval CLI to untrusted users.

Command output, agent text, executable arguments, and failure messages are persisted in the run ledger as evidence. They can contain secrets emitted by tools or providers. Keep `.flow/runs` private, apply repository ignore rules, and redact sensitive output at its source.
