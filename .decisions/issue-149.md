# Decision journal: Issue #149

**Issue:** #149
**Branch:** `codex/issue-149-semantic-code-queries`
**Started:** 2026-08-21

## Status

Implementation and local verification are complete. The user approved Approach B: bounded
semantic code context with diagnostics and navigation through a standard language-service
boundary. Hosted Linux x64 CI must still run the platform-specific containment test before merge.

## Context

Gate 9.3 requires read-only diagnostics, definitions, references, and hover or type information.
Flow must keep each result bounded, replayable, and advisory. A language-service response cannot
grant authority or prove workflow completion.

The current LSP specification is 3.18. Flow will implement a closed compatible subset rather than
an editor client. The subset includes initialization, text-document synchronization, and pull
diagnostics. It also includes definitions, references, hover, cancellation, and shutdown. Flow
returns only the minimum safe responses to server requests.

Primary references:

- [LSP overview](https://microsoft.github.io/language-server-protocol/)

- [LSP 3.18 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)

- [Microsoft LSP packages](https://github.com/microsoft/vscode-languageserver-node)

## Selected architecture

Flow adds one built-in `semantic` agent capability. The capability exposes one tool with a closed
operation field. The operations are `diagnostics`, `definition`, `references`, and `hover`.

The operator selects one bounded manifest before a new run. Flow reopens and validates the
manifest and executable. It stores an immutable language-server snapshot in the existing run
capability snapshot. This identity therefore crosses foreground, detached, resume, recovery, and
event replay through the existing capability path.

The production adapter starts one short-lived LSP session for one semantic request. It uses the
selected Flow containment profile, denies network access, and gives the server a read-only project
projection from an admitted source snapshot. Reserved state, dependency, generated-output, and Flow
workspace collection names are omitted at every directory depth. The adapter rechecks the source
before it publishes evidence and closes the session after one operation. Flow does not keep an
ambient language-server daemon.

Flow normalizes every response into a provider-neutral schema. It sorts unordered locations and
diagnostics by portable path and range. It rejects locations outside the admitted project. It
records a bounded semantic receipt in terminal agent evidence. The public run view retains only
safe operation, count, digest, and identity fields.

## Specification

_Captured on 2026-08-21. Source: the approved Approach B contract, Issue #149, the roadmap, current
repository contracts, and primary-source LSP research._

### Non-goals

- Flow does not support completion, rename, formatting, code actions, or workspace symbols.
  Debugger requests, custom commands, and dynamic registration are also out of scope.

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

- **Invalid input:** Flow rejects invalid paths, positions, manifests, and executable identities.
  It also rejects invalid protocol messages, response shapes, locations, and limits. Errors remain
  fixed and value-free.

- **Missing context:** A workflow that selects semantic access requires one exact language-server
  snapshot. A workflow that does not select semantic access rejects an unexpected snapshot.

- **Cancellation:** Flow preserves the exact caller reason before server launch. After launch, Flow
  uses an independent cleanup signal. It restores the caller reason only after confirmed
  settlement.

### Interface contracts

- The workflow agent tool name is `semantic`. It adds no policy action that can mutate files,
  execute model-selected commands, or advance control flow.

- The model tool is `flow_semantic`. Its input contains one operation and one portable project path.
  Some operations also require a zero-based line and character.

- The operator language-server manifest uses `flow.synapti.ai/v1alpha1`. It binds the server name
  and protocol. It also binds the executable, SHA-256, fixed arguments, and language mappings. The
  remaining fields bind initialization, containment, and timeout settings.

- The immutable snapshot binds the canonical manifest bytes and digest. It also binds the reopened
  executable identity and normalized definition. The existing capability digest includes this
  snapshot.

- A normalized response contains portable project paths, zero-based ranges, and fixed severity.
  It also contains bounded codes, messages, and hover text. Every list has deterministic order.

- Each semantic receipt binds the operation, request digest, and source workspace snapshot. It also
  binds the file and server digests. Containment evidence and normalized result digests complete
  the receipt.

## Failure contract

Public errors use fixed categories only:

- `semantic_service_unavailable`
- `semantic_operation_unsupported`
- `semantic_request_invalid`
- `semantic_source_changed`
- `semantic_protocol_failed`
- `semantic_deadline_exceeded`
- `semantic_response_limit_exceeded`
- `semantic_cleanup_uncertain`

Caller cancellation preserves the exact reason inside the semantic adapter. After confirmed
settlement, the enclosing agent boundary reports the fixed `pi_agent_aborted` code. Cleanup
uncertainty takes precedence over cancellation and deadline results.

No public error includes a raw server error, stderr, absolute path, source text, configuration
value, or nested cause.

## Verification map

| Criterion | Type | Command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Explicit operations and workflow selection | Behavioral and contract | `npx vitest run test/unit/semantic/semantic-code.test.ts test/unit/workflow/compiler.test.ts test/unit/infrastructure/pi/workspace-semantic-tools.test.ts` | The selected operation matrix passes, and undeclared semantic use fails. | Other LSP operations |
| Exact operator identity before mutation | Behavioral and data | `npx vitest run test/unit/capability/language-server.test.ts test/integration/cli/semantic-code.test.ts -t "language server"` | Missing, changed, unsafe, and unexpected identities fail before store or provider calls. | Automatic discovery |
| Containment and read-only project | Runtime and configuration | `npx vitest run test/runtime/semantic-lsp.runtime.test.ts` | A real fake server can read the project but cannot write it or use the network. | Hostile multi-tenant isolation |
| Bounds, deadline, and cancellation | Error and performance | `npx vitest run test/unit/infrastructure/lsp/strict-lsp-client.test.ts test/unit/infrastructure/lsp/local-semantic-code-service.test.ts` | Exact bounds pass, plus-one cases fail, cancellation identity is preserved, and cleanup runs. | Unlimited indexing |
| Deterministic normalization | Data processing | `npx vitest run test/unit/semantic/semantic-code.test.ts -t "normalize|sort|reject"` | All four response families normalize, sort, and reject foreign or malformed data. | Semantic correctness of the server |
| Durable provenance and private public view | Data and security | `npx vitest run test/unit/run/semantic-reducer.test.ts test/unit/cli/public-output.test.ts` | Receipt mutations fail replay and private content is absent from public projections. | Hiding operator-approved portable locations from internal evidence |
| Foreground, detached, resume, and replay identity | Integration | `npx vitest run test/integration/cli/semantic-code.test.ts test/integration/supervisor/worker.test.ts -t "semantic|language server"` | The exact capability identity crosses each lifecycle and committed results do not re-run. | Resuming an interrupted provider stream |
| Fixed private-safe failures | Error handling | `npx vitest run test/unit/infrastructure/lsp/strict-lsp-client.test.ts test/unit/infrastructure/lsp/local-semantic-code-service.test.ts test/integration/cli/semantic-code.test.ts` | Every fixed category is exact and private canaries are absent from recursive errors and output. | Operator-private internal logs outside public output |
| Documentation and architecture | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/documentation-structure.test.ts test/integration/package/architecture-documentation.test.ts` | All documentation gates pass and the canonical guide is linked from the concise README. | A stable workflow-format promise |

## Evidence completeness template

Final evidence for every criterion must state untested environments, known evidence limitations,
and the exact negative or adversarial cases covered. Unit fakes cannot substitute for the runtime
process and containment test. The runtime fake server proves protocol and boundary behavior, not
the semantic quality of a production language server.

## Verification evidence

Recorded on 2026-08-21 against commit `9ceaf60` plus this journal update.

- `npm test -- --maxWorkers=1`: 351 test files passed and one platform-gated file skipped. All
  4,802 executed tests passed. Four tests skipped.

- The complete mapped Issue #149 selector passed 195 tests across 12 executed files. It covered the
  domain, compiler, operator admission, strict protocol client, local service, Pi tool and evidence,
  reducer, and public output. It also covered the CLI, supervisor worker, and platform-permitted
  runtime boundaries.

- The merged four-shard V8 coverage run passed the same 4,802 tests and four skips. Coverage was
  84.93% statements, 79.56% branches, 91.57% functions, and 85.08% lines. Each shard ran
  sequentially with one worker and wrote a Vitest blob report. `vitest --merge-reports --coverage`
  combined the reports and applied the repository thresholds to the complete map.

- `npm run test:runtime`: nine runtime files and 44 tests passed on macOS. Eleven files and 35 tests
  skipped through explicit platform gates. The Linux x64 semantic-containment test remains a hosted
  CI requirement.

- `npm run pack:check`: a clean consumer installed and ran
  `synaptiai-flow-harness-0.1.0-alpha.1.tgz`. The package SHA-256 was
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

- `npm run build`, `npm run typecheck`, `npm run format:check`, the scoped lint gate,
  `npm run docs:style`, `npm run docs:links`, `npm run docs:ste`, and `git diff --check` passed.
  Lint reported one inherited informational constructor notice outside this change and no failure.

The first local runtime attempt overlapped `pack:check`. Both commands own the generated `dist`
directory, so the package check removed compiled files while the runtime process was using them.
The isolated sequence of build, runtime test, and package check passed. This procedural race is not
product evidence and is excluded from the acceptance result.

The first final coverage attempt used the canonical monolithic command. The host operating system
terminated that process with exit 137 before it produced a report. The machine has a known low-memory
history. The official Vitest blob-sharding and merge workflow completed the same test inventory and
coverage map with lower peak memory. The terminated process is an environment event and is excluded
from product evidence.
