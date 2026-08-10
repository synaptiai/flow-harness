# Decision Journal: Issue #72: Run external harness profiles through a controlled runtime boundary

**Issue**: #72
**Branch**: `codex/issue-72-external-harness-runtime`
**Started**: 2026-08-10

---

## Context

Before this issue, Flow could compare two admitted workflows with one provider-neutral evaluation
port. Both profiles used the Flow workflow adapter. The plan, durable header, store, runner, and
CLI assumed that every profile contained a Flow workflow.

The roadmap requires a real harness comparison. An operator must compare Flow with native Pi in
one paired evaluation. The comparison must use the same tasks, seeds, model controls, budgets, and
verifiers.

A normal Pi process can access provider credentials and the network. It can also use its own retry,
session, compaction, and tool defaults. These properties would invalidate the comparison. Flow must
control the process, inference path, retry rules, tools, workspace, and durable evidence.

## Research evidence

[Pi RPC](https://pi.dev/docs/latest/rpc) provides a JSON Lines control interface. The interface can
change session settings and can stream agent events. Pi version 0.84.0 does not send an initial
ready event. A Flow driver must own the handshake.

[Pi SDK](https://pi.dev/docs/latest/sdk) supports custom native providers and in-memory session
resources. A local probe used a custom provider with one Pi session. The provider returned one
assistant result without provider credentials in the Pi process.

[Pi container guidance](https://pi.dev/docs/latest/containerization) says that Pi does not provide
an internal sandbox. The host must use an operating-system, container, or virtual-machine boundary.

[OMP RPC](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) provides useful protocol
precedents. It has a ready frame, explicit protocol negotiation, bounded frames, and host-owned
tools. OMP also disables defaults that can change an evaluation result.

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) keeps provider calls in the host for
its recursive language-model path. This separation supports a child runtime without provider
credentials. Prime Agent does not provide an operating-system sandbox.

[OpenShell inference routing](https://docs.nvidia.com/openshell/latest/sandboxes/inference-routing)
uses a local inference endpoint. A gateway injects provider credentials. Its policy model can also
restrict filesystem, process, and network access. OpenShell is a useful future runtime adapter. It
is not a required dependency for the first native Pi adapter.

## Functional flows

### Operator flow

1. The operator declares one Flow profile and one native Pi profile.

2. The operator selects exact model controls, budgets, tasks, seeds, and comparison limits.

3. Flow validates the complete plan and shows its stable plan digest.

4. Flow runs paired trials through the selected adapters.

5. Flow stores one bounded terminal record for each completed trial attempt.

6. The operator can stop the command and resume the exact remaining suffix.

7. The operator inspects and exports the result without provider access or a Pi installation.

### System flow

1. Flow admits each profile and resolves a trusted adapter descriptor.

2. Flow binds the adapter, runtime, protocol, package, configuration, and sandbox identities.

3. Flow creates one isolated workspace for the next trial.

4. Flow writes and synchronizes an adapter-start record before the adapter can call a model.

5. Flow starts the trusted Pi driver inside the command sandbox.

6. The driver sends a bounded ready frame through the Flow protocol.

7. The driver asks Flow for model inference through the private control channel.

8. Flow executes the request with the admitted model controls and no provider retry.

9. Pi runs only the admitted tools inside the trial workspace.

10. The driver returns bounded terminal evidence and metrics.

11. Flow verifies the workspace and commits one terminal trial record.

12. Flow retires the durable start record after the terminal record is durable.

### Cancellation flow

1. Flow aborts the active driver process.
2. Flow waits for the fixed grace interval.
3. Flow sends a kill signal when the process tree remains active.
4. Flow records process-tree termination evidence.
5. Flow commits only the active trial as cancelled.
6. Flow leaves every unstarted schedule item for a later resume.

### Crash recovery flow

1. Flow reads the terminal ledger and the adapter-start record.
2. A terminal record for the same schedule position takes precedence.
3. A start record without a terminal record proves that the adapter could have called a model.
4. Flow does not start that adapter again.
5. Flow commits one bounded harness-failure record for the interrupted attempt.
6. Flow continues with the next schedule item.

### Offline audit flow

1. Flow reads only the durable public header and terminal ledger.
2. Flow validates the plan digest, schedule, chain, adapter identities, and record bounds.
3. Flow does not load the external harness package.
4. Flow does not contact a provider.

## Specification

_Captured by the specification-capture skill on 2026-08-10. Source: Issue #72 and design review._

### Non-goals

Adapter scope:

- This issue does not add an OMP adapter.
- This issue does not add a Prime Agent adapter.
- This issue does not require OpenShell.
- This issue does not allow arbitrary executable paths in an evaluation plan.
- This issue does not expose Flow verifier logic to an external harness.

Evaluation scope:

- This issue does not claim that Pi or Flow is superior.
- This issue does not change the statistical comparison method.
- This issue does not use external profiles to generate prompt candidates.
- This issue does not export tuning evidence for an external profile.
- This issue does not add provider or harness retries.

Compatibility scope:

- This issue does not change the digest of an existing Flow-only version-one plan.
- This issue does not require migration of an existing Flow-only evaluation.
- This issue does not reinterpret missing metrics as zero.

### Failure modes

Runtime failures:

- **Timeout**: Flow terminates the process tree and records bounded termination evidence.
- **Cancellation**: Flow records only the active trial as cancelled and stops the schedule loop.
- **Partial failure**: Flow rejects an incomplete terminal frame and records a harness failure.
- **Host crash**: Flow consumes the durable start record without a second adapter invocation.

Protocol failures:

- **Invalid input**: Flow rejects an invalid plan, adapter configuration, frame, or sequence.
- **Missing context**: Flow rejects a missing runtime, package, model, workspace, or sandbox feature.
- **Malformed output**: Flow rejects unknown, duplicate, forged, oversized, or out-of-order frames.
- **Channel violation**: Flow terminates a driver that violates the signed protocol.

Dependency failures:

- **Dependency outage**: A missing Pi package or provider failure becomes bounded harness evidence.
- **Provider outage**: Flow applies no provider retry and records unavailable metrics when required.
- **Unsupported runtime**: Flow fails before the model call when isolation cannot meet the contract.

Resource failures:

- **Resource exhaustion**: Flow bounds frames, events, output, time, tokens, and processes.
- **Output flood**: Flow drains bounded streams and terminates the process at the fixed limit.
- **Process escape**: Flow rejects a runtime that cannot prove complete tree termination.

Storage failures:

- **Start-record failure**: Flow does not invoke the adapter when the start record is not durable.
- **Terminal-record failure**: Resume treats the durable start record as an interrupted attempt.
- **Cleanup failure**: Durable terminal evidence remains authoritative. Flow can retry cleanup.
- **Identity change**: Flow rejects resume when any bound external identity changes.

### Interface contracts

Plan contract:

- A profile uses either `flow-workflow-v1` or `pi-native-v1`.
- A `flow-workflow-v1` profile keeps the existing `workflow` or `candidate` source form.
- A `pi-native-v1` profile uses one strict built-in harness configuration.
- The plan does not contain an executable path, provider credential, or network endpoint.
- Both profiles use the shared plan model, budget, network, and retry controls.

Adapter identity contract:

- The profile identity contains the adapter kind and adapter contract version.
- The identity contains the Flow protocol version and runtime policy version.
- The identity contains the exact Pi package version and package integrity.
- The identity contains the trusted driver digest and normalized harness configuration digest.
- The identity contains the sandbox profile and inference-broker contract identities.
- Any identity change produces a different plan digest.

Runtime protocol contract:

- Flow owns a strict UTF-8 JSON Lines protocol.

- The first driver frame is one authenticated ready frame.

- Every later frame has a monotonic sequence number and one request correlation id.

- The maximum encoded frame size is 1 MiB.

- Unknown fields, unknown types, duplicate ids, and invalid state transitions fail closed.

- Standard error is diagnostic data only. It is never a control channel.

- Flow bounds and redacts every stored diagnostic.

Inference contract:

- The Pi process receives no provider credential.
- The Pi process receives no general network access.
- A Pi custom provider sends model requests through the private Flow channel.
- Flow validates the exact provider, model, thinking level, token limit, and retry limit.
- A model tool cannot read a path outside the canonical trial workspace.

Durability contract:

- Flow synchronizes the adapter-start record before adapter invocation.
- One schedule position has at most one durable start record.
- One terminal record retires the start record for the same schedule position.
- Resume never invokes an adapter for an unresolved durable start record.
- Existing evaluations without an adapter-start file keep their current behavior.

Metrics contract:

- Flow records a metric only when the adapter supplies valid evidence.
- Flow records unavailable metrics as `null`.
- Flow never converts an unavailable metric to zero.
- Flow binds metrics to the terminal frame and trial identity.

## Architecture options

| Option | Description | Benefits | Risks | Decision |
|---|---|---|---|---|
| A | Load each harness SDK in the Flow process | Small implementation and direct types | A harness can share credentials, memory, and failure state | Rejected |
| B | Run each harness CLI with direct provider access | Uses the native CLI and its normal protocol | Exposes credentials and permits uncontrolled network behavior | Rejected |
| C | Use a Flow protocol, sandboxed driver, and host inference broker | Separates authority and supports later adapters | Requires a strict protocol and process supervisor | Selected |
| D | Require OpenShell for every external adapter | Provides a strong remote policy and inference model | Adds a large deployment dependency to the first adapter | Deferred |

## Decision

Use option C. Flow owns one external-harness runtime contract. The first trusted driver uses the Pi
SDK. The driver runs in an SRT process and uses a private inference channel.

Flow does not execute an operator-supplied harness binary. A built-in adapter registry resolves
`pi-native-v1` to one trusted driver descriptor. This rule prevents a plan from becoming an
arbitrary process launcher.

The adapter fails closed when the selected runtime cannot enforce the filesystem, network,
process-tree, and control-channel rules. Version 1 external harness execution is Linux-only. It
requires the verified SRT PID namespace. Domain and protocol tests can run on all supported systems.

OpenShell can implement the same runtime port later. Its inference gateway can replace the local
broker without a plan-schema change. OMP and Prime drivers can also implement the same protocol.

## Component boundaries

| Component | Responsibility | Must not own |
|---|---|---|
| Evaluation plan domain | Strict profile union and public identity | Files, Pi, credentials, processes |
| External harness protocol domain | Frames, state machine, limits, and evidence | Sockets, files, providers, Pi |
| Evaluation runner | Trial order, durable start, terminal record, and cancellation boundary | Pi implementation details |
| Evaluation store | Start-record and terminal-record durability | Adapter execution or verification |
| Harness runtime port | Isolated process start, exchange, cancellation, and termination proof | Plan parsing or statistics |
| Inference broker port | Exact model request and response | Harness tools or workspaces |
| Native Pi adapter | Pi configuration and protocol translation | Provider credentials or verifier data |
| Sandbox adapter | Filesystem, network, process, and channel policy | Evaluation classification |
| CLI | Admission, registry composition, signal routing, and result summary | Protocol state transitions |

Dependencies remain one-directional:

```text
CLI -> local plan and store -> evaluation runner -> adapter and store ports
CLI -> external runtime adapter -> sandbox port and inference broker port
external runtime adapter -> protocol domain
native Pi driver -> Pi SDK and Flow protocol codec
evaluation runner -> verifier port after completed harness evidence
```

The evaluation domain imports no CLI, filesystem, sandbox, provider, or Pi module.

## Public profile and identity

The source profile union adds one strict form:

```yaml
- id: native-pi
  adapter: pi-native-v1
  harness:
    config: pi-evaluation-v1
```

`pi-evaluation-v1` is a built-in configuration. It uses the admitted workspace, task instruction,
shared model controls, shared budget, no network, no retry, no skills, and no ambient context.

The admitted external profile contains a complete public harness identity. It does not contain a
local installation path. The identity has these fields:

- Adapter kind and contract version.
- Driver artifact and local dependency-closure SHA-256 digests.
- Node version and executable SHA-256 digest.
- Pi coding-agent and Pi AI names, exact versions, registry integrities, and installed closure digests.
- Flow protocol version and configuration digest.
- SRT version, installed closure digest, policy digest, Linux platform, and PID-namespace identity.
- Inference broker contract version.

The version-one Flow-only identity encoder remains unchanged. It omits all external-profile fields.
An external profile adds the harness identity under that profile only.

## Durable adapter-start boundary

The store adds one bounded active-attempt record. The record names the evaluation, plan digest,
schedule position, trial id, profile id, adapter kind, start time, and owner process identity.

The write order is:

1. Create the isolated workspace.

2. Validate the fixture copy.

3. Write and synchronize the adapter-start record.

4. Invoke the adapter.

5. Create and append the terminal trial record.

6. Synchronize the terminal ledger.

7. Retire the adapter-start record.

8. Synchronize the store directory.

Resume uses these rules:

| Durable state | Resume action |
|---|---|
| No start and no terminal record | Run the scheduled adapter |
| Start and no terminal record | Commit one interrupted harness failure without adapter execution |
| Start and matching terminal record | Retire the stale start record |
| Terminal record and no start | Continue with the next schedule item |
| Start conflicts with the plan or schedule | Reject the store as corrupt |

The start record is not a retry token. It is proof that a paid or external effect could have begun.

## Runtime protocol

### Transport

The first implementation uses standard input and standard output as two private protocol pipes.
Standard error carries bounded diagnostic text only. The model has no process tool.

Flow confines `read` and `edit` to existing files in the canonical trial workspace. A runtime probe
also denies access to protected host paths and the process control input.

### State machine

```text
spawned -> ready -> running -> terminal -> closed
                 -> cancelling -> terminal -> closed
spawned or running -> protocol_failed -> terminated
spawned or running -> timed_out -> terminated
```

Only these transitions are valid. One terminal frame ends the protocol. Any later frame is a
protocol error.

### Frame classes

Parent frames:

- `hello` selects the protocol and binds the trial identity.
- `inference_response` returns one correlated model result.
- `cancel` is reserved for a later graceful cancellation protocol.

Driver frames:

- `ready` confirms the driver, Pi, configuration, and protocol identities.
- `inference_request` requests one exact model turn.
- `event` reports bounded progress without authority.
- `terminal` reports harness outcome and metrics.

Every frame contains a protocol version, sequence number, type, and bounded payload. The protocol
codec rejects duplicate object keys before schema validation.

### Channel binding

Flow creates the private descriptors after plan admission. The session key is absent from the plan,
environment, command line, workspace, model context, and driver diagnostics.

Protocol tests reject unsigned or forged parent and driver frames. The native runtime test proves
that the model read tool cannot open the control input.

## Isolation and threat model

The external process can read only these paths:

- The immutable trusted driver and its required runtime files.
- The isolated trial workspace.
- Required operating-system runtime files.

The process cannot read these paths:

- The source fixture.
- The verifier definition or expected values.
- The evaluation store and the configured project `.flow` state.
- Another trial or child workspace.
- Provider credential stores or user configuration.

The process can write only inside the isolated trial workspace and bounded runtime temporary paths.
The task tool network policy is `deny`. The private inference path is not a general network route.

The same-user operator controls local files and can replace the installed application. Hashes do
not provide signatures against that operator. The identities prevent accidental drift and partial
store rewriting. They do not claim protection from a fully reauthored local store and application.

## Limits

Protocol limits:

| Resource | Initial limit |
|---|---:|
| Encoded frame | 1 MiB |
| Diagnostic text per event | 4 KiB of UTF-8 |
| Retained standard-error text | 16 KiB |
| Total standard-error transport | 64 KiB |
| Stored progress events | 256 |
| Concurrent inference requests | 1 |
| Terminal frames | 1 |

Execution limits:

| Resource | Initial limit |
|---|---:|
| Provider retries | 0 |
| Harness retries | 0 |
| Graceful cancellation | 2 seconds |
| Process termination wait | 10 seconds |
| Total execution time | Shared plan budget |
| Model tokens and cost | Shared plan budget |

## Verification map

Plan and compatibility checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Compare Flow with native Pi | Behavioral | `npx vitest run test/integration/cli/evaluation.test.ts -t "native Pi adapter boundary"` | One paired plan executes both adapters | Statistical superiority |
| Bind the complete external identity | Contract | `npx vitest run test/unit/infrastructure/pi/native-pi-harness-registry.test.ts test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts` | Exact identity, installed-byte drift, and digest fixtures pass | Signed packages |
| Reject identity drift on resume | Recovery | `npx vitest run test/unit/infrastructure/fs/local-evaluation-store.test.ts -t "external identity"` | Each single-field mutation fails | Host compromise |
| Preserve Flow-only version-one identity | Compatibility | `npx vitest run test/unit/infrastructure/fs/local-evaluation-store.test.ts -t "legacy direct-workflow"` | Fixed legacy digest and incomplete resume pass | External profiles in old stores |

Durability and cancellation checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Write start before model access | Durability | `npx vitest run test/unit/application/run-evaluation.test.ts -t "durable start"` | Adapter sees a synchronized start record | Distributed transactions |
| Do not repeat an interrupted adapter | Recovery | `npx vitest run test/unit/application/run-evaluation.test.ts -t "unresolved durable start"` | Resume records failure with zero adapter calls | Provider-side idempotency |
| Stop after the active cancellation | Cancellation | `npx vitest run test/unit/application/run-evaluation.test.ts -t "active cancelled trial"` | One cancelled record and an unstarted suffix remain | Process termination proof |
| Terminate the process tree | Runtime | `npx vitest run test/unit/infrastructure/process/local-external-harness-runtime.test.ts -t "descendant|cancellation|initial control|execution deadline|standard-error"` | Process identifiers are absent before settlement | Every kernel version |

Protocol and isolation checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Reject invalid protocol input | Adversarial | `npx vitest run test/unit/evaluation/external-harness-protocol.test.ts` | Mutation matrix returns bounded typed errors | Driver correctness |
| Keep credentials in the host | Security | `npm run build && npm run test:runtime -- test/runtime/external-harness.runtime.test.ts -t "without provider credentials"` | The real Pi driver completes through a fake host broker | Host compromise |
| Deny private host state | Security | `npm run build && npm run test:runtime -- test/runtime/external-harness.runtime.test.ts -t "private host paths"` | Read and edit probes fail | Malicious kernel protection |
| Deny task network access | Security | `npm run test:runtime -- test/runtime/sandbox-boundary.runtime.test.ts -t "loopback"` | The shared SRT profile blocks a host service | Host inference availability |
| Protect the control channel | Security | `npx vitest run test/unit/evaluation/external-harness-protocol.test.ts && npm run test:runtime -- test/runtime/external-harness.runtime.test.ts -t "private host paths"` | Forged frames and control-input reads fail | Compromised trusted driver |
| Enforce frame limits and order | Boundary | `npx vitest run test/unit/evaluation/external-harness-protocol.test.ts -t "frame-byte limit|state transitions"` | Exact-limit passes and one-over fails | Network transport |

Adapter and audit checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Execute native Pi without credentials | Integration | `npx vitest run test/integration/pi/native-pi-evaluation.test.ts` | Fake broker completes one real Pi SDK session | Live provider quality |
| Keep unavailable metrics null | Contract | `npx vitest run test/unit/application/external-harness-adapter.test.ts` | A runtime failure returns nullable unavailable metrics | Metric availability |
| Inspect and export offline | Offline | `npx vitest run test/integration/cli/evaluation.test.ts -t "native Pi adapter boundary"` and `npx vitest run test/integration/cli/evaluation-offline-loading.test.ts` | Inspect and export use only durable evidence and do not load Pi | Re-execution offline |
| Reject prompt-tuning export | Authority | `npx vitest run test/integration/cli/evaluation.test.ts -t "native Pi adapter boundary"` | External tuning export returns a usage error | Future generalized tuning evidence |

Release checks:

| Criterion | Type | Command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Pass local CI | Release | `npm run check && npm run test:coverage && npm run pack:check` | All credential-free gates pass | Provider uptime |
| Pass runtime boundaries | Release | `npm run test:runtime` | Supported runtime probes pass or skip explicitly | Unsupported runtime support |
| Keep documentation clear | Documentation | `npm run format:check` | Changed documents pass project checks and manual STE review | Translation quality |

## Implementation order

Durability first:

1. Add failing runner tests for durable start, crash recovery, and cancellation suffix behavior.
2. Add the active-attempt store port and local durable implementation.
3. Keep existing Flow-only behavior and fixed identity fixtures unchanged.

Identity next:

4. Add failing plan and store tests for the external profile union and all identity mutations.
5. Implement the trusted adapter registry and the external public identity.
6. Reject external profiles in prompt-candidate tuning export paths.

Protocol next:

7. Add the pure protocol state-machine tests and mutation matrix.
8. Implement strict framing, bounds, sequence checks, and terminal evidence parsing.
9. Add the process runtime port and deterministic fake runtime tests.

Native Pi vertical path:

10. Add a credential-free Pi SDK test with a fake host inference broker.
11. Implement the trusted Pi driver and host adapter.
12. Add process-tree, privacy, network, and control-channel runtime tests.
13. Compose the external adapter in the CLI and add the paired end-to-end test.

Release:

14. Update architecture, evaluation, workflow, security, recovery, roadmap, and example documents.
15. Run graph maintenance, focused tests, full local CI, runtime tests, and package checks.
16. Run independent specification, correctness, security, and holdout review to zero findings.
