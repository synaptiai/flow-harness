# Local ACP v1 bridge

Flow implements one local Agent Client Protocol version 1 bridge. ACP is an interoperability
transport for editor clients. Flow still owns workflow admission, policy, packages, sandboxes,
approvals, cancellation, durable state, replay, and public projection.

## Start the bridge

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

## Transport limits and cleanup

Flow uses the official `@agentclientprotocol/sdk` version 1.3.0 for ACP types, routing, and the
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
Flow-owned terminal and browser widgets. A2UI does not define ACP sessions, and ACP does not change
or replace presentation packages. A2A and AG-UI address different remote or application event
boundaries and are outside this local version 1 bridge.

See [Architecture](architecture.md) for the ownership model and
[Recovery and interruption safety](recovery.md) for restart guidance.
