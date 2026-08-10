# Decision Journal: Issue #74 — Evaluate OMP through the controlled external harness boundary

**Issue**: #74 | **Branch**: `codex/issue-74-omp-adapter` | **Started**: 2026-08-10

---

## Research snapshot

The repository audit found no older open pull request. Issue #72 and pull request #73 are merged.
The delivery roadmap names OMP and Prime Agent as the next external harness targets.

The research used these upstream states:

- OMP release `17.2.12`, tag `v17.2.12`, commit
  `45e12e5bb758198a920c6070e7e64cb33b21beac`, dated 2026-08-09.
- Prime Agent commit `ebfe770ef61bebf063f194b63f20397ed3446a68`, dated 2026-08-10.
- Flow main commit `143c4d24580e75a89b631c47a4313c4764e35fe1`.

OMP provides four useful integration surfaces. It provides a TUI, one-shot mode, RPC mode, and a
TypeScript SDK. RPC is a strict JSON stream. The SDK can register a custom provider stream and a
closed set of tools. OMP also requires Bun `1.3.14` or later.

Prime Agent provides RPC and JSON modes. Its product center is a persistent IPython environment,
recursive agents, and continual harness state. Its own security guidance says that its worker and
kernel processes are not an operating-system sandbox. This design needs a separate authority model
for Python, child agents, and durable harness state.

## Design question

How can Flow evaluate OMP as a real external harness while Flow keeps authority over model
credentials, network access, workspace scope, process lifetime, evidence, and replay?

## Approaches

### A. Run the normal OMP RPC command

Flow could start `omp --mode rpc` and parse its events.

Advantages:

- This uses a public upstream process interface.
- This keeps OMP lifecycle code outside the Flow process.
- This makes future RPC changes visible at one protocol boundary.

Problems:

- Normal OMP provider calls require provider authority in the child process.
- Normal OMP configuration can load ambient extensions, skills, rules, MCP servers, and tools.
- OMP RPC tool authority is wider than the fixed first evaluation profile.
- Task-network denial prevents normal provider calls.

Decision: reject this approach for the first adapter.

### B. Load OMP in the Flow host process

Flow could use the OMP SDK in the process that owns the evaluation.

Advantages:

- The SDK gives direct typed events.
- The host can supply a custom provider stream.
- The host can select exact tools.

Problems:

- OMP and its native dependencies would enter the trusted Flow process.
- An OMP defect could access the evaluation store, verifier data, provider credentials, or Flow
  state.
- Process-tree termination would not isolate the harness from the evaluation owner.
- Offline commands could load OMP through static imports.

Decision: reject this approach.

### C. Run a small Flow-owned OMP driver in the existing controlled process runtime

Flow can start a pinned Bun driver under SRT. The driver can use the OMP SDK. It can register one
custom provider stream that uses the private Flow control protocol. It can select only wrapped OMP
read and edit tools. The wrappers can reject paths outside the trial workspace before they call the
OMP tool.

Advantages:

- This reuses the Issue #72 deadline, cancellation, protocol, sandbox, process-tree, and host
  inference boundaries.
- The test exercises the real OMP agent loop and the real OMP read and edit behavior.
- Provider credentials stay in the trusted host.
- The OMP process has no task network.
- The public plan remains declarative.

Costs:

- The external identity must become a strict adapter union.
- The descriptor and application adapter types must stop using Pi-specific names.
- Flow must bind the Bun executable and the complete installed OMP dependency closure.
- OMP is a large optional runtime. Flow must not make it load for ordinary runs or offline audit.

Decision: select this approach.

### D. Generalize the external runtime without an OMP vertical path

Flow could first rename and generalize the Pi-specific types.

Advantages:

- This creates a small internal refactor.
- This separates common and adapter-specific identity fields.

Problems:

- It gives users no new benchmark capability.
- A second real adapter is the strongest test of the abstraction.
- A refactor without a second implementation can preserve hidden Pi assumptions.

Decision: reject this as a separate issue. Make the minimum generalization inside the OMP vertical
slice.

## Selected architecture

### User flow

1. The operator declares `adapter: omp-native-v1` and `config: omp-evaluation-v1`.
2. Validation resolves one built-in OMP identity. The plan cannot declare paths or versions.
3. Flow fingerprints the trusted driver, an attested official Bun executable, OMP, its dependency
   closure, SRT, the protocol, the sandbox policy, and the host inference contract.
4. Flow stores only the strict public identity in the evaluation header.
5. Each trial starts in a fresh private workspace.
6. SRT denies task network and protects Flow state, verifier data, and sibling workspaces.
7. The Bun driver starts an in-memory OMP session with no ambient discovery.
8. OMP sends model contexts through the signed private control protocol.
9. The Flow host resolves the selected provider and model. It keeps credentials in the host.
10. OMP can use only the wrapped read and edit tools in the trial workspace.
11. The driver returns bounded outcome and metric evidence.
12. Flow runs the private verifier and appends the terminal trial record.
13. Offline inspection reads only the stored header and trial ledger.

### Authority flow

```text
Evaluation plan
  -> fixed adapter and config selection
  -> trusted adapter registry
  -> exact external identity
  -> controlled process runtime
      -> SRT and Linux PID namespace
      -> Bun and OMP driver
          -> wrapped OMP read and edit tools -> trial workspace only
          -> signed inference request -> Flow host broker -> provider
  -> bounded harness result
  -> private verifier
  -> durable evaluation evidence
```

The plan selects a known capability. It does not supply executable authority. The trusted registry
owns executable resolution. The driver owns OMP translation only. Flow owns the process, model,
budget, evidence, and verification boundaries.

### Coupling analysis

The domain layer knows two external adapter identity variants. It does not import OMP types. The
application layer uses one generic external evaluation adapter. The process runtime uses one generic
descriptor contract. Only the OMP infrastructure directory imports OMP packages.

The OMP package is an optional peer for users and a development dependency for repository tests.
Ordinary Flow execution, native Pi execution, inspection, and export do not load it. A missing OMP
or Bun installation rejects only an OMP plan.

### Bun release attestations

Flow version 0.0.0 accepts these Bun v1.3.14 standard Linux executables:

| Architecture | Official archive | Archive SHA-256 | Extracted executable SHA-256 |
|---|---|---|---|
| x64 | `bun-linux-x64.zip` | `951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f` | `9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74` |
| arm64 | `bun-linux-aarch64.zip` | `a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b` | `37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086` |

The archive hashes come from the signed upstream checksum list. The executable hashes come from the
`bun` file in each verified archive. A later Flow release can add a new official Bun release after
the same verification process.

## Specification

_Captured by specification-capture on 2026-08-10. Source: mixed issue context, accepted roadmap,
and upstream research._

### Non-goals

- This issue does not add the Prime Agent adapter.
- This issue does not expose the full OMP tool set.
- This issue does not load OMP extensions, skills, rules, MCP servers, memory, subagents, LSP, DAP,
  browsers, Python, JavaScript kernels, background jobs, or user configuration.
- This issue does not make OMP a Flow workflow runtime.
- This issue does not import OMP types into durable Flow run, evaluation, or workflow contracts.
- This issue does not claim that OMP or Flow is superior.
- This issue does not support macOS external-harness execution. The controlled external runtime
  still requires Linux PID namespace containment.
- This issue does not protect against a trusted same-user operator who changes the Flow
  installation during a trial.

### Failure modes

- **Timeouts** — One shared execution deadline covers identity checks, instruction reads, sandbox
  preparation, driver work, host inference, process exit, and broker close. Expiry terminates the
  process tree and returns `timed_out` only after termination evidence settles.
- **Partial failures** — A started trial produces one durable terminal record. A crash after the
  durable adapter start does not retry the provider. A process or broker cleanup failure cannot
  become success.
- **Invalid input** — Unknown adapter values, OMP configurations, identity variants, protocol
  frames, tool paths, metrics, and terminal results fail with bounded errors before they become
  evidence.
- **Missing context** — A missing OMP package, Bun executable, dependency artifact, supported SRT
  backend, provider model, or exact thinking level rejects validation or the trial. Flow does not
  select a fallback harness or model.
- **Unattested runtime** — A Bun file that is not executable, is not Linux ELF, has the wrong CPU
  architecture, or lacks a built-in official release attestation rejects validation.
- **Cancellation** — Flow checks cancellation at each preparation boundary and immediately before
  process start. An active process receives termination. No later schedule item starts.
- **Artifact drift** — Flow checks the admitted closure again after sandbox preparation and directly
  before process start. A change rejects the trial before OMP starts.
- **Workspace escape** — Tool wrappers reject a path outside the canonical trial workspace. SRT is
  a second boundary. A failed path check does not disclose the target bytes.
- **Unavailable telemetry** — A metric that OMP cannot prove is `null`. Flow does not infer zero.

### Interface contracts

- `EvaluationProfileSource` adds only
  `{ adapter: "omp-native-v1", harness: { config: "omp-evaluation-v1" } }`.
- `ExternalHarnessIdentity` becomes a strict version 1 discriminated union. Common fields bind the
  adapter contract, Flow control protocol, sandbox runtime, and trusted driver. Each variant binds
  its harness runtime and inference translation.
- The OMP variant binds `@oh-my-pi/pi-coding-agent` version `17.2.12` and its npm integrity. It also
  binds the installed package-content digest and complete dependency-closure digest.
- The OMP variant binds the canonical Bun executable, Bun version, and executable SHA-256. Flow
  accepts only built-in attestations for the official Bun 1.3.14 standard Linux x64 and arm64
  executables.
- The OMP package closure includes runtime Markdown, package instances, dependency edges, and the
  observed directories that control dependency resolution.
- The generic external descriptor contains the parsed identity, identity digest, launch vector,
  runtime support paths, trusted runtime environment, and an abortable adjacent `assertCurrent`
  check.
- The OMP trusted runtime environment contains only canonical `NODE_PATH` search metadata. SRT
  grants read access only to exact selected package roots. It does not expose search containers or
  unselected sibling packages. Admission rejects a selected root that contains an unselected
  nested package.
- Immediately before process start, Flow compares the prepared SRT containment, backend, version,
  profile, and policy digest with the admitted runtime identity. A difference rejects the trial.
- The driver uses `flow-external-harness-jsonl-v1`. No OMP RPC frame becomes a Flow durable type.
- The driver selects an in-memory OMP session, one exact model, zero retries, no automatic
  compaction, no ambient discovery, and the wrapped OMP `read` and `edit` tools only.
- The host inference request uses the existing closed context envelope. The response parser accepts
  only the bounded assistant-message fields that the OMP custom provider needs.
- Runtime evidence records the selected external adapter value and confirmed tree termination.
- Version 1 tuning-evidence export still rejects every external profile.

## Acceptance criterion verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Admit the fixed OMP profile | Contract | `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts` | Fixed config passes. Unknown config and executable fields fail. | OMP availability on all hosts |
| Run real OMP through fake host inference | Integration | `npx vitest run test/integration/omp/native-omp-evaluation.test.ts` | A real OMP session edits the fixture with no provider credential. | Live provider quality |
| Exchange signed process frames | Integration | `npx vitest run test/integration/omp/native-omp-driver-protocol.test.ts` | The compiled Bun driver completes a signed two-turn tool exchange. | Provider quality |
| Translate host inference | Contract | `npx vitest run test/unit/infrastructure/omp/native-omp-host-inference-broker.test.ts test/unit/infrastructure/process/built-in-external-harness-inference-broker.test.ts` | The bridge preserves bounded continuity fields and routes only the admitted adapter. | New provider authority |
| Confine read and edit | Security | `npx vitest run test/integration/omp/native-omp-evaluation.test.ts -t "outside the trial workspace"` | Outside read and edit fail. Protected bytes do not enter model context. | Full OMP tool support |
| Keep private data out of the child | Security | `npm run build && npm run test:runtime -- test/runtime/external-harness.runtime.test.ts -t "OMP.*private"` | Real SRT probes cannot read Flow state, verifier data, or credentials. | Malicious kernel protection |
| Deny network and confirm containment | Security | `npm run build && npm run test:runtime -- test/runtime/sandbox-boundary.runtime.test.ts test/runtime/external-harness.runtime.test.ts` | Network denial and Linux PID namespace evidence pass. The selected ancestor peer stays readable. An unselected nested package fails admission. | Unsupported platform execution |
| Bind identity and reject drift | Contract | `npx vitest run test/unit/infrastructure/omp/native-omp-harness-registry.test.ts test/unit/infrastructure/fs/local-evaluation-store.test.ts` | Bun attestation, every mutable OMP identity leaf, installed bytes, and dependency-resolution drift fail closed. | Host signatures or hostile host protection |
| Fail closed on runtime faults | Error handling | `npx vitest run test/unit/evaluation/external-harness-protocol.test.ts test/unit/infrastructure/process/local-external-harness-runtime.test.ts test/unit/application/run-evaluation.test.ts` | Timeout, cancellation, malformed input, missing output, and uncertain tree cases stay failures. | Provider uptime |
| Record honest metrics | Data | `npx vitest run test/unit/application/external-harness-adapter.test.ts test/integration/omp/native-omp-evaluation.test.ts` | Available values are exact. Missing values are null. | Metrics that OMP does not expose |
| Keep inspect and export offline | Offline | `npx vitest run test/integration/cli/evaluation-offline-loading.test.ts` | Offline commands pass when OMP imports are blocked. | Offline trial execution |
| Publish clear docs and example | Documentation | `npm run pack:check` | Public files are packaged. Manual review confirms that changed prose uses STE. | Translation quality and document layout |

## Implementation order

1. Add RED tests for the strict plan and identity union.
2. Generalize the external descriptor, adapter, protocol evidence, and CLI dispatch.
3. Keep all Pi tests green after the refactor.
4. Add RED tests for OMP package, Bun, and dependency identity.
5. Implement the trusted OMP registry and adjacent drift check.
6. Add RED tests for the credential-free OMP driver and workspace path denial.
7. Implement the OMP driver with the custom provider stream and wrapped tools.
8. Add the OMP CLI example, offline import test, and SRT runtime probes.
9. Update the architecture, evaluation, security, sourcing, roadmap, README, notices, and recovery
   documents.
10. Run focused gates, full CI, coverage, package checks, runtime tests, and adversarial review.

## Sources

- OMP repository and release: <https://github.com/can1357/oh-my-pi>
- OMP SDK and RPC overview: <https://omp.sh/docs/sdk>
- OMP SDK source: <https://github.com/can1357/oh-my-pi/blob/v17.2.12/packages/coding-agent/src/sdk.ts>
- OMP custom API registry:
  <https://github.com/can1357/oh-my-pi/blob/v17.2.12/packages/ai/src/api-registry.ts>
- OMP package manifest:
  <https://github.com/can1357/oh-my-pi/blob/v17.2.12/packages/coding-agent/package.json>
- Official Bun 1.3.14 release and signed checksum list:
  <https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14>
- Prime Agent repository: <https://github.com/PrimeIntellect-ai/prime-agent>
- Prime Agent RPC: <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rpc.md>
- Prime Agent architecture:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md>
- Prime Agent RLM trust model:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md>
