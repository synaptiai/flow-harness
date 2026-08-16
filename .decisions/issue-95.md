# Decision Journal: Issue #95 — Stable terminal presentation host

**Issue**: #95 | **Branch**: `codex/issue-95-terminal-presentation-host` | **Started**: 2026-08-16

---

## Context

Flow already exposes durable run observation and steering through separate JSON commands. Operators
can inspect a run, read bounded event pages, follow new events, approve or deny pending work, and
cancel active or queued work. The roadmap also names a future TUI, UI contribution manifests, and a
stable presentation-host contract. No Flow-owned presentation model currently connects those user
flows.

Defining a third-party presentation manifest first would create an unused ABI. It would not prove
how the host derives public state, follows a durable cursor, maps actions to existing controls,
neutralizes hostile terminal text, or restores terminal ownership. Issue #95 therefore builds the
first-party host before admitting any presentation package.

Run and event state can contain workflow-, model-, tool-, provider-, and operator-derived strings.
Those values are bounded for durable storage, but they are not terminal-safe presentation data.
The host must preserve the public-output privacy boundary and must not create another path for
mutating a ledger or supervisor.

## External evidence

- [MITRE CWE-150](https://cwe.mitre.org/data/definitions/150.html) describes terminal escape
  sequence injection through untrusted output, including cursor movement, screen clearing, fake
  prompts, and terminal-specific side effects. Flow therefore treats every non-Flow display value
  as inert text before adding renderer styling.

- The [Model Context Protocol Apps extension](https://modelcontextprotocol.io/extensions/apps/overview)
  uses a sandboxed UI resource, capability negotiation, and a message bridge. That is a useful
  future browser-host precedent, but it also introduces executable HTML and bridge authority that
  this terminal-only issue deliberately excludes.

- [A2UI](https://github.com/a2ui-project/a2ui) uses declarative data and a client-owned component
  catalog instead of arbitrary UI code. This supports a closed, renderer-neutral Flow document,
  but the evolving external schema is not adopted as Flow's contract.

- [WebAssembly Component Model worlds](https://component-model.bytecodealliance.org/design/worlds.html)
  explicitly declare imports and exports. They are a possible future executable-extension boundary,
  but they add a runtime and capability system that are unnecessary for a presentation-only host.

- [The Update Framework metadata model](https://theupdateframework.io/docs/metadata/) separates
  authenticated target identity, freshness, and application. That supports keeping later package
  discovery and activation separate from the host contract rather than adding automatic update
  behavior here.

## Roadmap choice

The comparison weights dependency closure 25%, trust-boundary fit 25%, direct operator value 20%,
reuse of proven Flow seams 15%, and reversibility 15%.

| Next slice | Score / 5 | Strength | Primary weakness | Disposition |
| --- | ---: | --- | --- | --- |
| First-party terminal host and Flow presentation contract | 4.70 | Exercises existing observe and steer flows while proving the future host ABI | Requires terminal lifecycle and hostile-text handling | **Selected** |
| Automatic package updater | 3.60 | Advances remote lifecycle automation | Requires scheduling, freshness, rollout, rollback, and recovery authority | Separate lifecycle milestone |
| Presentation manifest before a host | 3.40 | Starts the future UI-package schema | Produces an unused ABI with no exercised consumer semantics | Rejected ordering |
| MCP Apps HTML host | 2.95 | Reuses a browser-oriented interoperable UI protocol | Admits executable HTML, CSP, bridge, and browser trust boundaries | Future browser milestone |
| Wasm executable extensions | 2.75 | Can express explicit imports and exports | Requires a new executable runtime, containment, and portability program | Future isolation milestone |

The ordering remained stable under equal weights and when each criterion was removed independently.
The terminal host ranked first in every sensitivity run. The user approved Approach A on 2026-08-16.

## Architecture alternatives

### A. Flow-owned presentation contract plus first-party terminal host — selected

Flow derives one bounded versioned presentation document from its existing public run projection.
A first-party controller follows the authoritative event cursor, applies events through the existing
run reducer, renders the document through an injected adapter, and routes actions through the
existing approval and cancellation boundaries.

- **Strengths**: proves the presentation ABI in a real user flow, keeps durable state authoritative,
  reuses existing controls, and creates a safe consumer for later inert presentation packages.
- **Costs**: must define terminal ownership, display neutralization, controller settlement, and a
  renderer adapter now.
- **Dependency rule**: a terminal library may render Flow-owned styling only. It is not a parser,
  sanitizer, authority, state store, or action router.

### B. Presentation-package manifest first — rejected

Define an inert package schema and postpone the host.

- **Strengths**: small domain-only change and early schema discussion.
- **Failure**: no current user flow consumes the schema, so bounds, actions, rendering, privacy, and
  compatibility would be speculative and mutation-weak.

### C. Automatic package updates first — deferred

Extend metadata checking into polling, selection, and activation.

- **Strengths**: completes an explicit roadmap lifecycle gap.
- **Failure**: automatic mutation needs persistent scheduler ownership, TUF-style freshness and
  rollback rules, credentials, settlement, rollout, and operator recovery. It is a larger authority
  change than presentation.

### D. Executable HTML or Wasm presentation extensions — rejected

Let packages contribute browser or Wasm renderers.

- **Strengths**: flexible third-party experiences.
- **Failure**: introduces executable package authority before Flow has a stable host contract or the
  VM-grade isolation milestone required by the roadmap.

## Selected architecture

The domain owns a strict `FlowPresentationDocument` version 1. It contains only public, renderer-
neutral values and a closed set of component and action kinds. A pure projector translates one
`RunState` public projection into that document with deterministic ordering and explicit truncation.
The document never becomes durable run authority.

The application layer owns a run-presentation session. It requests supervisor event pages from an
exact cursor, reduces them with `appendRunEvent`, projects the current document, and hands it to an
injected renderer. It keeps only current reduced state, the cursor, one stable cancellation command
identity, and bounded UI selection state. It does not retain an unbounded event history.

The controller routes approval, denial, and cancellation through extracted Flow application
boundaries shared with the JSON CLI. Renderer input is an intent only. The controller rebinds each
intent to the current exact public action identity before invoking a mutation. It never writes a
ledger or supervisor store.

The infrastructure adapter owns terminal mode, screen, cursor, resize handling, input decoding,
and restoration. The terminal dependency is a direct exact-version dependency. Flow sanitizes
untrusted text before the adapter receives it; the adapter may add only Flow-owned styling.

## Specification

_Captured by specification-capture skill on 2026-08-16. Source: mixed. The issue supplies the
objective, non-goals, and failure contract. The user approved Approach A and the contracts below._

### Non-goals

- Admitting UI or presentation packages. The first-party host proves the contract that a later
  issue can expose to inert packages.

- Executing HTML, JavaScript, CSS, Wasm, native code, hooks, templates, or package renderers.

- Granting network, filesystem, credential, provider, tool, graph, policy, sandbox, or durable-state
  authority to presentation data.

- Replacing the JSON CLI, supervisor protocol, durable ledger, event reducer, or existing approval
  and cancellation application boundaries.

- A browser UI, remote multi-user console, accessibility-complete graphical client, automatic
  package updates, or executable extensions.

### Failure modes

- **Timeouts and cancellation** — cancellation stops later observation and rendering phases. If a
  steering action already owns a command identity, its settled or uncertain result wins over late
  cancellation. Observation closes and terminal ownership restores exactly once.

- **Partial failures** — an event page or renderer failure never advances the durable cursor beyond
  reduced state. An action failure preserves the current authoritative state. An uncertain action
  retains the exact command identity for explicit same-command recovery. Cleanup errors never hide
  the primary failure.

- **Invalid input** — malformed, excessive, private, terminal-active, out-of-order, duplicated,
  incompatible, or policy-mismatched input rejects or neutralizes at a fixed value-free stage before
  gaining presentation or action authority. No raw value or nested private cause enters public output.

- **Missing context** — a missing run, supervisor, policy match, actor, action target, renderer,
  terminal capability, or event page fails closed. The host never invents state, chooses a fallback
  run, or submits an action.

- **Resource exhaustion** — the presentation schema enforces depth, serialized bytes, component,
  row, cell, action, and text-byte limits. Event pages remain capped by the supervisor protocol. The
  controller retains current state instead of event history and serializes render requests.

### Interface contracts

- `FlowPresentationDocument` is version 1 and renderer-neutral. Its root has one run identity, one
  revision cursor, ordered sections, and ordered actions. Components are a closed union of heading,
  facts, progress, table, notice, and divider records. Actions are a closed union of approve, deny,
  and cancel intents.

- The document is strict and bounded. Unknown keys and unknown union members reject. Text is bounded
  by UTF-8 bytes, not UTF-16 code units. Total depth, items, rows, cells, actions, and canonical JSON
  bytes are independently bounded. Truncation is deterministic and explicitly represented.

- Presentation text is `SafeDisplayText`, not arbitrary terminal output. It permits printable
  Unicode plus Flow-owned line structure after replacing malformed surrogates, C0/C1 controls,
  carriage return, tab, escape, bidi controls, and terminal hyperlink/title/clipboard/cursor control
  material with inert visible replacement text. It never emits an untrusted escape byte.

- `RunPresentationProjector` accepts only the existing public run projection. It cannot receive
  capability resource bytes, credentials, protected paths, or raw error causes. It sorts facts,
  nodes, evidence summaries, approvals, and actions by documented stable keys.

- `RunPresentationSession` consumes pages using one `afterSequence` cursor. Every event must be the
  exact next sequence accepted by `appendRunEvent`. An empty nonterminal page keeps the cursor and
  applies bounded polling backoff. Cursor regression, cursor gaps, incompatible run identity, and
  malformed terminal claims fail closed.

- `RunPresentationAction` carries the exact current request identity and an actor for approve or
  deny. Cancellation carries the exact run identity, actor, and a stable command UUID reused across
  settlement recovery. Renderer-created labels or positions are never authority.

- `FlowTerminal` is an injected infrastructure port. It reports interactive capability, dimensions,
  input, resize, and lifecycle events. `start()` acquires ownership once. `restore()` is idempotent
  and settles exactly once after ordinary exit, signal, cancellation, or failure.

- The third-party renderer dependency is imported only by its infrastructure adapter. Domain and
  application modules import only Flow contracts. Existing JSON commands have no dependency on an
  interactive terminal.

## User, system, and administrator flows

### Open and follow one run

1. The operator starts `flow tui <run-id>` in an interactive terminal.
2. Flow validates grammar, configuration, terminal capability, and supervisor policy before any
   mutation or terminal takeover.
3. The session requests bounded event pages from cursor zero and reduces each event in order.
4. After each settled page, Flow projects one bounded public presentation document.
5. The renderer replaces the current view without making the document authoritative.
6. Terminal state reaches the same run result as ordinary authoritative replay.

### Approve or deny pending work

1. The operator selects one visible current action and supplies an exact actor at command entry.
2. The controller rebinds the selection to the current action id and kind.
3. The existing Flow approval boundary validates policy, expiry, state, and idempotency.
4. The controller follows subsequent durable events and renders their authoritative result.

### Cancel active or queued work

1. The controller creates one command UUID before submitting cancellation.
2. Retry or recovery reuses that identity and never invents a second cancellation command.
3. The existing supervisor cancellation boundary owns durable mutation and settlement.
4. The session follows the resulting events until terminal state or an explicit observation failure.

### Terminal and supervisor recovery

1. Any exit path first stops accepting new input and new presentation actions.
2. An already-owned action settles or returns its existing uncertain result.
3. The event observation is closed.
4. The renderer and terminal restore exactly once while preserving the primary error.
5. The operator can use the unchanged JSON `inspect`, `events`, `approve`, `deny`, and `cancel`
   commands for automation or explicit recovery.

## Coupling analysis

| Consumer | Required change | Constraint |
| --- | --- | --- |
| Presentation domain | Add strict document, safe text, bounds, parser, and projector | No terminal, supervisor, provider, Pi, or filesystem types |
| Public run projection | Supply only already-public state to the projector | Never expose capability bytes or causes |
| Application controller | Follow cursor pages, reduce events, project state, route intents | No direct ledger or supervisor-store mutation |
| Supervisor client | Reuse status, event page, approval, and cancel commands | Protocol authority and page bounds remain unchanged |
| CLI | Add `tui` grammar and share action application functions | Existing JSON output and exit behavior remain exact |
| Terminal adapter | Own screen, input, resize, rendering, and restoration | Sanitization occurs before styling; cleanup exactly once |
| Dependency graph | Add one exact direct terminal dependency if retained | Infrastructure-only import; license and transitive audit |
| CI | Add deterministic tests and one Linux x64 pseudo-terminal runtime | No native addon or install-script dependency |
| Documentation | Explain host, trust, controls, fallback, and remaining UI packages | Do not claim package-contributed UI or remote console |

## TDD implementation sequence

1. RED/GREEN strict presentation text and document schemas. Cover canonical bytes, every bound,
   malformed Unicode, C0/C1, CSI, OSC 8, OSC 52, cursor/title controls, carriage-return overwrite,
   bidi controls, and planted private canaries.

2. RED/GREEN pure public run projection. Cover empty, active, waiting, approval, resource, evidence,
   failure, cancelled, and succeeded states; 256-node bounds; deterministic ordering; truncation;
   and absence of private package fields at every document path.

3. RED/GREEN cursor session control with injected page and renderer ports. Cover pagination, follow,
   duplicate pages, gaps, regression, malformed responses, policy mismatch, disappearance,
   cancellation, serialized rendering, and terminal-state equivalence with full replay.

4. RED/GREEN action routing through extracted approval and cancellation application boundaries.
   Cover command, agent-command, and workflow approvals; exact actors and request ids; stale actions;
   idempotency; rejection; uncertain settlement; stable cancel UUID; and no direct mutation.

5. RED/GREEN terminal ownership and the renderer adapter. Cover non-TTY rejection, acquire/restore,
   resize, input parsing, unsupported keys, primary plus cleanup errors, signals, Flow styling, and
   injected deterministic terminal frames.

6. RED/GREEN CLI integration through the real supervisor and socket. Cover paged and followed
   events, approve, deny, cancel, supervisor loss, public privacy, unchanged JSON commands, and no
   mutation before terminal admission.

7. RED/GREEN one Linux x64 pseudo-terminal test for startup, update, action, exit, and restoration.
   Keep the portable injected-terminal suite authoritative for layout and failure mutations.

8. Update README, architecture, recovery, testing, capability sourcing, and roadmap documentation.
   Explain the trust boundary and state that presentation packages remain future work.

9. Run focused, full, coverage, build, package, audit, documentation, Linux runtime, and CI-parity
   gates. Run independent correctness, security, specification, and holdout review. Resolve every
   P1, P2, and P3 finding before publication.

## Acceptance-criterion verification map

| Criteria covered | Type | Planned verification | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict bounded presentation contract and deterministic projection | Contract/data | `npx vitest run test/unit/presentation/flow-presentation.test.ts test/unit/presentation/run-presentation-projector.test.ts` | Exact-bound positives, +1 negatives, unknown-member rejection, stable ordering, truncation, and replay-equivalent documents pass | Third-party presentation packages |
| Terminal-safe public text and privacy | Security/error | `npx vitest run test/unit/presentation/safe-display-text.test.ts test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts test/unit/cli/public-output.test.ts` | Every control family and private canary becomes inert before Flow styling; no private cause or package bytes appear | Rendering arbitrary package markup |
| Bounded cursor observation and controller failures | Behavioral/recovery | `npx vitest run test/unit/application/run-presentation-session.test.ts` | Pagination, follow, cursor gaps, malformed pages, disappearance, cancellation, serialized rendering, and terminal replay equivalence pass | Cross-host supervisor migration |
| Exact approval, denial, and cancellation routing | Behavioral/authority | `npx vitest run test/unit/application/run-presentation-actions.test.ts test/integration/cli/tui.test.ts` | Command, agent-command, workflow, and cancel actions call existing boundaries with exact identities; stale or uncertain actions fail closed | New steering semantics |
| Terminal ownership and renderer isolation | Runtime/error | `npx vitest run test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts test/integration/package/dependency-boundaries.test.ts` | Non-TTY, acquire, resize, input, signals, primary/cleanup aggregation, exact restore, and infrastructure-only dependency rows pass | Browser or remote terminals |
| Real supervisor/socket and Linux x64 pseudo-terminal | Integration/runtime | `npx vitest run test/integration/cli/tui.test.ts && npx vitest run --config vitest.runtime.config.ts test/runtime/tui-pty.runtime.test.ts` | Real paged/followed observation, approve/deny/cancel, startup, update, action, exit, and restoration pass | Other operating systems beyond supported macOS/Linux |
| Existing JSON automation remains exact | Regression/API | `npx vitest run test/integration/cli/main.test.ts test/integration/cli/agent-skill-activation.test.ts test/integration/supervisor/service.test.ts` | Inspect, events, approve, deny, cancel, public projection, and supervisor semantics remain unchanged | A replacement JSON protocol |
| Documentation and roadmap accuracy | Documentation | `npm run docs:ste && git diff --check` | Host, trust, controls, recovery, dependency, testing, and remaining UI-package work are current and prose-clean | Automatic updates or executable extensions |

## Implementation evidence

Evidence was collected from the frozen Issue #95 tree on 2026-08-16.

| Gate | Command | Result |
| --- | --- | --- |
| Portable presentation and dependency tests | `npx vitest run test/unit/presentation/safe-display-text.test.ts test/unit/presentation/flow-presentation.test.ts test/unit/presentation/run-presentation-projector.test.ts test/unit/application/run-presentation-session.test.ts test/unit/application/run-presentation-actions.test.ts test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts test/unit/cli/public-output.test.ts test/integration/package/dependency-boundaries.test.ts` | 106 tests passed in 8 files |
| Real supervisor and terminal CLI tests | `npx vitest run test/integration/cli/tui.test.ts` | 12 tests passed |
| Linux x64 pseudo-terminal acceptance | `npx vitest run --config vitest.runtime.config.ts test/runtime/tui-pty.runtime.test.ts` in a clean `node:26.7.0-bookworm` `linux/amd64` container with `util-linux` | 1 test passed; startup, approval, durable update, exit, and alternate-screen restoration were observed |
| Complete coverage suite | `npm run test:coverage` | 3,602 tests passed and 4 tests skipped in 254 files; statements 83.68%, branches 77.87%, functions 90.11%, and lines 83.80% |
| Host runtime suite | `npm run test:runtime` | 39 tests passed and 34 host-inapplicable tests skipped in 18 files |
| Formatting and lint | `npm run format:check && npm run lint` | Passed; lint reported one inherited informational constructor note |
| Build and type safety | `npm run build && npm run typecheck` | Passed |
| Compiled CLI smoke | `node scripts/smoke-compiled.mjs` | Passed with local socket access |
| Package consumer | `npm run pack:check` | A clean consumer installed and ran `synaptiai-flow-harness-0.0.0.tgz`; policy digest `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4` |
| Production dependency audit | `npm audit --omit=dev --audit-level=low` | Zero vulnerabilities |
| Prime dependency audit | `node scripts/audit-prime-dependencies.mjs` | The Node lock and 60 Python packages passed |
| Documentation and diff | `npm run docs:ste && git diff --check` | Passed |

The macOS-applicable local CI gates are recorded above. The existing Prime OCI host guard remains
Linux x64-only. The separate clean Linux x64 container run supplied the Issue #95 pseudo-terminal
acceptance evidence. CI installs `util-linux` before it runs that test, so the hosted Linux job
exercises the same `script` executable used by the local container.
