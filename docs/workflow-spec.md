# Workflow specification

## Version

The first executable format uses:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
```

It is intentionally incompatible with the legacy Flow plugin format. The plugin's workflow metadata described how a host model should interpret Markdown; this format compiles directly into scheduler-owned graph state.

## Document shape

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: verify-change
  description: Optional human-readable purpose.
nodes: []
```

Identifiers begin with a lowercase letter and contain lowercase letters, digits, or hyphens. Unknown fields are rejected rather than ignored.

## Graph rules

- A workflow contains 1–64 nodes with unique identifiers. This first-slice bound also caps aggregate in-memory evidence retained by the sequential scheduler and store.
- Exactly one node has no dependencies and is the entry node.
- Every `dependsOn` reference names another node in the same workflow.
- Self-dependencies, duplicate dependencies, and cycles are rejected.
- The scheduler considers nodes in declaration order and runs the first node whose dependencies all succeeded.
- Execution is sequential in `v1alpha1`; concurrency is not implied by independent edges.
- Every terminal node must be a command node. An agent response cannot be terminal proof.
- Compilation finishes before Flow creates a run ledger or invokes an executor.

## Command node

```yaml
- id: verify
  type: command
  dependsOn:
    - implement
  command:
    executable: npm
    args:
      - test
    timeoutMs: 120000
```

`executable` and `args` are passed directly to the operating system with shell parsing disabled. Flow does not accept command strings. `timeoutMs` is a positive integer no greater than 24 hours and defaults to 60 seconds.

A command succeeds only when it exits with code zero without timing out, cancellation, or a terminating signal. Standard output and error are each capped at 32 KiB and SHA-256 hashed in the run evidence. Command argument evidence is capped at 64 KiB in total. A failed or timed-out command ends the workflow and leaves dependent nodes pending.

Command nodes currently inherit the Flow process environment and run in the selected workflow working directory. Workflows are therefore trusted operator configuration in the first release.

## Agent node

```yaml
- id: analyze
  type: agent
  agent:
    prompt: Analyze the repository and identify the relevant implementation files.
    model:
      provider: anthropic
      id: claude-sonnet-4-5
      thinking: medium
    tools:
      - read
      - ls
    timeoutMs: 300000
- id: verify
  type: command
  dependsOn:
    - analyze
  command:
    executable: npm
    args: [test]
```

The initial embedded Pi adapter permits only Flow-owned `read` and `ls` tools. Their canonical paths must remain inside the execution workspace, including after symlink resolution. Pi's built-in tools are disabled, so the adapter does not inherit Pi's optional executable-download behavior. The allowlist may be empty. Pi extensions, skills, prompt templates, themes, context files, and project discovery are disabled for the node session. `timeoutMs` is Flow-owned, defaults to five minutes, and is limited to 24 hours. Agent output is capped at 64 KiB; the ledger retains the bounded text, the complete SHA-256 stream hash, and truncation status, and classifies overflow as `pi_agent_output_limit`. Cancellation aborts the active Pi session; only Pi's terminal `stop` reason is accepted as node success. After timeout or operator cancellation, Flow permits a bounded adapter cleanup grace. A runner that still does not settle produces `pi_agent_timeout` or `pi_agent_aborted` with uncertain side-effect status rather than blocking the scheduler indefinitely.

Command nodes are supported on Linux and macOS. Flow rejects them before spawning on Windows until the command adapter can contain and terminate the full descendant process tree.

An agent node succeeds when its bounded Pi session settles normally. Its text becomes diagnostic evidence. It cannot name the next node, mark acceptance criteria complete, or terminate the workflow successfully without a downstream command verifier.

Provider credentials remain outside workflow files and use Pi's configured credential runtime. Provider and model identifiers are execution configuration; no Pi type appears in the compiled or persisted Flow contracts.

## Run ledger

Each run is stored at:

```text
.flow/runs/<run-id>/events.jsonl
```

Events have a version, contiguous sequence number, timestamp, run identity, workflow identity, workflow API version, and SHA-256 digest of the compiled workflow. A single serialized JSONL event is capped at 1 MiB, which accommodates the proven worst-case JSON escaping of every production-bounded evidence field. Creating the first event atomically claims a run identifier for one store instance. Node-start events are synced before an executor is invoked. Node-result events are synced before the scheduler advances. Owner appends validate one transition against cached reduced state instead of rereading history. Each append syncs the file, and every newly created run-directory ancestor is synced where the platform supports directory handles. A valid or invalid unterminated trailing JSONL fragment is treated as uncommitted and truncated before a later append; corruption in an earlier committed record fails closed.

The reducer accepts only legal state transitions and reconstructs `running`, `succeeded`, `failed`, or `cancelled` run state. Cancellation before a run claim creates no ledger. Cancellation during a node becomes a failed node attempt; cancellation between attempts appends `run_cancelled` without starting more work. Model transcripts are never consulted during replay.

## Current limitations

- No loop, retry, conditional, parallel, fork/join, approval, or child-run nodes.
- No automatic resume of an interrupted node attempt.
- No handoff of an active run between processes; a new process must use a new run identifier.
- No environment allowlist or operating-system sandbox.
- No write or shell tool is exposed to agent nodes.
- No schema migration path is promised while the format remains `v1alpha1`.
