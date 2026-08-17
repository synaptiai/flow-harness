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
- **Invalid input** — Unsupported versions, methods, capabilities, MCP servers, prompt shapes,
  stale decisions, malformed or duplicate-key JSON, invalid Unicode, excessive depth or nodes,
  oversized frames, and invalid message ordering fail closed with fixed value-free protocol errors
  before unauthorized mutation.
- **Missing context** — Unknown, foreign, unbound, unavailable, or policy-incompatible sessions and
  runs fail closed. Load and replay never fall back to live workflow, package, candidate, registry,
  credential, or network sources.

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
  admitted snapshots; session resume restores the active adapter without replay.

## Standards research

- ACP v1 is the current stable protocol. ACP v2 is explicitly draft.
- The ACP baseline requires `initialize`, `session/new`, `session/prompt`, `session/cancel`, and
  `session/update`. Session list, load, resume, and close are capability-gated stable additions.
- ACP clients may advertise filesystem and terminal methods, and session setup carries MCP server
  descriptors. Flow deliberately does not consume those authority surfaces in this increment.
- The official TypeScript SDK is `@agentclientprotocol/sdk` 1.3.0 under Apache-2.0. It declares the
  repository's existing Zod version range as a peer dependency.

Authoritative references:

- <https://agentclientprotocol.com/protocol/v1/overview>
- <https://agentclientprotocol.com/protocol/v1/initialization>
- <https://agentclientprotocol.com/protocol/v1/session-setup>
- <https://agentclientprotocol.com/protocol/v1/transports>
- <https://agentclientprotocol.com/libraries/typescript>
- <https://github.com/agentclientprotocol/typescript-sdk>

## Approaches considered

| Approach | Interoperability | Flow boundary control | Maintenance | Disposition |
| --- | --- | --- | --- | --- |
| Official SDK plus a Flow-owned bounded stream and application adapter | High | High | Medium | Selected |
| Hand-written JSON-RPC and copied ACP schemas | Medium | High | High; risks standards drift | Rejected |
| Official SDK convenience NDJSON stream directly in the CLI | High | Low; raw logging and unbounded lines | Low | Rejected |

The selected hybrid keeps the standard protocol implementation independently testable while
preserving Flow's stricter resource, privacy, and error contracts at the byte-stream boundary.
