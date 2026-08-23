# Decision Journal: Issue #165 — Bind exact ACP executor identity and complete usage evidence

**Issue**: #165 | **Branch**: `codex/issue-165-acp-executor-identity` | **Started**:
2026-08-23

---

## Context

Gate 10 adds local Agent Client Protocol (ACP) executors behind the existing Flow-owned
`AgentExecutor` boundary. The workflow must remain the durable statement of requested work. The
operator-selected executor is a run capability, so changing the executor must change the capability
snapshot digest without changing the workflow digest.

ACP v1 can report cumulative context use and optional cost. Its detailed prompt-token structure is
optional and unstable. Flow's current evidence shape requires complete input, output, cache-read,
cache-write, and cost values. Reusing that shape for incomplete ACP observations would force an
unknown value to appear as zero or make every ACP result invalid. This slice establishes exact
runtime identity and truthful accounting before any production ACP process can run.

## Flows

### Operator flow

1. The operator selects an exact local ACP manifest when validating or starting a later ACP run.
2. Flow reads the manifest and its local executable or package closure through bounded, no-follow
   reads.
3. Flow records a canonical runtime snapshot in the existing capability snapshot.
4. Validation reports incompatibility before execution if identity or required accounting is
   unavailable.

### Recovery flow

1. Flow replays the durable `run_started` capability snapshot.
2. The operator supplies the current local selection when the command requires one.
3. Flow proves that the current runtime closure matches the durable identity.
4. A missing, changed, or conflicting identity fails before an executor is called.

### System flow

1. Capability snapshots combine at admission.
2. The combination permits at most one ACP executor identity.
3. The capability digest includes the ACP identity digest.
4. Run events, detached supervisor records, and child-run propagation preserve the same validated
   snapshot through their existing interfaces.

## Architecture alternatives

Scores are ordinal design judgments from one to five, not runtime measurements.

| Approach | Workflow invariance | Recovery fit | Comparison validity | Change surface | Selected |
| --- | ---: | ---: | ---: | ---: | --- |
| A. Store the exact executor profile in each workflow node | 1 | 4 | 2 | 2 | No |
| B. Store a logical executor protocol in the workflow and the exact profile at run admission | 3 | 5 | 4 | 3 | No |
| C. Store the complete executor selection only in the immutable run capability snapshot | 5 | 5 | 5 | 4 | Yes |

### Refined Approach C decision

The user approved snapshot-only executor selection. The workflow schema and compiled workflow do
not gain an executor field. A later CLI selection creates one exact ACP runtime snapshot and combines
it with the run's other capabilities. Production executor composition can then route from the
node-execution context without changing the `AgentExecutor` port or verifier projection.

The snapshot is a strict, bounded, secret-free projection of a manifest plus observed runtime
artifacts. It identifies the ACP major version, compatibility profile, and launch kind. It also
identifies the exact artifact or package closure and the Node runtime when applicable. The snapshot
binds the non-secret configuration contract, model mappings, provider authority, containment, and
usage support. It records no credential value.

Accounting uses an explicit completeness contract. A usage observation can report available token
and cost dimensions without inventing the missing ones. A workflow budget is admissible only when
the selected runtime promises and later supplies the corresponding complete dimension. Ordinary Pi
evidence remains byte-compatible and retains its existing complete usage projection.

## Coupling analysis

#### Admission and composition

- The domain capability module owns canonical snapshot validation and digesting. It does not import
  filesystem, ACP SDK, process, sandbox, or CLI modules.
- Infrastructure owns bounded manifest and artifact observation. It returns domain inputs and
  revalidates the observed identity immediately before future launch.
- The application admission boundary combines executor identity with existing capabilities and
  checks workflow-budget compatibility. It does not construct a process.

#### Durability and evidence

- The supervisor serializes the complete capability snapshot, so the strict extension propagates
  identity without a second authority channel.
- ACP identity reuses the existing replay comparison between durable and supplied capability
  digests.
- Provider-neutral evidence owns usage completeness without adding ACP wire metadata to durable
  events.
- Domain modules remain independent of infrastructure, and no mutable global registry is added.

## Specification

_Captured by specification-capture skill on 2026-08-23. Source: user-confirmed._

### Non-goals

#### Execution and authority

- Do not start an ACP subprocess or expose a public ACP executor command in this slice.
- Do not add executor selection to workflow YAML or compiled workflow digests.
- Do not grant filesystem, terminal, MCP, elicitation, extension, network, or credential authority.
- Do not implement ACP v2, HTTP transport, session load, session resume, or multi-agent selection.

#### Compatibility and documentation

- Do not treat ACP as a capability-package ABI, executable plugin system, or durable event model.
- Do not calculate provider cost from mutable public pricing or infer missing usage fields.
- Do not change existing Pi execution, model selection, workflow fixtures, or complete Pi usage
  semantics.
- Do not copy detailed executor guidance into the root README.

### Failure modes

#### Input and settlement failures

- **Timeouts** — manifest and local artifact admission performs bounded local reads and has no
  network or subprocess timeout. A file that changes during observation fails admission. Future
  process timeouts remain out of scope for this slice.
- **Partial failures** — Flow returns no snapshot until all identity fields validate. Validation
  covers the manifest, runtime artifacts, package closure, semantics, and final digest. Snapshot
  combination is atomic and rejects conflicts.

#### Invalid and missing input

- **Invalid input** — Unknown fields, unsupported versions, relative paths, controls, excessive
  arguments, or duplicate mappings fail. Invalid domains, secret values, malformed base64, digest
  mismatches, or noncanonical ordering also fail. Diagnostics remain bounded and generic.
- **Missing context** — a missing manifest, executable, dependency, Node runtime, model mapping, or
  required usage dimension fails before executor construction. The implementation does not search
  ambient PATH, registries, home configuration, or package managers for a fallback.

#### Dependencies and resource bounds

- **Dependency outage** — None. Admission is offline and does not contact an ACP agent, package
  registry, model provider, or trust service.
- **Resource exhaustion** — manifests, arrays, strings, artifacts, package counts, tree entries,
  serialized snapshots, and diagnostic lengths have fixed ceilings. Exceeding a ceiling fails
  closed without retaining partial identity.

### Interface contracts

#### Manifest and launch

- An ACP manifest has one Flow API, one `AcpAgent` kind, one name, ACP v1, and one compatibility
  profile. It declares one exact launch, a bounded model map, containment, a credential variable
  contract, and usage support.
- Launch identity supports a self-contained executable or a trusted Node package closure. Both bind
  content hashes, byte counts, canonical absolute paths, and stable file observations. Node launch
  also binds the exact Node executable and version.

#### Stored identity

- The persisted snapshot embeds manifest bytes, provenance, the normalized non-secret contract,
  observed artifacts, and one canonical digest. Validation reconstructs the snapshot from those
  bytes and rejects semantic drift.

#### Composition

- A capability snapshot holds at most one ACP runtime. Its digest includes only the runtime digest.
  Redundant host fields and secrets stay outside the digest. Identical identities combine
  idempotently. Different identities fail.

#### Recovery and usage

- Recovery compares the complete capability digest already recorded by `run_started`. A changed
  executor identity is a workflow-mismatch-class recovery failure before executor invocation.
- Provider-neutral model usage distinguishes dimension availability from measured numeric values.
  A budgeted dimension requires complete evidence. No absent dimension contributes a synthetic
  zero to a completion claim.
- Existing complete Pi usage remains valid under the extended schema and contributes the same token
  and cost totals as before.

#### Errors

- Errors exposed outside the infrastructure boundary are fixed, bounded, and secret-free. They do
  not include manifest contents, credential values, rejected arguments, host paths, or raw operating
  system messages.

## Criterion verification map

### Criterion 1: Stable exact identity

- **Type**: Contract and data processing.
- **Command**: `npm test -- test/unit/domain/capability/acp-agent.test.ts test/unit/infrastructure/fs/local-acp-agent.test.ts`.
- **Expected evidence**: Repeated admission of unchanged binary and Node-package fixtures returns
  byte-identical snapshots and digests.
- **Does not promise**: download, installation, registry discovery, or remote attestation.

### Criterion 2: Hostile artifact rejection

- **Type**: Error handling and security boundary.
- **Command**: `npm test -- test/unit/infrastructure/fs/local-acp-agent.test.ts`.
- **Expected evidence**: Missing or hostile artifacts fail before descriptor creation. Cases include
  links, special files, oversized content, closure drift, races, replacement, and digest mismatch.
- **Does not promise**: protection from a hostile kernel or privileged host administrator.

### Criterion 3: Attached, detached, and recovery identity

- **Type**: Behavioral and serialization contract.
- **Command**: `npm test -- test/integration/cli/acp-agent-admission.test.ts test/unit/supervisor/protocol.test.ts test/integration/supervisor/worker.test.ts test/unit/application/run-workflow-capabilities.test.ts`.
- **Expected evidence**: The same snapshot crosses each boundary. A missing or changed digest refuses
  recovery before the test executor observes a call.
- **Does not promise**: starting the production ACP process in this slice.

### Criterion 4: Truthful usage completeness

- **Type**: Schema, replay, and accounting behavior.
- **Command**: `npm test -- test/unit/run/budget.test.ts test/unit/run/reducer.test.ts test/unit/cli/public-output.test.ts`.
- **Expected evidence**: Complete Pi usage accounts identically. Partial observations retain unknown
  dimensions, and public output never labels them as zero measurements.
- **Does not promise**: provider pricing calculation or stable ACP detailed-token support.

### Criterion 5: Budget admission

- **Type**: Behavioral and error handling.
- **Command**: `npm test -- test/unit/application/run-workflow-capabilities.test.ts test/integration/cli/acp-agent-admission.test.ts`.
- **Expected evidence**: Unsupported token or cost budgets fail before executor invocation. Supported
  and unbudgeted cases retain explicit completeness state.
- **Does not promise**: preempting a provider request at an exact token boundary.

### Criterion 6: Pi and workflow compatibility

- **Type**: Regression and contract.
- **Command**: `npm test -- test/unit/workflow/digest.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts test/unit/application/node-executor-router.test.ts`.
- **Expected evidence**: Existing fixtures keep their workflow digests and Pi usage behavior. No ACP
  snapshot routes through the current Pi path in this slice.
- **Does not promise**: Pi-versus-ACP quality parity.

### Criterion 7: Bounded secret-free validation

- **Type**: Error handling.
- **Command**: `npm test -- test/unit/domain/capability/acp-agent.test.ts test/unit/infrastructure/fs/local-acp-agent.test.ts test/integration/cli/acp-agent-admission.test.ts`.
- **Expected evidence**: Malformed inputs return bounded messages without fixture secrets, rejected
  values, or absolute paths.
- **Does not promise**: automatic correction of invalid manifests.

### Criterion 8: Repository verification

- **Type**: Configuration and runtime compatibility.
- **Command**: `npm run check && npm run docs:style && npm run docs:links && npm run docs:ste && npm run pack:check`.
- **Expected evidence**: Static, unit, integration, build, runtime, generated-reference, package, and
  documentation gates pass from the clean feature branch.
- **Does not promise**: live model-provider or ACP-agent execution before issues #166 and #167.

## Stranger test

A contributor can explain why executor identity is outside the workflow. The contributor can
identify how Flow observes a local runtime and which values enter the capability digest. The same
review explains recovery drift and the difference between unknown usage and zero. Every issue
criterion has a runnable command and an explicit evidence boundary. Implementation requires no
additional product decision.
