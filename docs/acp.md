# Local ACP v1 integration

Flow implements Agent Client Protocol (ACP) version 1 in two directions:

- The [editor bridge](#start-the-editor-bridge) presents Flow as an ACP agent to a compatible local
  editor.
- The [local executor](#run-a-local-acp-executor) lets Flow use one exact ACP agent for bounded
  prompt-only workflow nodes.

ACP is an interoperability transport. Flow still owns workflow admission, policy, packages,
sandboxes, cancellation, durable state, replay, and public evidence.

## Start the editor bridge

Build Flow and start the bridge from the selected project:

```sh
npm run build
node dist/cli/main.js acp --actor local:operator
```

Use `--runs-dir <path>` only when the same project uses a non-default run store. Standard input and
output contain newline-delimited ACP JSON-RPC only. Standard error contains fixed operational
errors and process-signal messages. It never contains protocol frames or private run data.

The bridge exposes no socket or network listener. The invoking operating-system user owns the
stdio peer and the run store. It captures the effective Flow policy when it starts. Restart the
bridge to adopt a changed policy. One bridge process never reloads policy between session creation
and `/flow-run` admission.

## Session and run identity

ACP `session/new` creates one durable descriptor. Its UUID is both the ACP session id and the Flow
run id. The descriptor also binds the canonical project root, current policy digest, explicit
actor, and creation time. A store contains at most 2,048 session records. Listing returns at most
256 records per page.

The first `/flow-run` prompt submits a detached Flow command with the same UUID as its command id
and run id. The supervisor journal binds the exact admitted workflow source, policy, project, and
capability snapshot. The `run_started` event binds the compiled workflow and frozen packages. A
different later `/flow-run` for the same session conflicts with that durable command identity.
Supervisor acceptance can precede the first ledger event. The adapter waits for that first event
for at most 30 seconds without resubmitting the workflow.

The current ACP prompt grammar has no work-profile option. `/flow-run` uses the admitted workflow
preference or the `standard` default. The supervisor and `run_started` event bind that effective
value. An ACP peer, model response, or later session load cannot change it. Use the command-line
`flow run --work-profile` option when an operator must override a workflow preference.

## Prompts and capabilities

Flow accepts these prompt forms:

- `/flow-run <project-relative-workflow>`
- `/flow-run workflow:<name>@<exact-version>`
- `/flow-run activation:<workflow-id>`
- `/flow-run` plus one project-local `file:` resource link
- `/flow-continue`

Absolute paths, parent traversal, malformed locators, free-form shell commands, extra prompt
blocks, MCP server descriptors, and extra session directories fail before runtime submission. Flow
advertises only session list, load, resume, close, and prompt support. It does not call client
filesystem or terminal methods. Client-advertised capabilities do not enlarge Flow authority.

ACP version 2, custom methods, custom extensions, A2A, AG-UI, and A2UI-over-ACP are not supported.

## Public updates and actions

Flow reduces durable events into its closed public presentation document. The ACP adapter maps that
document to standard plan, message, tool-call, and permission updates. It excludes raw events and
raw durable records. It also excludes package bytes, resource `contentBase64`, secrets, and tokens.
Private paths, raw provider data, and private nested causes are also excluded.

Each permission request binds the current Flow document sequence, approval request, opaque action,
actor, and run. The selected option passes through the same `RunPresentationActionController` used
by the terminal and browser hosts. Stale, duplicated, changed, cross-run, or settled actions fail
under that controller and the durable approval channel.

ACP cancel and `session/close` submit one deterministic cancellation command identity to the
existing supervisor path when a submission exists. Closing an empty session creates no supervisor
command. Repeated cancellation and close are therefore idempotent. Close blocks later prompts on
that connection until a successful `session/load` or `session/resume`. Connection loss and EOF do
not invoke cancellation.

## Replay and restart

`session/list` reads the bounded descriptor index. `session/load` validates project and policy,
publishes the supported Flow commands, and replays the public document from the durable run ledger.
`session/resume` restores the adapter without replay. Neither operation consults live workflow,
candidate, package, registry, credential, or network sources.

An empty session can be listed and loaded before `/flow-run`. It has no run events to replay. After
submission, the descriptor, supervisor command, and run ledger form the complete identity chain.

## Run a local ACP executor

Current source builds can launch one operator-selected local ACP v1 agent for all eligible agent
nodes in one attached or detached run. If you omit the selection, Flow uses its embedded Pi
executor with the same behavior as before.

### Prepare the workflow

Every agent node in an ACP-selected run must use the prompt-only contract:

- Declare no tools, Agent Skills, tool packages, or command approval.
- Select a provider and model that the manifest maps exactly.
- Select a reasoning setting that the manifest maps exactly.

Flow rejects the node before process launch if any requirement is missing. The ACP agent cannot
silently select another model or reasoning setting.

### Prepare the manifest

Store the manifest below the project root in `.flow/acp-agents/`. The manifest binds ACP v1 and one
exact executable or Node package closure. It also binds model mappings, provider domains, one
credential name per provider, accounting support, and the `acp-prompt-only-v1` profile.

The following shortened binary example shows the required shape. Replace every example value with
the exact local value, and keep model mappings and provider authorities sorted by provider and
model.

```json
{
  "apiVersion": "flow.synapti.ai/v1alpha1",
  "kind": "AcpAgent",
  "metadata": { "name": "example-agent" },
  "spec": {
    "protocol": "acp-v1",
    "compatibilityProfile": "prompt-only-v1",
    "launch": {
      "kind": "binary",
      "executable": "/absolute/path/to/example-agent",
      "executableSha256": "<64-lowercase-hex-characters>",
      "args": ["--stdio"]
    },
    "modelMappings": [
      { "provider": "openai", "model": "gpt-5.6-codex", "agentModel": "gpt-5.6-codex" }
    ],
    "providerAuthorities": [
      { "provider": "openai", "domain": "api.openai.com", "credentialEnv": "OPENAI_API_KEY" }
    ],
    "containmentProfile": "acp-prompt-only-v1",
    "usage": { "modelTokens": "complete", "costUsd": "unavailable" },
    "configuration": {
      "assignments": [
        { "configId": "model", "source": "model" },
        {
          "configId": "thinking",
          "source": "thinking",
          "mappings": [{ "thinking": "high", "value": "high" }]
        }
      ]
    }
  }
}
```

Admission uses bounded, no-follow local reads. It doesn't search `PATH`, a package registry, a
package manager, or a home directory. It doesn't contact a network service or start a subprocess.
Flow checks hashes, byte counts, file identities, the package closure, the entry point, and the
declared Node version. It then stores the immutable identity in the run capability snapshot. The
selection changes the capability digest, not the workflow digest.

### Validate and run

Validate the workflow and manifest together:

```sh
flow validate path/to/workflow.yaml \
  --acp-agent .flow/acp-agents/example-agent.json
```

Start an attached run:

```sh
flow run path/to/workflow.yaml \
  --acp-agent .flow/acp-agents/example-agent.json
```

Add `--detach` to submit the same immutable selection to a detached worker. Recovery reopens the
durable capability snapshot and revalidates the exact local runtime before it starts a fresh
attempt. A missing or changed executable, package, runtime, manifest identity, or model mapping
fails closed.

### Understand the execution boundary

Each node attempt gets a new private directory, operating-system process, and ACP session. Flow
binds the session to the run, workflow, node, attempt, and admitted agent digest. The client
advertises no filesystem, terminal, elicitation, MCP, or extension capability. It supplies no MCP
servers or additional directories.

The SRT sandbox gives the process these authorities only:

- Read the admitted executable and runtime support files.
- Read and write its private disposable attempt state.
- Connect to the declared provider domain.
- Receive the one selected credential through SRT credential masking.

The process cannot read the project, home directory, Flow state, protected paths, or source
credential. It cannot write outside its private state. Flow denies and records tool activity,
permission requests, and undeclared client methods by fixed authority category, then terminates the
attempt.

Flow bounds protocol frames, JSON structure, active requests, standard output, standard error,
result size, duration, and cleanup. Cancellation, timeout, malformed output, unexpected EOF,
process failure, and output contamination fail the attempt. Flow waits for the complete process
tree to exit. Unconfirmed descendant termination is attempt-fatal. A failure after the prompt
starts is nonretryable and records uncertain side-effect status because the remote provider might
have observed work.

### Inspect evidence and accounting

Successful agent evidence includes the declared provider, model, result hash, duration, and exact
agent digest. It also includes hashed session identity, a run-bound session digest, sandbox
provenance, confirmed termination, update count, and usage provenance. Model-verifier evidence
preserves the same ACP provenance.

Token and reported-cost availability are independent. A complete observation contributes its
measured value. An unavailable observation remains unavailable in durable state, public
presentation, and evaluation metrics. Flow doesn't convert it to zero. A workflow that sets
`maxModelTokens` or `maxCostUsd` fails before its first event when accounting is incomplete.

Public output includes safe cryptographic identity and compatibility fields. It excludes launch
paths, arguments, filesystem identities, manifest contents, configuration values, provider
authority details, credential names, and credential values.

Read [Architecture](architecture.md#local-acp-executor) for ownership and dependency direction.
Read [Recovery and interruption safety](recovery.md) for the fresh-attempt recovery contract.

## Transport limits and cleanup

Flow uses the official `@agentclientprotocol/sdk` version 1.4.0 for ACP types, routing, and the
independent compatibility peer. A Flow-owned stream enforces stricter local limits:

- one JSON-RPC object per newline-delimited frame.

- at most 1,048,576 UTF-8 bytes per frame.

- at most 32 JSON levels and 8,192 JSON nodes.

- integer or bounded nonempty string request identifiers.

- at most 64 active requests in each direction.

- at most 64 distinct cancellation notifications in progress. Duplicates for one session coalesce.

- initialize as the first request and a successful response before later traffic.

- closed method allowlists and exact response matching.

Duplicate keys, batches, fatal Unicode, oversized or incomplete frames, unknown methods, duplicate
or unknown ids, invalid ordering, and transport failures produce fixed value-free errors. The
reader uses pull-driven backpressure and one fixed frame buffer. The writer settles queued writes
before cleanup. Reader cancellation, output settlement, process signals, EOF, and double failures
preserve the first protocol error and do not attach private transport causes.

Each protocol output or cleanup operation and each permission response has a 30-second bound. A
permission timeout cancels only that peer request. It does not cancel the durable Flow run.

## Standards boundary

ACP transports editor-to-agent sessions. The A2UI profile is an inert package ABI that arranges
Flow-owned terminal and browser widgets. Its catalog v2 can add bounded attributed static notes to
those two hosts. A2UI does not define ACP sessions, and ACP does not change or replace presentation
packages.

ACP also defines agent-owned session configuration options for model, mode, and reasoning controls.
Flow does not advertise its work profile as writable session configuration. The durable workflow
ledger remains the profile authority. Read the
[ACP session configuration announcement](https://agentclientprotocol.com/announcements/session-config-options-stabilized)
for the standard configuration boundary. Read [Run and control workflows](guides/run-and-control.md#select-a-work-profile)
for Flow profile behavior.

The ACP projector deliberately ignores the package-note section. It emits only Flow-owned plan,
status, and permission updates. No custom ACP method or extension carries package content.
A2A and AG-UI address different remote or application event boundaries. They are outside this local
version 1 bridge.

See [Architecture](architecture.md) for the ownership model and
[Recovery and interruption safety](recovery.md) for restart guidance.
