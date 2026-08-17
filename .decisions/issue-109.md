# Decision Journal: Issue #109 — Expose durable Flow runs through ACP v1 without widening authority

**Issue**: #109 | **Branch**: `codex/issue-109-acp-v1-bridge` | **Started**: 2026-08-17

---

## Context

Flow already owns durable run admission, replay, approvals, cancellation, public output, terminal
presentation, and local browser presentation. Issue #109 adds one standards-based editor transport.
The transport must not become a second workflow, policy, package, sandbox, or durable-state
authority.

The stable target is Agent Client Protocol v1. ACP v2 is published as a draft and is outside this
increment. The official TypeScript SDK 1.3.0 provides typed ACP v1 schemas and fluent agent/client
APIs. Its convenience NDJSON adapter is not suitable for Flow because it does not impose Flow's
frame/complexity bounds and logs malformed input. Flow will keep transport framing behind its own
strict bounded infrastructure adapter while using the official SDK for protocol types and routing.

## Specification

_Captured by specification-capture on 2026-08-17. Source: extracted from Issue #109 and the
approved Approach A._

### Non-goals

- Do not define a custom A2UI-over-ACP extension or replace the A2UI presentation package ABI.
- Do not add HTTP, WebSocket, reverse-proxy, remote, shared-user, or multi-tenant ACP hosting.
- Do not delegate Flow authority to editor filesystem, terminal, MCP server, provider, or custom
  extension capabilities.
- Do not add automatic package activation, AG-UI, A2A, ACP v2, or executable UI packages.
- Do not change workflow, policy, approval, sandbox, supervisor, package, or run-ledger authority.

### Failure modes

- **Timeouts** — A stalled client, permission response, output write, event page, or supervisor
  operation is cancellable and bounded. It cannot retain an unbounded queue or mutate a different
  session.

- **Partial failures** — A durable Flow mutation remains durable if the ACP response or connection
  fails afterward. Protocol and renderer cleanup runs without replacing the primary error, and
  disconnect alone does not silently cancel the Flow run.

- **Invalid input** — Unsupported versions, methods, capabilities, and MCP servers fail closed.
  Invalid prompts and stale decisions also fail closed. Strict parsing rejects malformed JSON,
  duplicate keys, invalid Unicode, excessive structure, oversized frames, and invalid ordering.
  Each failure uses a fixed value-free error before unauthorized mutation.

- **Missing context** — Unknown, foreign, unbound, unavailable, or policy-incompatible sessions and
  runs fail closed. Load and replay do not use live workflow or package sources. They also do not
  use live candidate, registry, credential, or network sources.

### Interface contracts

- `flow acp` is a local stdio ACP v1 agent. Standard input and output carry newline-delimited
  JSON-RPC only. Standard error contains fixed value-free operational diagnostics only.

- Initialization negotiates protocol version 1 and advertises only implemented ACP capabilities.
  Flow does not call client filesystem or terminal methods and does not accept client MCP servers.

- A new ACP session is local to one canonical project directory. Explicit Flow slash commands bind
  it to exactly one admitted run operation. The resulting durable session identity is cross-bound
  to the Flow run, workflow, project, and policy identity.

- Standard `session/update`, plan, tool-call, permission, cancellation, list, load, and resume
  messages carry only public-safe Flow projections. They never carry capability resource bytes,
  raw events, provider output, private paths, secrets, tokens, or nested private causes.

- Approval, denial, and cancellation route through the existing exact current-action and supervisor
  controls. ACP message or session identity alone never authorizes a Flow mutation.

- Session enumeration is bounded and cursor-based. Session load replays durable public state from
  admitted snapshots. Session resume restores the active adapter without replay.

## Standards research

- ACP v1 is the current stable protocol. ACP v2 is explicitly draft.

- The ACP baseline requires `initialize`, `session/new`, `session/prompt`, `session/cancel`, and
  `session/update`. Session list, load, resume, and close are capability-gated stable additions.

- ACP clients may advertise filesystem and terminal methods, and session setup carries MCP server
  descriptors. Flow deliberately does not consume those authority surfaces in this increment.

- The official TypeScript SDK is `@agentclientprotocol/sdk` 1.3.0 under Apache-2.0. It declares the
  repository's existing Zod version range as a peer dependency.

Authoritative references:

- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview).
- [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization).
- [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).
- [ACP transports](https://agentclientprotocol.com/protocol/v1/transports).
- [ACP TypeScript library](https://agentclientprotocol.com/libraries/typescript).
- [Official TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk).

## Approaches considered

| Approach | Interoperability | Flow boundary control | Maintenance | Disposition |
| --- | --- | --- | --- | --- |
| Official SDK plus a Flow-owned bounded stream and application adapter | High | High | Medium | Selected |
| Hand-written JSON-RPC and copied ACP schemas | Medium | High | High, with standards drift risk | Rejected |
| Official SDK convenience NDJSON stream directly in the CLI | High | Low due to raw logging and unbounded lines | Low | Rejected |

The selected hybrid keeps the standard protocol implementation independently testable while
preserving Flow's stricter resource, privacy, and error contracts at the byte-stream boundary.

## Implementation

The implementation uses five owned boundaries.

1. `strict-acp-stream.ts` frames ACP messages with the Flow strict JSON parser. It applies fixed
   byte, depth, node, identifier, and encoding limits.

2. `flow-acp-protocol-stream.ts` enforces initialization, method allowlists, exact request ids,
   request limits, response matching, write ordering, and deterministic settlement.

3. `local-acp-session-store.ts` persists immutable session descriptors. It uses stable no-follow
   reads, atomic publication, bounded listing, cancellation checks, and a local creation queue.

4. `flow-acp-agent.ts` implements the ACP v1 lifecycle. It maps only explicit Flow commands,
   public presentation updates, exact permission actions, and durable cancellation.

5. `flow acp` connects stdio to the agent. It reuses detached admission, supervisor control, run
   replay, approval decisions, and public presentation.

The official SDK remains the protocol router and independent peer. Flow does not use its
convenience NDJSON adapter in production. That adapter has different error and resource behavior.

Session creation reserves one UUID as both session and run identity. `/flow-run` uses the same UUID
as the supervisor command id. The supervisor command binds the admitted workflow and policy. The
run ledger binds the compiled graph and capability snapshot.

A lost supervisor response is reconciled from the completed command record. Reconciliation checks
the session, run, command, policy, mode, source, execution directory, and project. It does not
retry execution or accept an uncertain command.

The bridge captures one effective Flow configuration at startup and reuses it for nested detached
admission. A policy change requires a bridge restart. After supervisor acceptance, `/flow-run`
waits for the first ledger event for at most 30 seconds. This closes the command-to-ledger gap
without submitting the workflow again.

Agent-originated request ids are reserved before transport I/O, and a written cancellation
notification retires its exact request id. Protocol output, cleanup, and permission response waits
have 30-second bounds. Cancellation notifications coalesce by session and admit at most 64
distinct in-flight operations.

`session/close` is idempotent connection-local adapter state. It durably cancels a submitted run,
creates no supervisor command for an empty session, and blocks later prompts until a successful
load or resume. Cancellation of an active `/flow-run` waits for submission settlement before it
reconciles the durable cancellation command.

## Criterion verification map

| Criteria | Evidence |
| --- | --- |
| 1 and 8 | Agent tests cover v1 negotiation, v2 refusal, initialization order, MCP refusal, extra-directory refusal, and closed capabilities. |
| 2, 3, and 7 | CLI integration covers create, list, load, restart replay, live-source traps, captured-policy reuse, the supervisor-to-first-ledger gap, and the session-to-supervisor-to-ledger identity chain. |
| 4 and 5 | Presentation, public-output, action-controller, and agent tests cover public updates, privacy canaries, exact permissions, and current actions. |
| 6 | Agent, CLI, and runtime tests cover stable cancellation identity, submit-before-cancel settlement, empty and repeated close, close/reopen lifecycle, disconnect, and process signals. |
| 9 and 10 | Strict-stream, protocol-stream, agent, and session-store tests cover framing, JSON limits, ids, ordering, fast responses, request cancellation retirement, notification coalescing and capacity, store capacity, and backpressure. |
| 11 | Agent, protocol, CLI, and runtime tests cover permission and output deadlines, EOF, failed writes, reader cancellation, output cleanup, primary-error precedence, setup privacy, and signals. |
| 12 | The compiled runtime test uses the official SDK `ndJsonStream` as an independent peer across two bridge processes. |
| 13 | README, architecture, ACP, recovery, capability-sourcing, and roadmap documents define the local boundary and deferred standards. |
| 14 | The dependency test checks the exact SDK version, Apache-2.0 license, lock integrity, and infrastructure-only imports. |

## Verification evidence

The mapped selector passed 103 tests across nine files:

```sh
npx vitest run \
  test/unit/infrastructure/acp/strict-acp-stream.test.ts \
  test/unit/infrastructure/acp/flow-acp-protocol-stream.test.ts \
  test/unit/infrastructure/acp/flow-acp-presentation.test.ts \
  test/unit/infrastructure/acp/flow-acp-agent.test.ts \
  test/unit/infrastructure/fs/local-acp-session-store.test.ts \
  test/unit/application/run-presentation-actions.test.ts \
  test/unit/cli/public-output.test.ts \
  test/integration/cli/acp.test.ts \
  test/integration/package/dependency-boundaries.test.ts
```

The compiled independent-peer selector passed three tests in one file:

```sh
npm run build
npx vitest run --config vitest.runtime.config.ts test/runtime/acp-cli.runtime.test.ts
```

The current tree also passed these gates:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run docs:ste
git diff --check
npx vitest run --maxWorkers=1
npm run test:coverage
npm audit --omit=dev
npm run pack:check
```

The full serial suite passed 3,982 tests in 286 files, with four expected skipped tests and one
skipped file. Coverage passed at 84.17 percent statements, 78.24 percent branches, 90.63 percent
functions, and 84.29 percent lines. The production dependency audit reported zero known
vulnerabilities.

The clean package verifier installed and executed
`synaptiai-flow-harness-0.0.0.tgz`. The package SHA-256 digest was
`5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`. Repository-wide lint
reported one inherited informational constructor note outside the Issue #109 change set and no
error.
