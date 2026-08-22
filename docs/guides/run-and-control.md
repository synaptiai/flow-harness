# Run and control workflows

This guide covers attached and detached execution, work profiles, observation, approvals, budgets,
cancellation, and recovery entry points.

Complete [Getting started](../getting-started.md) before using these commands.

## Run in the foreground

Validate before execution:

```sh
node dist/cli/main.js validate <workflow.yaml>
node dist/cli/main.js run <workflow.yaml> --run-id <run-id>
node dist/cli/main.js inspect <run-id>
```

The attached command owns the live scheduler. Closing the terminal can interrupt that owner. Use a
detached run when work must survive the submitting client.

## Select durable goal context

If the project has a goal workspace, select its current revision explicitly for validation or a
new run:

```sh
flow validate <workflow.yaml> --goal-workspace
flow run <workflow.yaml> --goal-workspace --run-id <run-id>
```

Flow freezes that revision into the run's capability snapshot. Detached workers and child runs use
the same revision. Resume reads it from durable run history and doesn't accept a live
`--goal-workspace` flag.

Read [Maintain a durable goal workspace](goal-workspaces.md) for initialization, safe updates,
limits, evidence references, privacy, and recovery.

## Select a work profile

A work profile gives each model-backed attempt a pacing posture. A workflow author can declare one
of three values:

```yaml
workProfile: standard
```

- `fast` prioritizes the shortest adequate path and early decisive evidence.
- `standard` balances completeness, verification, and resource use.
- `long` uses broader investigation and deeper verification within existing authority.

If the workflow omits `workProfile`, Flow uses `standard`. For a new run, you can override the
workflow preference:

```sh
flow run examples/implement-and-verify.workflow.yaml --work-profile long --run-id profiled-run
```

Flow records the effective value before it starts a node. Detached workers and child runs inherit
the same value. `flow inspect` and `flow events` include it in public output.

Before each model-backed agent or verifier attempt, Flow supplies the profile and a point-in-time
view of five remaining resource dimensions:

- starts
- model tokens
- reported cost
- active execution time
- retained-artifact capacity

A value of `unbounded` means that the workflow has no Flow limit for that dimension. It does not
grant provider capacity.

Profiles provide guidance only. They don't change numeric budgets, scheduling, concurrency,
timeouts, tools, approvals, policy, model selection, reasoning settings, accounting, or completion.
A model, provider adapter, capability package, or Agent Client Protocol (ACP) peer cannot change the
durable value.

Resume normally omits the option and reuses the ledger value:

```sh
flow resume <workflow.yaml> --run-id profiled-run
```

Automation can repeat the exact durable value with `--work-profile`. A different value fails before
new work or run mutation.

Read the [Workflow specification](../workflow-spec.md#work-profile) for the normative source,
precedence, replay, and context contracts.

## Run in the background

Submit one durable command:

```sh
node dist/cli/main.js run <workflow.yaml> --detach --run-id background-run \
  --command-id 019fd722-4144-7a72-9c86-6f9af022b2e8
node dist/cli/main.js supervisor status
node dist/cli/main.js events background-run --after 0 --follow
```

The supervisor returns one of three admission results:

- `accepted` means an authenticated worker is ready.
- `queued` includes a stable queue ticket.
- `rejected` with `queue_full` means the configured queue has no capacity.

Acceptance does not mean the workflow succeeded. Inspect the ledger or follow events to a terminal
record.

`--command-id` is optional. Automation must create and persist one UUID before submission. Reuse
the same ID and exact input after an acknowledgement loss.

Reusing an ID with different input is a conflict. Flow reconciles uncertain submission only from
its authenticated worker.

## Observe a run

### JSON for scripts

Use `inspect` for the current public projection:

```sh
node dist/cli/main.js inspect <run-id>
```

Use `events` for bounded ledger pages or continuous observation:

```sh
node dist/cli/main.js events <run-id> --after 0
node dist/cli/main.js events <run-id> --after 0 --follow
```

These commands emit public JSON. Private capability bytes and private error causes do not enter the
projection.

### Interactive terminal

Start the first-party terminal host from an interactive terminal:

```sh
node dist/cli/main.js tui <run-id> --actor local:operator
```

Use the arrow keys or `j` and `k` to select an action. Press Enter to submit it. Press `q` or Ctrl-C
to leave without cancelling the run.

The terminal renders Flow's closed presentation document. It does not render Markdown, hyperlinks,
images, package code, or arbitrary terminal controls.

### Local browser

Start the first-party browser host:

```sh
node dist/cli/main.js web <run-id> --actor local:operator
```

Flow prints one IPv4 loopback URL with a fragment capability. Open it under the same local operator
account.

The browser host accepts one observer. It serves fixed first-party assets and text-only public
documents. It does not support remote listening, reverse proxies, shared users, or executable UI
extensions.

### ACP v1 editor

Start the local stdio bridge from the selected project:

```sh
node dist/cli/main.js acp --actor local:operator
```

Use `/flow-run <source>` once to bind a workflow. Use `/flow-continue` to observe and steer the bound
run.

Read [Local ACP v1 bridge](../acp.md) for the session, transport, replay, and unsupported-method
contracts.

## Approve or deny work

Flow has three approval boundaries. The same `approve` and `deny` commands route by request type.

### Exact command approval

Run the approval example and inspect the pending request:

```sh
node dist/cli/main.js run examples/approval-gated-command.workflow.yaml --run-id approval-demo
node dist/cli/main.js inspect approval-demo
node dist/cli/main.js approve approval-demo approval-2 --actor local:operator
node dist/cli/main.js resume examples/approval-gated-command.workflow.yaml --run-id approval-demo
```

Approval records consent. It does not execute the command. Resume must use the exact starting
workflow and execution directory.

To deny the request:

```sh
node dist/cli/main.js deny approval-demo approval-2 --actor local:operator \
  --reason "not authorized"
```

### Live agent command approval

An agent can require approval for every `flow_exec` request. Inspect the live run, then submit one
exact decision from another terminal:

```sh
node dist/cli/main.js approve <run-id> <request-id> --actor local:operator
node dist/cli/main.js deny <run-id> <request-id> --actor local:operator \
  --reason "command is not authorized"
```

The active owner validates the complete request before it records a grant or denial. A grant is
expiring and single-use. An ordinary live decision does not need `resume`.

### Durable graph evidence approval

An approval node binds completed evidence from declared dependencies:

```sh
node dist/cli/main.js run examples/evidence-approval.workflow.yaml --run-id review-demo
node dist/cli/main.js inspect review-demo
node dist/cli/main.js approve review-demo approval-4 --actor local:operator
node dist/cli/main.js resume examples/evidence-approval.workflow.yaml --run-id review-demo
```

This approval succeeds a pure control node. It does not authorize a process or widen policy.

Actor labels provide append-only attribution. They are not authenticated identities. Same-user
access to the private run directory is inside the local administrative boundary.

Read the [Workflow specification](../workflow-spec.md) for exact approval digests, grant rules, and
replay behavior.

## Bound a run

A workflow can declare any non-empty combination of these limits:

- `maxNodeStarts`
- `maxModelTokens`
- `maxCostUsd`
- `maxExecutionMs`
- `maxArtifactBytes`

Validate and run the credential-free budget example:

```sh
node dist/cli/main.js validate examples/budgeted-foundation.workflow.yaml
node dist/cli/main.js run examples/budgeted-foundation.workflow.yaml --run-id budget-demo
node dist/cli/main.js inspect budget-demo
```

Flow reconstructs consumption and remaining allowance from durable events. A model response can
exceed its remaining token or cost allowance before Flow observes it. These values are not prepaid
billing limits.

Read [Configuration](../configuration.md) for operator ceilings. Read the
[Workflow specification](../workflow-spec.md) for exact accounting rules.

## Cancel work

Cancel an active or queued run with attribution:

```sh
node dist/cli/main.js cancel background-run --actor local:operator \
  --reason "operator requested" \
  --command-id 019fd722-4144-7a72-9c86-6f9af022b2e9
```

Active cancellation terminates the node process tree and preserves settled evidence. Queued
cancellation creates no run ledger, active claim, or worker.

Shutdown refuses while active or queued work exists:

```sh
node dist/cli/main.js supervisor shutdown
```

## Recover interrupted work

Inspect first. Resume with the exact workflow that started the run:

```sh
node dist/cli/main.js inspect interrupted-run
node dist/cli/main.js resume <workflow.yaml> --run-id interrupted-run
```

Flow normally continues only from a committed boundary. Eligible agent nodes can opt into bounded
fresh recovery. Flow uses completed provider-neutral context as one new untrusted-data turn. It
doesn't continue an interrupted provider stream, restore hidden model state, or repeat an uncertain
command. Read [Inspect and recover portable model sessions](model-sessions.md) for the inspection,
limits, and failure contract.

Do not infer recovery safety from a missing process. Read
[Recovery and interruption safety](../recovery.md) before remediating an uncertain run, package,
evaluation, presentation, or supervisor state.

If command evidence contains an `artifact:` reference, read
[Retain and inspect command artifacts](retained-artifacts.md) before you release or prune its bytes.

## Security notes

- Presentation hosts do not receive durable authority or private package bytes.
- Detached execution is a same-host service for one operating-system user.
- Actor labels do not authenticate a person.
- Agent `exec` requires Linux PID-namespace containment.
- Flow does not treat process groups as sufficient descendant containment on macOS.
- SRT and the container profile are not VM-grade hostile-workload boundaries.

Read the [Security policy](../../SECURITY.md) and [Architecture](../architecture.md) before unattended
or high-impact use.
