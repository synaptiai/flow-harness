# Decision journal: Issue #149

**Issue:** #149  
**Branch:** `codex/issue-149-semantic-code-queries`  
**Started:** 2026-08-21

## Status

Implementation is in progress. The user approved Approach B: bounded semantic code context with
diagnostics and navigation through a standard language-service boundary.

## Context

Gate 9.3 requires read-only diagnostics, definitions, references, and hover or type information.
Flow must keep each result bounded, replayable, and advisory. A language-service response cannot
grant authority or prove workflow completion.

The current LSP specification is 3.18. Flow will implement a closed compatible subset rather than
an editor client. The selected subset contains initialization, text-document synchronization,
pull diagnostics, definitions, references, hover, cancellation, shutdown, and the minimum safe
responses to server requests.

Primary references:

- Language Server Protocol overview and current specification:
  <https://microsoft.github.io/language-server-protocol/>
- LSP 3.18 specification:
  <https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/>
- Microsoft language-server implementation and protocol packages:
  <https://github.com/microsoft/vscode-languageserver-node>

## Selected architecture

Flow adds one built-in `semantic` agent capability. The capability exposes one tool with a closed
operation field. The operations are `diagnostics`, `definition`, `references`, and `hover`.

The operator selects one bounded manifest before a new run. Flow reopens and validates the
manifest and executable. It stores an immutable language-server snapshot in the existing run
capability snapshot. This identity therefore crosses foreground, detached, resume, recovery, and
event replay through the existing capability path.

The production adapter starts one short-lived LSP session for one semantic request. It uses the
selected Flow containment profile, denies network access, and gives the server read-only access to
the authoritative workspace. It sends one exact file snapshot and closes the session after one
operation. Flow does not keep an ambient language-server daemon.

Flow normalizes every response into a provider-neutral schema. It sorts unordered locations and
diagnostics by portable path and range. It rejects locations outside the admitted project. It
records a bounded semantic receipt in terminal agent evidence. The public run view retains only
safe operation, count, digest, and identity fields.

## Specification

_Captured on 2026-08-21. Source: the approved Approach B contract, Issue #149, the roadmap, current
repository contracts, and primary-source LSP research._

### Non-goals

- Flow does not support completion, rename, formatting, code actions, workspace symbols, debugger
  requests, custom server commands, or dynamic tool registration in this issue.
- Flow does not discover a language server from `PATH`, an editor, project metadata, or ambient
  extensions.
- Flow does not accept server edits, commands, telemetry, UI prompts, or network access.
- Flow does not make a semantic result authoritative goal, policy, approval, verification, or
  completion evidence.
- Flow does not retain an unbounded server process or retry an uncertain request.

### Failure modes

- **Timeouts:** Flow cancels the request, terminates the server process tree, settles containment,
  and returns a fixed deadline failure. An unconfirmed termination or cleanup returns a fixed
  uncertain-cleanup failure.
- **Partial failures:** Flow does not publish a semantic receipt until the complete response and
  shutdown settlement pass. A committed terminal receipt is replayed without a new request.
- **Invalid input:** Flow rejects invalid paths, positions, manifests, executable identities,
  protocol messages, response shapes, out-of-project locations, and limit violations with fixed
  value-free errors.
- **Missing context:** A workflow that selects semantic access requires one exact language-server
  snapshot. A workflow that does not select semantic access rejects an unexpected snapshot.
- **Cancellation:** Flow preserves the exact caller reason before server launch. After launch, it
  performs cleanup with an independent signal and restores the caller reason only after confirmed
  settlement.

### Interface contracts

- The workflow agent tool name is `semantic`. It adds no policy action that can mutate files,
  execute model-selected commands, or advance control flow.
- The model tool is `flow_semantic`. Its input contains one operation, one portable project path,
  and a zero-based line and character when the operation requires a position.
- The operator language-server manifest uses `flow.synapti.ai/v1alpha1`. It binds the server name,
  protocol, absolute executable, executable SHA-256, fixed arguments, language identifiers and
  file suffixes, initialization configuration, containment profile, and fixed request timeout.
- The immutable snapshot binds the canonical manifest bytes and digest, the reopened executable
  identity, and the normalized definition. The snapshot is part of the existing capability digest.
- A normalized response contains only portable project paths, zero-based ranges, fixed severity,
  bounded codes and messages, and bounded hover text. Every list has deterministic order.
- Each semantic receipt binds the operation, request digest, source workspace snapshot, exact file
  digest, language-server snapshot digest, containment evidence, normalized result, and result
  digest.

## Failure contract

Public errors use fixed categories only:

- `semantic_service_unavailable`
- `semantic_operation_unsupported`
- `semantic_request_invalid`
- `semantic_source_changed`
- `semantic_protocol_failed`
- `semantic_deadline_exceeded`
- `semantic_response_limit_exceeded`
- `semantic_request_cancelled`
- `semantic_cleanup_uncertain`

No public error includes a raw server error, stderr, absolute path, source text, configuration
value, or nested cause.

## Verification map

| Criterion | Type | Command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Explicit operations and workflow selection | Behavioral and contract | `npx vitest run test/unit/semantic/semantic-code.test.ts test/unit/workflow/compiler.test.ts test/unit/infrastructure/pi/workspace-semantic-tools.test.ts` | The selected operation matrix passes, and undeclared semantic use fails. | Other LSP operations |
| Exact operator identity before mutation | Behavioral and data | `npx vitest run test/unit/capability/language-server.test.ts test/integration/cli/semantic-code.test.ts -t "language server"` | Missing, changed, unsafe, and unexpected identities fail before store or provider calls. | Automatic discovery |
| Containment and read-only project | Runtime and configuration | `npx vitest run test/runtime/semantic-lsp.runtime.test.ts` | A real fake server can read the project but cannot write it or use the network. | Hostile multi-tenant isolation |
| Bounds, deadline, and cancellation | Error and performance | `npx vitest run test/unit/infrastructure/lsp/strict-lsp-client.test.ts -t "limit|deadline|cancel"` | Exact bounds pass, plus-one cases fail, cancellation identity is preserved, and cleanup runs. | Unlimited indexing |
| Deterministic normalization | Data processing | `npx vitest run test/unit/semantic/semantic-code.test.ts -t "normalize|sort|reject"` | All four response families normalize, sort, and reject foreign or malformed data. | Semantic correctness of the server |
| Durable provenance and private public view | Data and security | `npx vitest run test/unit/run/semantic-reducer.test.ts test/unit/cli/public-output.test.ts` | Receipt mutations fail replay and private content is absent from public projections. | Hiding operator-approved portable locations from internal evidence |
| Foreground, detached, resume, and replay identity | Integration | `npx vitest run test/integration/cli/semantic-code.test.ts test/integration/supervisor/worker.test.ts -t "semantic"` | The exact capability identity crosses each lifecycle and committed results do not re-run. | Resuming an interrupted provider stream |
| Fixed private-safe failures | Error handling | `npx vitest run test/unit/infrastructure/lsp/strict-lsp-client.test.ts test/integration/cli/semantic-code.test.ts -t "private|failure"` | Every fixed category is exact and private canaries are absent from recursive errors and output. | Operator-private internal logs outside public output |
| Documentation and architecture | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste && npm run docs:architecture && npm run docs:roadmap` | All documentation gates pass and the canonical guide is linked from the concise README. | A stable workflow-format promise |

## Evidence completeness template

Final evidence for every criterion must state untested environments, known evidence limitations,
and the exact negative or adversarial cases covered. Unit fakes cannot substitute for the runtime
process and containment test. The runtime fake server proves protocol and boundary behavior, not
the semantic quality of a production language server.
