# Decision Journal: Issue #101 — Secure local browser presentation host

**Issue**: #101 | **Branch**: `codex/issue-101-local-browser-host` | **Started**: 2026-08-16

---

## Context

Issues #95 and #99 established a strict public presentation document. They also established a
first-party terminal host and inert A2UI-profile presentation packages. The next richer host needs
a graphical client. It must not create a second run authority or admit executable package UI. It
must not expose local run state to other users or web origins.

The user approved a first-party local browser host. The deployment model is one local developer.
Processes running as the same operating-system user remain inside the trusted operator boundary.
Other operating-system users and untrusted web origins do not.

## Standards evidence

- A2UI v0.9.1 is the current production release. Its custom-catalog model lets Flow retain the
  closed catalog implemented by Issue #99. The general web renderer also supports functions,
  bindings, and dynamic state that Flow continues to exclude.

- ACP protocol v1 is stable and has an official TypeScript SDK. It standardizes editor-to-agent
  sessions, updates, permissions, and terminal operations. It does not define this browser layout
  or replace Flow's event ledger. ACP remains a later editor-adapter seam.

- AG-UI provides a transport-agnostic frontend event protocol. Its run, message, state, and tool
  vocabulary would overlap Flow's existing authoritative run reducer. A browser-only adapter does
  not need that additional semantic layer.

- Browser `EventSource` cannot attach the required bearer header. A streaming `fetch` response can
  carry an authorization header and consume bounded newline-delimited JSON without cookies.

## Architecture alternatives

| Approach | Roadmap leverage | Authority fit | Standards fit | Cost | Decision |
| --- | --- | --- | --- | --- | --- |
| Fixed local browser host over the existing Flow presentation port | High | Closed | Strong A2UI reuse | Medium | **Selected** |
| ACP v1 agent adapter | Medium | Requires a new prompt/session mapping | Strong editor interoperability | High | Later transport seam |
| AG-UI bridge plus A2UI renderer | High | Duplicates run/event semantics | Strong frontend interoperability | High | Deferred |
| Stronger isolation before richer UI | High security value | Independent | Backend-specific | Very high | Separate roadmap slice |
| MCP App resource | Medium | Introduces executable HTML and MCP tool authority | Strong chat-host fit | High | Rejected for this slice |

The comparison covered prerequisites, roadmap value, authority closure, standards fit, and operator
value. The selected approach scored 4.55/5. It won 823 of 826 bounded weight vectors. The
isolation-first approach won the three security-dominant vectors. That work remains important but
independent.

## Approved defaults

### Transport defaults

- Command: `flow web <run-id> --actor <label> [--presentation <name>@<exact-version>]`.
- Explicit IPv4 loopback listener on an ephemeral port. No wildcard, hostname, Unix-socket proxy,
  forwarded-host, or remote-listen mode.
- A random 256-bit session capability appears only in the initial URL fragment. The fixed client
  removes the fragment and sends the capability in authorization headers.

### Stream defaults

- Fixed first-party HTML, CSS, and JavaScript. No package-supplied executable or content-bearing
  browser resource.
- Authenticated streaming `fetch` for bounded full presentation snapshots and strict authenticated
  action requests. One active observer is admitted at a time. A bounded reconnect window supports
  reload without retaining an unbounded background observer.

### Authority defaults

- The host enforces exact host and origin checks. It provides no CORS, cookies, service worker, or
  external resources.
- The client uses a closed CSP. It sends no referrer and uses no cache or framing.

### DOM and action defaults

- Run-derived values cannot insert markup.
- Each action binds the latest document sequence and opaque action id before it reaches the existing
  presentation action controller.
- Closing the browser observation never cancels the durable run.

## User, operator, and system flows

### Start and observe

1. The operator supplies one run, actor, and optional exact presentation package.
2. Flow validates grammar, configuration, run existence, and the complete presentation snapshot.
3. Flow resolves the shared supervisor boundary and creates the local listener last.
4. Flow reports one loopback URL with a fragment-held capability.
5. The fixed client authenticates, receives strict presentation snapshots, and renders them.
6. Terminal run state ends observation after the final snapshot reaches the client.

### Steer

1. The client submits the current document sequence, opaque action id, and an optional bounded
   denial or cancellation reason.
2. The host authenticates and validates the strict request.
3. The host rejects a stale sequence or action that is absent from the latest document.
4. The existing action controller rebinds the id and invokes the existing approval or cancellation
   application boundary.
5. The next authoritative event page produces the resulting view.

### Reload and disconnect

1. A browser reload closes the active stream.
2. The host retains at most the latest bounded document for one bounded reconnect interval.
3. A reauthenticated replacement stream receives that complete document and continues.
4. Expiry, process signal, listener failure, or ordinary browser abandonment closes observation and
   every owned HTTP resource. The run continues.

## Trust boundaries and assets

| Boundary | Protected asset | Existing or required control |
| --- | --- | --- |
| Browser origin → local host | Public run observation | Capability header, exact host/origin, loopback bind, fixed response grammar |
| Browser action → Flow control | Approval and cancellation authority | Current sequence plus action id, existing controller, policy-bound downstream control |
| Run/package values → DOM | Terminal-safe public text | Strict public projection, text-only DOM insertion, CSP, no package markup |
| Slow or hostile client → process | Memory, descriptors, event progress | Connection/body/header/document limits, one observer, backpressure deadline, reconnect deadline |
| Local host → supervisor | Durable events and mutations | Existing private same-UID socket, policy digest, strict supervisor protocol |

The session capability does not defend against a malicious same-UID process that can inspect or
control the operator's processes. It defends against other operating-system users, ambient web
origins, cross-site requests, and accidental disclosure.

## Specification

### Non-goals

The browser host does not provide these deployment or extension features:

- Remote, multi-user, shared-host, TLS-terminated, reverse-proxied, or externally reachable service.
- ACP, AG-UI, A2A, MCP, or MCP Apps transport support.
- Package HTML, CSS, JavaScript, Wasm, assets, URLs, renderers, bindings, functions, themes, data
  models, dynamic children, or actions.
- Starting, selecting, compiling, or changing workflows through the browser.
- Editing workflow files, viewing private model transcripts, or exposing raw ledger events.

The browser host also does not replace these existing boundaries:

- Replacing the JSON CLI, terminal host, supervisor protocol, event reducer, approval channel, or
  cancellation command.
- Persistent browser credentials, user accounts, cookies, remote authentication, or authorization
  between same-UID processes.
- General A2UI basic-catalog rendering or migration to the A2UI v1.0 candidate.

### Failure modes

| Failure | Required behavior |
| --- | --- |
| Invalid CLI, config, run, or presentation | Fail before listener creation. Package errors also precede supervisor mutation. |
| Bind/listener failure | Use a fixed value-free startup error and close any owned listener state. |
| Missing, invalid, or leaked capability | Reject without run data or action authority. Never echo the value. |
| Host/origin mismatch or cross-site request | Reject before body consumption or application callback |
| Malformed, excessive, slow, or partial request | Fixed bounded protocol error and connection settlement |
| Slow output client | Bounded backpressure wait, one latest full document, then close observation |
| Browser reload | Replace the prior stream within the reconnect window and send the latest full document |
| Stale, forged, repeated, or cross-run action | Reject before the control callback |
| Action settlement uncertainty | Preserve the existing primary error and cancellation command identity |
| Renderer or observation failure | Preserve the primary error. Close stream and listener exactly once. |
| Browser disconnect or process signal | End observation, not the run. Release listener and timers. |
| Run terminal state | Deliver the final document, close the stream, then close the listener |
| Resource exhaustion | Enforce independent limits for headers, body, JSON shape, connections, pending output, and time |

### Interface contracts

The data plane has these contracts:

- The browser consumes only `FlowPresentationDocument`. It never parses durable events or capability
  package bytes.
- The browser host publishes complete snapshots. It may coalesce unpublished snapshots only because
  every document is a complete projection of authoritative state.
- The first line sent to an authenticated observer is the latest complete document, if one exists.
  Later lines are strictly increasing document sequences for the same run.

The authenticated API has these contracts:

- One session capability is 32 random bytes encoded as 64 lowercase hexadecimal characters. It is
  compared in constant time after exact syntax validation.
- Static resources contain no session or run data. Data and action endpoints require both exact
  authority headers and the capability.

The action request has these contracts:

- Action input is strict bounded JSON. It contains the current positive document sequence and one
  opaque action id. It can contain one bounded reason. Unknown members reject.

The browser and resource owners have these contracts:

- The fixed client uses DOM node creation and `textContent`. It never inserts run-derived HTML.
- Public errors are fixed and contain no request, header, path, run, actor, token, package, document,
  or nested cause value.
- The listener, response streams, timers, and observation session have explicit single owners.
  Their settlement is idempotent.

## Criterion verification map

| Criterion group | Type | Planned verification | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| CLI admission and startup ordering | Behavioral/integration | Focused browser-host CLI tests | Invalid inputs create no listener, supervisor mutation, renderer, or output beyond a fixed error | Remote startup |
| Presentation and A2UI parity | Data/contract | Shared projector plus browser integration tests | Browser and terminal consume the same complete document and selected layout | General A2UI rendering |
| Loopback and capability boundary | Security/API | Real HTTP tests over an actual listener | Only exact loopback host/origin and bearer capability receive data or invoke callbacks | Same-UID adversary isolation |
| Fixed resources and browser hardening | API/security | Header, asset, CSP, and privacy mutation tables | No dynamic code/assets, permissive headers, token echo, or cross-origin access | Third-party browser extensions |
| Strict bounded protocol | Error/performance | Header/body/JSON/connection/backpressure/deadline boundary tests | Exact-bound success, +1 rejection, fixed errors, bounded memory and descriptors | Internet-scale load balancing |
| Current action binding | Behavioral/security | Stale/forged/replayed/cross-run action tests | Only the current sequence and action id reach the existing control seam | New action kinds |
| Cleanup and recovery | Behavioral/runtime | Disconnect/reload/signal/failure/terminal settlement matrix | All later cleanup runs once; observation never cancels the run | Process survival after machine loss |
| Browser behavior and accessibility | UI | Pinned Chromium interaction, accessibility snapshot, and screenshots at 1280×720, 768×1024, and 375×812 | No console/CSP errors, visible focus, responsive layout, meaningful landmarks and names | Full WCAG certification |
| Offline and compiled distribution | Runtime/package | Network trap, compiled CLI smoke, and packed-tarball exercise | No external request. The installed artifact serves and steers one run. | Remote hosting |
| Dependency direction and docs | Contract/documentation | Dependency-boundary tests, STE, roadmap/readme checks | Browser code remains infrastructure-facing and all status claims agree | ACP implementation |
| Release gates | Build/test | Full local CI sequence and hosted Linux x64 CI | Coverage, runtime, package, dependency audit, and repository quality gates pass | VM-grade isolation |

## Planned test surfaces

- Domain/application tests retain the existing presentation document, projector, session, and action
  controller as the authority baseline.
- Infrastructure tests exercise a real loopback HTTP server, request parser, authentication,
  headers, streaming, action dispatch, deadlines, and cleanup.
- CLI integration tests prove admission order, selection parity, fixed public output, and shared
  supervisor composition.

The browser and release gates provide these tests:

- A pinned Chromium gate exercises the compiled fixed page, keyboard interaction, and reload. It
  also checks responsive views, screenshots, accessibility structure, and the browser console.
- The complete release sequence remains the final gate. Narrow positive tests cannot replace the
  full evidence set. That set covers runtime, package, dependency, and coverage checks.

## Activity log

- 2026-08-16: PR #100 merged and Issue #99 closed after zero-finding review and green hosted gates.

- 2026-08-16: The roadmap, GitHub state, and current host architecture were reviewed.

- 2026-08-16: A2UI, ACP, AG-UI, MCP Apps, and browser transport alternatives were reviewed.

- 2026-08-16: The user approved the fixed local browser host with a single-user, same-UID-trusted
  deployment boundary.

- 2026-08-16: Issue #101 was created.

- 2026-08-16: Branch `codex/issue-101-local-browser-host` was created from `main`.

- 2026-08-16: The strict action protocol and one-shot loopback host were implemented. Fixed browser
  assets and `flow web` CLI composition followed with RED/GREEN tests.

- 2026-08-16: Pinned Chromium verified fragment removal, capability use, text-only rendering,
  reload, keyboard steering, denied storage, and the three responsive viewports.

- 2026-08-16: Compiled and packed CLI traces created a terminal run and opened `flow web`. They
  authenticated, received the final document, and settled the process and supervisor.

- 2026-08-16: README, security, architecture, capability sourcing, testing, and roadmap documents
  were updated. ACP remains a later editor transport seam.

- 2026-08-16: Final startup-order review moved actor admission before supervisor startup. The
  regression proves that an invalid actor creates no supervisor control state or browser host.

## Verification evidence

Implementation and portable verification are complete. Native hosted Linux x64 CI remains pending.

The mapped selector passed 111 tests in 11 files:

```sh
npx vitest run \
  test/unit/application/run-presentation-actions.test.ts \
  test/unit/presentation/browser-presentation-protocol.test.ts \
  test/unit/infrastructure/http/local-browser-presentation-assets.test.ts \
  test/unit/infrastructure/http/local-browser-presentation-host.test.ts \
  test/integration/cli/web.test.ts \
  test/unit/presentation/presentation-package-projector.test.ts \
  test/unit/capability/local-presentation-packages.test.ts \
  test/integration/package/dependency-boundaries.test.ts \
  test/integration/package/docs-ste.test.ts \
  test/integration/package/local-ci-sequence.test.ts \
  test/scaffold/community-files.test.ts
```

The real browser gate passed one test:

```sh
npm run test:browser
```

The complete default suite passed 3,689 tests and skipped 4 tests. It had 261 passing files and one
skipped file:

```sh
npm run test
```

The serial coverage suite passed the same 3,689 tests and 4 skips. Coverage was 83.79% statements,
77.96% branches, 90.18% functions, and 83.90% lines:

```sh
npm run test:coverage
```

The compiled runtime suite passed 40 tests and skipped 34 environment-gated tests. It had 8 passing
files and 10 skipped files:

```sh
npm run build
npm run test:runtime
node scripts/smoke-compiled.mjs
```

The packed-install verifier passed. It exercised the installed `flow web` binary and authenticated
terminal-document delivery:

```sh
npm run pack:check
```

The remaining portable gates passed:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run docs:ste
node scripts/check-docs-ste.mjs --file .decisions/issue-101.md
node scripts/audit-prime-dependencies.mjs
npm audit --omit=dev --audit-level=low
git diff --check
```

Lint reported one existing informational `noUselessConstructor` note outside Issue #101. The npm
production audit found zero vulnerabilities. The Prime dependency audit passed for the Node lock
and 60 Python packages.

`npm run ci:local` passed formatting, lint, type checking, and build. It then stopped at the explicit
`Prime OCI runtime preparation requires Linux on x64` boundary on macOS. The remaining portable
commands above passed independently. The native Prime, browser-install, and complete Linux x64 job
must pass in hosted CI before merge.
