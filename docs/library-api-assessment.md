# Library API assessment

This document assesses whether Flow should expose a supported JavaScript or TypeScript library API.
It began with the source prepared for `@synapti/flow-harness@0.1.0-alpha.4` and the package boundary
introduced in Issue #184. The evidence baseline now reflects current source during Issue #197.
The immutable alpha.4 release notes retain that release's historical counts.

## Decision

**No supported library API exists in the current release.** Keep the npm package CLI-only.

If measured consumer demand justifies a library, extract one separately versioned, read-only
workflow contract first. Keep workflow execution, supervision, credentials, package activation,
and recovery behind a Flow process boundary. Consider a separate typed client only after Flow has
one versioned automation protocol and complete lifecycle tests.

Don't export the current `dist` tree, `runWorkflow`, `JsonlRunStore`, `LocalSupervisorService`, or
CLI composition root. Their TypeScript exports support internal composition and tests. They aren't
public contracts.

This assessment is a design recommendation, not a package export or roadmap commitment. The
[compatibility policy](compatibility.md) is the current consumer contract.

## Evidence baseline

Run the reproducible source audit from a clean repository checkout:

```sh
npm run analyze:library-api
```

The audit uses the repository's pinned TypeScript compiler to inspect all production source files
and resolve static relative imports. Counts include top-level declarations marked `export` and
named re-exports. Reachability includes the entry module and follows static imports and re-exports.
It intentionally excludes dynamic imports. The declaration counts don't claim that every
declaration is independently callable.

| Observation | Result | Why it matters |
| --- | --- | --- |
| Production TypeScript files | 370 | A broad root export would expose most of the product, not a small SDK. |
| Exported top-level declarations | 3,369 | Export syntax currently marks internal seams, test seams, schemas, records, and adapters. |
| Domain declarations | 1,593 | Even the provider-neutral layer contains large workflow, event, evaluation, package, and adaptation contracts. |
| Application declarations | 549 | Use cases expose ports for stores, executors, approvals, artifacts, workspaces, and sessions. |
| Infrastructure declarations | 1,081 | These declarations can reach files, processes, networks, sandboxes, containers, credentials, and UI hosts. |
| Supervisor declarations | 122 | These declarations own queues, worker processes, control requests, and shutdown. |
| CLI declarations | 24 | The CLI composes 338 of 370 production modules and is the intentional product boundary. |
| Documented CLI forms | 93 | A future client can't safely wrap every form until their machine outputs and error categories are inventoried. |
| Direct JSON-to-standard-output sites | 97 | Machine-readable output exists, but many commands own distinct result shapes rather than one versioned automation protocol. |

Reachability shows that a candidate's apparent simplicity can hide a much larger change surface:

| Candidate entry | Reachable modules | Layer spread | Assessment |
| --- | ---: | --- | --- |
| Workflow compiler | 19 | Domain only | Best extraction candidate, but its compiled graph is still an internal representation. |
| Run-event parser and reducer | 70 | Domain only | Useful for inspection, but tightly coupled to durable evidence and recovery invariants. |
| Workflow runner | 77 | Application and domain | High authority through injected stores, executors, artifacts, workspaces, sessions, and approvals. |
| Local run store | 74 | Infrastructure, application, and domain | Owns filesystem identity, append durability, run ownership, and replay. |
| Supervisor service | 86 | All non-CLI layers | Owns worker lifecycle, queues, admission, process control, and durable records. |
| CLI composition root | 338 | All five layers | Correct executable boundary; unsuitable as an in-process API. |

The exact counts are a point-in-time audit. The conclusion doesn't depend on one count: the current
module tree crosses multiple authority and lifecycle boundaries and has no curated export surface.
The JSON-site count includes only direct `io.stdout(JSON.stringify(...))` calls in the CLI
composition root. It intentionally doesn't equate call sites with commands or stable schemas, and
it excludes indirect renderers, newline-delimited streaming, and files written through `--output`.
It is therefore a reproducible lower bound on implementation sites, not a public API inventory.

The existing machine-readable surface includes these contract families:

- Environment and compatibility reports.
- Workflow validation and public run projections.
- Run-event streaming.
- Package, capability, and activation records.
- Evaluation evidence and generated JSON files.

These families already give shell and CI consumers structured integration points. They don't yet
share one envelope, schema-version field, diagnostic registry, framing rule, or stability class.
A future client must inventory those contracts. It must not assume that every JSON result has the
same lifecycle or compatibility guarantee.

### Cross-check the packed consumer boundary

Source syntax isn't the consumer contract. The packed-package verifier independently installs the
exact archive in a clean consumer project and checks these outcomes:

| Consumer action | Alpha.4 result | Support state |
| --- | --- | --- |
| Run the installed `flow` binary | Succeeds on a supported host | Supported alpha entry point |
| Import `@synapti/flow-harness` | Fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` | Unsupported by design |
| Import `@synapti/flow-harness/dist/cli/main.js` | Fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` | Unsupported by design |
| Import an absolute file from the installed package | Node can bypass package-name encapsulation | Unsupported implementation access |

The package contains declaration maps because the executable and its internal modules need a
coherent build. Those files don't override the empty `exports` map. The release verifier also
requires the installed manifest to retain exactly one `flow` binary and an empty exports map.

The immutable alpha.3 archive provides a second check against source-tree confusion: it doesn't
contain Issue #184's compatibility command, corpus, or package-boundary verification. Alpha.4 must
use a new semantic version because later source can't be attributed retroactively to published
alpha.3 bytes.

### Check demand separately from technical feasibility

The workflow validator is technically extractable, but the demand gate isn't met. Repository
evidence for this checkpoint identifies zero independent consumers with a task that requires an
in-process API. The threshold is three. CLI inconvenience, internal test imports, and hypothetical
editor integrations don't count as independent demand.

This result doesn't prove that demand is absent. It means Flow lacks enough evidence to freeze a
second public package, diagnostic vocabulary, runtime matrix, and support policy. Record concrete
consumer tasks before changing the decision.

## Start from consumer flows

A library must solve a specific flow. “Import Flow” is too broad to define versioning, errors,
authority, cancellation, or cleanup.

### User flows

| Need | Minimum useful operation | Required result |
| --- | --- | --- |
| Validate authored YAML in an editor or generator | Validate bounded workflow bytes without filesystem or provider access | Stable diagnostics, API version, workflow ID, and a public summary |
| Inspect completed evidence in a reporting tool | Read bounded public run evidence without claiming ownership | A redacted public run projection with explicit incomplete or incompatible states |
| Start and monitor a run from another Node application | Submit exact inputs, follow events, cancel, and inspect terminal state | Versioned protocol messages, idempotent command identity, backpressure, and cleanup |
| Integrate Flow into CI | Invoke one exact release and parse documented output | Exit status, bounded JSON, provenance, and no hidden global state |

### Operator flows

| Need | Authority involved | Required safeguards |
| --- | --- | --- |
| Execute a workflow | Project files, commands, providers, budgets, policy, approvals, and durable records | Exact project root, explicit capabilities, cancellation, fail-closed sandboxing, and recovery |
| Control detached work | Supervisor socket, worker processes, queues, ownership, and shutdown | Same-user authentication, request identity, timeout, reconnect, and terminal settlement |
| Manage capability packages | HTTPS, OCI, TUF, Sigstore, credentials, content-addressed storage, and activation | Publisher policy, bounded acquisition, offline revalidation, atomic activation, and rollback |
| Run evaluations | Fresh workspaces, multiple runtimes, private result verification, and durable reports | Complete denominators, missingness, environment identity, cleanup, and no inferred qualification |

### System flows

| Need | Boundary | Required contract |
| --- | --- | --- |
| IDE integration | Interactive client to Flow presentation or validation | Capability negotiation, cancellation, progress, safe display text, and bounded diagnostics |
| Orchestrator integration | Automation to one Flow process | Version negotiation, idempotent requests, streaming events, structured errors, and reconnect rules |
| Hosted or multi-user service | Remote tenant to isolated execution | Authentication, authorization, tenancy, quotas, remote storage, and VM-grade isolation that Flow doesn't provide today |

The first two user needs are read-only and potentially library-shaped. Execution and operator needs
are process-shaped because they require one owner for resources and durable settlement.

## Assess candidate surfaces

### Workflow validation

The current compiler accepts text, parses YAML, validates graph rules, expands bounded constructs,
and returns `CompiledWorkflow`. It reaches only 19 domain modules, which makes it the strongest
extraction candidate.

The current return value isn't suitable as a public API. It exposes the complete internal executable
graph, nested child compilation, control metadata, provider settings, and evolving node unions. A
public validation API should return a smaller summary and stable diagnostic codes. It should not
promise the byte-for-byte shape of `CompiledWorkflow`.

A future contract could conceptually provide these operations:

```ts
validateWorkflow(source, options) -> ValidationResult<WorkflowSummary>
describeWorkflow(source, options) -> DescriptionResult<WorkflowDescription>
```

These names and types are illustrative. They aren't available imports.

The input must be UTF-8 bytes or text with a fixed byte limit. Options must select only explicit
schema and package-resolution behavior. A caller-supplied package resolver needs its own bounds,
identity, cancellation, and error contract.

### Run inspection

The current reducer is deterministic and valuable, but it reaches 70 domain modules. Run events
cover graphs, approvals, budgets, capabilities, artifacts, model sessions, semantic queries,
delegation, proof evidence, and recovery.

Don't expose `RunEvent`, `RunState`, `parseRunEvent`, or `reduceRunEvents` as the first public API.
Their primary owner is Flow persistence. A future inspection API should accept bounded bytes and
return the same redacted projection used by public CLI commands. It must preserve unknown-version,
partial-ledger, torn-tail, and incompatible-event outcomes instead of throwing arbitrary schema
messages.

### Workflow execution

`runWorkflow` looks like one function but accepts a high-authority dependency bundle. Its options
include a current working directory, protected paths, a run store, a node executor, optional
workspace isolation, approvals, and artifact storage. They also include model-session storage, work
profiles, a clock, and an `AbortSignal`.

This is an application service seam, not a safe consumer facade. A caller can substitute components
that violate Flow's package admission, sandbox, durability, cleanup, or public-output rules. An
export would transfer Flow authority to the embedding process. Otherwise, Flow must validate every
custom implementation as if it were an external protocol.

Keep execution behind the `flow` process. A future client should submit declarative inputs and
receive public events. It shouldn't inject executors or stores.

### Supervision and package governance

The supervisor owns worker launch, admission records, queues, command identity, socket transport,
and shutdown. Package governance owns network acquisition, publisher authentication, credentials,
content-addressed storage, candidate review, activation, replacement, and pruning.

Both surfaces need one process owner and durable recovery rules. In-process callbacks would make
resource ownership and post-crash settlement ambiguous. Keep them out of a read-only library.

## Compare architectural approaches

Scores use 1 for poor and 5 for strong. The weighted total is a decision aid, not measured product
quality.

| Criterion | Weight | Full in-process export | Curated export in the CLI package | Separate read-only contract | Process-isolated client | Use ACP as the general API |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Authority containment | 25% | 1 | 4 | 5 | 5 | 3 |
| Change isolation | 20% | 1 | 3 | 5 | 5 | 4 |
| Consumer usability | 15% | 5 | 4 | 4 | 4 | 3 |
| Lifecycle clarity | 15% | 1 | 4 | 5 | 4 | 3 |
| Type safety | 10% | 5 | 5 | 5 | 4 | 3 |
| In-process performance | 5% | 5 | 5 | 5 | 2 | 3 |
| Delivery effort | 10% | 4 | 3 | 2 | 2 | 2 |
| **Weighted total** | **100%** | **2.50** | **3.85** | **4.55** | **4.15** | **3.10** |

### Approach 1: Export the current module tree

This approach adds a root export or subpath patterns over `dist`.

Benefits:

- Fastest route to imports.
- Full TypeScript types.
- No child-process startup cost.

Costs and failure modes:

- Turns thousands of internal declarations into an accidental public API.
- Couples consumers to file layout, transitive dependencies, Zod schemas, internal errors, and
  compiled graph shape.
- Lets callers bypass production composition and inject unsafe stores or executors.
- Makes normal internal refactoring a consumer-breaking change.
- Leaves process, timer, socket, session, container, and ownership cleanup with the embedding app.

Decision: reject.

### Approach 2: Export a curated read-only surface from the same package

This approach adds exact subpaths, such as one workflow validator, while retaining the executable.

Benefits:

- Good discoverability for current npm users.
- Can expose a small typed API.
- Avoids a second installation for simple validation.

Costs and failure modes:

- Couples the library release cadence and dependency tree to the full CLI product.
- Keeps browser, bundler, ESM, Node, and declaration compatibility inside one package contract.
- Makes `0.1.0-alpha.x` carry two public surfaces with different maturity and support needs.
- Encourages later execution exports because the package already appears to be an SDK.

Decision: defer. This is acceptable only for a deliberately small surface after its evidence gates
pass, but a separate package provides clearer ownership.

### Approach 3: Extract a separate read-only contract package

This approach creates a package with no filesystem, process, network, provider, credential,
supervisor, or package-activation authority.

Benefits:

- Clearest authority and dependency boundary.
- Independent semantic versioning and support policy.
- Smallest feasible browser, editor, generator, and CI surface.
- Differential tests can compare it with the production CLI compiler.

Costs and failure modes:

- Requires an explicit public summary rather than exporting current internal types.
- Package-resolution callbacks can reintroduce I/O unless excluded or tightly specified.
- Run inspection would still pull a large persistence contract and should be a later surface.
- A new package adds release, provenance, documentation, and support work.

Decision: recommended first library direction after demand and contract evidence exist. Start with
workflow validation only. Treat the provisional package name and function names as undecided.

### Approach 4: Add a process-isolated typed client

This approach provides a small library that starts or connects to an exact Flow process and speaks
a versioned protocol.

Benefits:

- Preserves Flow's production composition and authority checks.
- One process owns signals, child processes, stores, sockets, containers, and cleanup.
- Supports Node, other languages, CI, IDEs, and remote evolution through the same protocol model.
- Allows reconnect and durable command identity without sharing in-memory objects.

Costs and failure modes:

- The current 93 CLI forms don't share one machine protocol.
- Process startup and serialization add latency.
- The client must handle version negotiation, stdout framing, stderr privacy, backpressure,
  cancellation, timeouts, process death, reconnect, and terminal settlement.
- A remote transport would add authentication and tenancy that local Flow doesn't support.

Decision: recommended for execution and control only after a dedicated protocol is designed and
tested. Don't implement it as a wrapper that screen-scrapes help text or diagnostic prose.

### Approach 5: use ACP as the general Flow API

The [Agent Client Protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
defines JSON-RPC methods and notifications between an agent and a client. Its standard flow includes
initialization, authentication when needed, session creation or loading, prompts, streamed session
updates, permission or file requests, and cancellation.

ACP is relevant to Flow in two existing roles:

- `flow acp` lets a compatible client observe and control a bounded Flow presentation.
- An operator can select a prompt-only local ACP agent as one Flow executor.

ACP also offers useful design precedents for capability negotiation, cancellation, progress, and
content blocks. The official architecture describes ACP as a client-to-agent interface and assumes
a trusted editor and agent relationship.

It doesn't define Flow's workflow compilation, durable event replay, policy decisions, package
governance, evaluation records, supervisor ownership, or compatibility corpus. Encoding those as
private ACP extensions would create a Flow-specific protocol while implying broader standard
interoperability.

Decision: don't use ACP as the general library or automation API. Reuse standard ACP behavior at
the existing editor and agent boundaries. A future Flow process protocol can borrow proven patterns
without claiming that Flow-specific run control is standard ACP.

## Define the future contract before code

### Read-only workflow package

A proposal must define all of these fields:

- One package name, supported runtime matrix, ESM policy, and exact exports map.
- Maximum input bytes, YAML aliases, depth, nodes, child depth, diagnostics, and package references.
- A public summary that omits internal scheduler and adapter representation.
- Stable diagnostic codes with bounded, source-safe messages and source locations.
- Whether input is text, bytes, streams, or all three.
- `AbortSignal` behavior for any asynchronous resolver.
- No ambient filesystem, environment, credentials, network, provider, or global mutable state.
- Version ownership for the npm package, workflow `apiVersion`, diagnostics, and summaries.

Don't expose Zod schemas as the sole contract. Consumers need documented data types and runtime
validation, but a schema library upgrade must not become an API break by accident.

### Process client

A process client proposal must define:

- Protocol initialization, exact version negotiation, feature negotiation, and refusal rules.
- Request IDs, idempotency, retries, duplicate requests, and reconnect behavior.
- Length-prefixed or newline framing, message byte limits, queue limits, and backpressure.
- Public event projections, ordering, pagination, follow behavior, and terminal states.
- Typed error codes separated from bounded human remediation.
- `AbortSignal`, deadline, cancel acknowledgement, process signals, and cleanup confirmation.
- Child-process ownership, inherited environment, current directory, credentials, and log privacy.
- Local socket authentication and a separate future design for remote authentication and tenancy.
- Exact binary discovery, version pinning, provenance, and compatibility checking.

A thin client must never silently install a different Flow version or fall back to a global binary.
It also must not parse private ledger files when the process protocol fails.

## Require evidence before export

Don't add a library export until one proposal passes every applicable gate.

### Demand gate

- Document at least three independent consumers and their exact tasks.
- Show why `flow <command>` with bounded JSON is insufficient for each task.
- Separate editor-time validation from execution and control needs.

### Contract gate

- Approve user, operator, and system flows, non-goals, failure modes, and authority boundaries.
- Publish a complete versioning, deprecation, migration, and rollback policy.
- Freeze exact public types, diagnostics, resource limits, and package exports.
- Prove that examples use only packed-package imports.

### Verification gate

- Run differential tests between the extracted validator and the production CLI compiler.
- Run the cross-release corpus through both supported public surfaces.
- Test malformed, duplicate-key, oversized, unsupported, cancelled, and identity-mismatched input.
- Test Node ESM resolution from a clean packed install and reject every undeclared subpath.
- Test declaration output with at least two independent consumer projects.
- Measure package size, import time, validation latency, and peak memory on the supported matrix.
- Fuzz the bounded parser and hold out adversarial cases from implementation authors.

### Lifecycle gate

- Prove cancellation before and during each asynchronous boundary.
- Prove every file handle, timer, socket, session, subprocess, and container settles on success,
  failure, timeout, cancellation, and caller abandonment.
- Prove no provider-owned handle keeps a consumer process alive.
- Prove repeated calls don't share mutable authority or credentials.

### Release gate

- Build once and verify the same archive on supported Linux x64 and macOS x64 hosts.
- Generate provenance and immutable release notes for the library artifact.
- Test upgrades and rollbacks against at least one prior supported release.
- Keep the CLI package's empty exports map until a separate proposal explicitly changes it.

## Recommendation and next decision

Use the CLI and its documented machine output for the current usable alpha. Keep
`@synapti/flow-harness` process-owned and CLI-only.

When real consumers request in-process validation, propose a separate read-only workflow package.
Keep its output smaller than `CompiledWorkflow`, prohibit ambient authority, and require
differential compatibility evidence.

When consumers need execution or long-running control, first design a versioned Flow process
protocol. Then consider a typed client that preserves binary identity and lifecycle ownership. ACP
remains relevant at Flow's editor and agent boundaries, not as a shortcut around that protocol
design.

This sequence delivers a usable product now and keeps a standards-based path open without freezing
Flow's internal architecture as a public API.
