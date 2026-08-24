# Decision Journal: Issue #173 — Add optional exact proof verification

**Issue**: #173 | **Branch**: `codex/issue-173-lean-proof-verification` | **Started**: 2026-08-24

---

## Context

Flow can contain local executors, retain durable model and verifier evidence, qualify exact harness
profiles, and activate only evidence-backed immutable states. Slice 10.3 adds optional Lean proof
verification without allowing a proof, a proof-generating model, or a formal statement to become
unreviewed task-completion authority.

The user approved Refined Approach B with corrected runtime defaults: a Flow-owned, reproducibly
built Linux x64 OCI proof appliance; an exact Lean toolchain and dependency closure; an exact
Leanstral SafeVerify kernel check; an independent Nanoda check; exact human approval of statement
faithfulness; and optional provider-neutral proof generation through existing model authority.

## Existing evidence

- `VerifierExecutor` is the existing application port for workflow verifier nodes. Command and
  model verifiers currently return boolean acceptance plus command or model evidence.

- `AgentExecutor` already carries exact provider and model configuration. Optional proof generation
  can use this port without introducing a proof-model provider API or a hard-coded model.

- Durable run events admit command and model verifier evidence. They need a proof-specific evidence
  variant so replay cannot reduce proof acceptance to one process exit status.

- Evaluation plans have purpose-specific qualification for ACP interoperability and phase routing.
  Proof qualification needs its own purpose because coverage, statement faithfulness, independent
  checking, ordinary tests, cost, and latency have different completeness rules.

- The Prime adapter proves a useful OCI lifecycle pattern: digest-pinned build inputs, two clean
  builds, local attestation, fixed runtime policy, durable leases, and confirmed removal. Its image,
  protocol, and domain types are Prime-specific and cannot be reused as proof authority.

- Language-server and semantic-service infrastructure prove useful admission patterns: exact
  executable identity, bounded snapshots, no-follow reopening, freshness checks, and private
  cleanup. A host-local Lean executable is not a closed proof dependency identity.

## Approved architecture

### Refined Approach B: Flow-owned proof appliance

Flow prepares one Linux x64 OCI image from fixed, digest-checked inputs. The prepared artifact binds
the immutable image ID, platform, Lean toolchain, Lake dependency manifest, proof checker versions,
build recipe, and two-clean-build reproducibility result. Proof execution cannot start when any
identity is missing, stale, unsupported, or inconsistent.

One proof request contains bounded private source specification, exact formal statement, proof,
target declaration, exact runtime identity, a human statement-faithfulness approval, resource
policy, and optional exact proof-model route. The optional route uses the existing `AgentExecutor`;
there is no proof-provider interface, provider discovery, or fallback model.

The proof driver runs behind the existing `VerifierExecutor` boundary. It compiles an isolated
submission, checks the requested declaration and type, replays the environment under a fixed axiom
policy with the pinned Leanstral SafeVerify checker, and invokes Nanoda over the complete exported
environment. Acceptance requires both checkers to agree. Source scans for incomplete and unsafe
constructs are defense in depth, not the kernel trust decision.

The target compiler phase exists alone, runs under UID and GID 10001, and settles its complete
process group before the supervisor locks its tree and freezes the target artifact. Only then does
the supervisor create the separate submission tree and home for the proof compiler. The proof
phase cannot change the frozen target artifact.

The container has no network, credentials, ambient home directory, host PID namespace, or
authoritative project write mount. It has a read-only root, disposable bounded workspace, fixed CPU,
memory, process, file, inode, and time limits, a write-ahead durable lease, and confirmed removal.
Uncertain creation, execution, output collection, or cleanup blocks automatic retry.

Private evidence retains bounded specification, statement, proof, exact identities, compiler and
checker results, timings, cost, and cleanup. Public events and exports expose content-free hashes,
byte sizes, states, policy results, and measurements. Human approval binds the exact specification
digest to the exact statement digest. A model faithfulness score can be supplemental evidence only.

Proof qualification is purpose-specific. It measures complete proof coverage, exact faithfulness
approval coverage, ordinary deterministic verification, false acceptance and policy failures,
cleanup, cost, and latency. Only complete evidence can be `qualified`; constraint breaches are
`not_qualified`, and missing or incomparable evidence is `insufficient_evidence`.

The qualification command validates one closed operator-assembled audit document. It binds the
complete admitted input and publishes content-free task identities, but it does not reopen a run
ledger or gain activation authority. Reviewers retain the input with its immutable private source
evidence.

### Fixed first-version defaults

- Platform: Linux x64 only. Native macOS and Linux arm64 are later backends.
- Toolchain: exact stable Lean release and exact Lake dependency manifest; no `stable`, `latest`, or
  moving branch input is permitted.
- Axiom allowlist: `propext`, `Quot.sound`, and `Classical.choice` only.
- Refused constructs: `sorryAx`, `Lean.trustCompiler`, user axioms, `unsafe`, and `partial`.
- Runtime network: none. Runtime credentials: none. Root filesystem: read-only.
- Proof model: absent by default; when present, one exact operator-selected provider/model route
  with deny fallback.
- Public result: content-free. Bounded proof material remains private evidence.

Runtime resource values remain fixed by the prepared profile but must be calibrated by hosted Linux
x64 evidence. The implementation must not copy Prime's 2 GiB memory limit without proving that the
selected Lean and dependency closure run reliably within it.

### Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Host-local exact manifest | Small and fast to integrate | Host libraries, imports, caches, and executable closure remain ambient | Rejected as first production boundary |
| Flow-owned OCI proof appliance | Portable identity, reproducible preparation, fixed containment, existing port reuse | Largest implementation and hosted Linux test burden | Approved |
| Dual native and OCI backends | Better local ergonomics | Doubles trust boundaries and recovery paths before one profile is proven | Defer native backend |
| Evaluation-only proof adapter | Smallest authority surface | Does not provide usable workflow verification | Rejected |
| Generic executable plugin | Broad future extensibility | Expands package execution authority and weakens reviewability | Out of scope |

## User, operator, and system flows

### Prepare the proof appliance

1. The operator selects the checked-in proof build manifest on a supported Linux x64 builder.
2. Flow reopens each fixed input and verifies its digest before build execution.
3. Flow performs two clean builds from the same inputs and compares normalized OCI identities.
4. Flow probes the image for exact Lean, Lake, dependency, SafeVerify, lean4export, and Nanoda
   identities and validates the fixed runtime policy.
5. Flow writes a local attestation only after all identities and probes agree.

### Approve a statement and verify a proof

1. The operator supplies the bounded natural-language specification and exact formal statement.
2. Flow computes both identities and records an explicit human approval binding that pair.
3. The operator supplies a proof or selects one exact optional model route to propose a proof.
4. Before any container side effect, Flow records the request, runtime identity, resource policy,
   workspace identity, and lease intent.
5. The appliance compiles the isolated submission and returns bounded structured results for the
   target declaration, exact type, imports, axioms, completeness, and unsafe-state checks.
6. SafeVerify replays the target environment. Nanoda independently checks the
   complete exported environment.
7. Flow accepts only matching successful checks and a current exact faithfulness approval. It
   confirms container removal before settling the verifier result.

### Qualify and operate the profile

1. The operator selects one exact proof profile and a held-out task set with declared proof-eligible
   criteria and separate ordinary verification.
2. Each trial preserves proof coverage, faithfulness, both checker results, ordinary results, cost,
   latency, policy behavior, and cleanup.
3. Flow aggregates only complete, identity-consistent trials and reports `qualified`,
   `not_qualified`, or `insufficient_evidence`.
4. Attached, detached, recovery, replay, inspection, and export paths retain the same identities and
   never reinterpret missing evidence as success.

## Coupling analysis

- The domain layer owns bounded proof requests, exact identities, faithfulness approvals, checker
  agreement, public/private evidence projections, and qualification semantics. It has no Docker,
  filesystem, Lean, or provider dependency.

- The application layer composes the proof driver behind `VerifierExecutor`, optionally invokes the
  existing `AgentExecutor`, records lifecycle intent before effects, and requires confirmed cleanup
  before result settlement.

- OCI infrastructure owns image preparation, attestation, platform checks, fixed runtime policy,
  container lifecycle, output bounds, and recovery reconciliation. It does not decide mathematical
  or statement faithfulness.

- The proof appliance owns isolated Lean compilation and the two independent proof checks. It does
  not receive Flow credentials, project authority, operator prompts beyond bounded proof material,
  or task-completion authority.

- Evaluation owns purpose-specific evidence completeness and qualification. It does not infer proof
  coverage or faithfulness from ordinary test success.

- The CLI composes admitted profiles and emits content-free results. It does not parse Lean output,
  choose a proof model, or approve statement faithfulness.

## Specification

_Captured by specification-capture skill on 2026-08-24. Source: user-confirmed._

### Non-goals

- No proof assistant, proof-specialized model, or formal verification is mandatory for ordinary Flow
  workflows.

- No proof result replaces builds, tests, linting, runtime checks, deterministic criterion evidence,
  or human review of intent.

- No model can author or approve its own statement-faithfulness authority.

- No moving Lean channel, moving dependency branch, unrestricted import, networked runtime,
  credential pass-through, host-local cache, or authoritative source mount is admitted.

- No generic executable package plugin, remote proof service, native macOS executor, Linux arm64
  executor, dynamic proof-model router, or paid-provider requirement is introduced.

- No claim is made that kernel acceptance proves the source specification, product requirement, or
  task objective.

### Failure modes

- **Timeouts** — A preparation, model, compiler, checker, container, or cleanup timeout returns a
  bounded non-success result under the exact declared limit. It never authorizes fallback or retry
  after an uncertain effect.
- **Partial failures** — A successful compiler or checker cannot mask another failed or missing
  check. Flow preserves each component state and settles the proof only after the complete result
  and confirmed cleanup are durable.
- **Invalid input** — Malformed, oversized, unsupported, unsafe, incomplete, or identity-mismatched
  input is rejected before it can become accepted evidence. Flow records a content-free reason and
  does not infer corrected proof content.
- **Missing context** — A missing profile, runtime attestation, dependency identity, statement
  approval, declaration identity, checker result, ordinary verification result, or lifecycle state
  prevents proof acceptance or qualification.
- **Unsupported platform** — Preparation or execution fails before proof work.
- **Input or image drift** — Admission fails; Flow does not rebuild from moving inputs or substitute
  another image.
- **Incomplete faithfulness approval** — Verification is non-success even if both proof checkers
  accept.
- **Compilation or declaration mismatch** — Verification rejects the proof and retains bounded
  diagnostic evidence.
- **Disallowed axiom, incomplete term, or unsafe construct** — Verification rejects the proof.
- **Checker disagreement** — Verification returns non-success and identifies both checker states.
- **Malformed, oversized, or missing output** — Verification fails closed without interpreting
  partial output.
- **Timeout or resource exhaustion** — Verification fails with exact policy evidence.
- **Container effect uncertainty** — Recovery reconciles the exact lease; automatic retry remains
  blocked until the prior container is proven absent or safely settled.
- **Cleanup uncertainty** — The verifier cannot settle as accepted.
- **Missing evaluation evidence** — Qualification is `insufficient_evidence`, never qualified.

### Interface contracts

- A proof request binds exact schema, specification, statement, proof, target declaration, profile,
  runtime, checker, resource-policy, and faithfulness-approval identities.

- A faithfulness approval is explicit human authority over one exact specification digest and one
  exact statement digest. Any content change invalidates it.

- Proof acceptance requires compiler success, exact declaration/type match, closed allowed axioms,
  no refused constructs, successful kernel replay, successful independent Nanoda checking, exact
  identity agreement, and confirmed cleanup.

- The optional proof generator uses one exact existing model route and deny fallback. Generated text
  is untrusted proof input until all deterministic checks pass.

- Public evidence contains no specification, statement, proof, compiler diagnostic source, model
  prompt, model response, credential, environment value, or workspace path.

- A proof evaluation declares its proof-eligible denominator and ordinary verification separately.
  Missing trials, missing faithfulness approvals, missing checker results, missing ordinary results,
  or mismatched identities prevent qualification.

## Verification map

| Criteria | Type | Verification command | Passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1 | Contract, build, runtime | `npm run proof:prepare:verify` and hosted `npm run proof:prepare` | Fixed inputs, two clean builds, local attestation, exact Linux x64 image, and component identities pass | Reproducibility on unsupported hosts |
| 2, 4–7 | Domain, workflow, and behavioral | `npx vitest run test/unit/proof/proof-verification.test.ts test/unit/workflow/lean-proof-verifier-compiler.test.ts test/unit/application/proof-verifier-executor.test.ts test/unit/application/run-workflow-proof-verifier.test.ts test/unit/cli/public-output.test.ts` | Bounded request admission, exact optional route, human approval, checker agreement, workflow composition, durable evidence, and content-free projection pass | Correctness of an unformalized requirement |
| 3, 9 | Lifecycle and recovery | `npx vitest run test/unit/infrastructure/oci/local-lean-proof-driver.test.ts test/unit/infrastructure/oci/local-lean-proof-lease-store.test.ts test/unit/infrastructure/oci/local-lean-proof-runtime-admission.test.ts test/unit/infrastructure/runtime/production-node-executor.test.ts` | No-network fixed policy, exact admission, write-ahead lease, cancellation, recovery, confirmed cleanup, and uncertainty tests pass | Multi-host recovery |
| 4 | Hosted Linux x64 | `FLOW_PROOF_RUNTIME_TEST=1 npm run proof:image:verify` | Real Lean compilation, SafeVerify replay, Nanoda agreement, containment self-checks, refused proof cases, recovery, cancellation, and cleanup pass | Native macOS or Linux arm64 execution |
| 5, 9 | Durable data and replay | `npx vitest run test/unit/application/run-workflow-proof-verifier.test.ts test/unit/cli/public-output.test.ts test/runtime/lean-proof-oci.runtime.test.ts` | Private bounded evidence and content-free public evidence retain exact identities across run, replay, inspection, recovery, and runtime lifecycle paths | External archival guarantees |
| 7 | Composition | `npx vitest run test/unit/workflow/lean-proof-verifier-compiler.test.ts test/unit/application/run-workflow-proof-verifier.test.ts` | Proof acceptance remains one explicit verifier result with a separate ordinary-test dependency | Completeness of operator-authored tests |
| 8 | Evaluation | `npx vitest run test/unit/evaluation/lean-proof-qualification.test.ts test/integration/cli/lean-proof-qualification.test.ts` | Proof, faithfulness, ordinary-test, cost, latency, policy, cleanup, missingness, and three-state qualification rules pass | General theorem-proving benchmark superiority |
| 10 | Documentation | `npm run docs:capabilities:generate && npm run docs:capabilities:check && npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts` | Canonical guide, documentation hub, concise README, architecture Mermaid and repository map, roadmap, status, capability reference, and Linux x64 boundary are current | Third-party certification |
| 11 | Full local and hosted gates | `npm run ci:local` and the hosted Linux x64 `proof-runtime` job | Local CI-equivalent checks and hosted runtime checks pass without paid-provider credentials | Paid-provider availability |

## Implementation sequence

1. RED/GREEN the proof request, faithfulness approval, acceptance decision, private/public evidence,
   and durable verifier event contracts.
2. RED/GREEN proof profile admission, exact optional model route, and existing verifier composition.
3. RED/GREEN purpose-specific proof evaluation records, aggregation, and activation refusal.
4. RED/GREEN the proof OCI manifest, attestation, engine boundary, write-ahead lease, lifecycle,
   recovery, and public inspection.
5. Implement and exercise the fixed Lean appliance, SafeVerify replay, independent Nanoda
   check, negative proof corpus, containment probes, and hosted Linux x64 workflow.
6. Update the canonical operator guide, documentation hub, concise README, architecture Mermaid and
   repository map, roadmap, project status, testing guide, and generated capability reference.
7. Run focused tests, serial tests, coverage, runtime, package, documentation, adversarial review,
   local CI-equivalent checks, and hosted Linux x64 acceptance.
