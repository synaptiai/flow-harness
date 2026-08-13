# Decision Journal: Issue #82 — Apply reusable versioned policy packages as narrowing constraints

**Issue**: #82

**Branch**: `codex/issue-82-versioned-policy-packages`

**Started**: 2026-08-13

---

## Status

Implemented. The first release adds inert policy packages, exact versioned selection, deterministic
narrowing, immutable distribution and replay identity, pre-mutation workflow admission, and public
CLI inspection. It does not add a second evaluator, executable policy language, update service, or
presentation ABI.

## Specification

_Captured by the specification-capture skill on 2026-08-13. Source: extracted from Issue #82 and
the user-approved architecture comparison._

### Non-goals

- Do not add UI or TUI contribution packages. Flow does not yet have a stable presentation host.

- Do not execute Rego, Cedar, WebAssembly, native code, scripts, hooks, or package-selected logic.

- Do not add an external policy decision point or replace the existing Flow policy broker.

- Do not add automatic updates, version solving, trust-root refresh, freshness, revocation, or
  rollback metadata.

- Do not add private-registry credentials or network access during admission, execution, recovery,
  replay, listing, or inspection.

- Do not let workflows, models, or packages select policy packages dynamically.

- Do not let packages add providers, tools, permissions, sandbox backends, graph edges, credentials,
  approval bypasses, or budget authority.

- Do not alter the identity or behavior of configurations that select no policy package.

### Failure modes

- **Timeouts and cancellation** — Local discovery and snapshot operations are bounded and receive
  the caller signal where an asynchronous boundary exists. Explicit remote installation keeps the
  existing acquisition deadline. Runtime policy evaluation performs no network operation.

- **Partial failures** — A manifest, catalog, installed bundle, or combined snapshot stays inactive
  until every selected identity and constraint validates. A failure publishes no run, supervisor,
  provider, or executor state.

- **Invalid input** — Unknown fields, mutable versions, duplicate identities, contradictory sets,
  invalid ceilings, unsupported authority families, and attempted widening reject with bounded
  diagnostics.

- **Missing context** — A selected package, exact version, digest, project root, workflow model,
  declared tool, approval setting, sandbox profile, or budget field that cannot be proved rejects
  before execution.

- **Recovery mismatch** — Recovery and replay use the durable admitted snapshot. Missing, changed,
  reordered, or live-substituted policy evidence rejects rather than falling back to a catalog or
  network source.

### Interface contracts

- A policy package has one exact `policy-package`, name, semantic version, and SHA-256 identity.

- A manifest is strict, bounded, declarative YAML. It contains metadata and a closed set of
  narrowing constraints. It contains no executable field, URI, credential, hook, or evaluator.

- Policy layers compose as conjunction. Allowed sets use intersection. Numeric ceilings use the
  minimum. Mandatory approvals use logical OR. Composition is associative, commutative, and
  idempotent.

- A package can reject or narrow an admitted workflow. It cannot make any workflow, model, tool,
  permission, sandbox, approval, or budget valid when an existing layer rejects it.

- Operator configuration can require exact packages. Project configuration can add exact packages
  but cannot remove an operator package. Exact references are sorted and unique.

- The immutable capability snapshot carries every selected policy manifest and its trust,
  provenance, digest, and parsed definition. The snapshot remains the authority for child work,
  detached execution, recovery, and replay.

- The effective policy identity includes the exact package identities and their deterministic
  effective constraints. The supervisor and durable run state bind that identity before mutation.

- With no selected policy package, the existing policy digest, capability snapshot behavior, and
  workflow behavior stay unchanged.

## Current flow

```text
built-in policy
  + operator configuration
  + project configuration
  + workflow declarations
  -> fixed policy digest
  -> supervisor admission
  -> workflow compile and execution
  -> PolicyBroker decisions
```

Capability packages can supply skills, verifiers, command tools, and workflows. They cannot yet
supply reusable constraints. A reusable constraint therefore has no immutable identity across
attached, detached, child, recovery, and replay paths.

## Approaches considered

| Approach | Strength | Weakness | Disposition |
| --- | --- | --- | --- |
| One combined policy and UI package ABI | Covers the remaining roadmap sentence in one type | Flow has no stable UI host, so the ABI would encode speculative presentation coupling | Rejected |
| Declarative policy packages that only narrow | Reuses strict manifests, snapshots, bundles, recovery, and the existing broker; low authority increase | Requires careful algebra and admission wiring across config and workflow boundaries | **Selected** |
| TUF-style update layer first | Adds freshness, rollback protection, delegation, and compromise recovery | Solves artifact replacement, not policy meaning; introduces an online lifecycle before a policy ABI exists | Later issue |
| WASI component extensions first | Portable executable contract with capability-shaped imports | Adds code execution, host imports, runtime identity, and containment before declarative ecosystem work is complete | Later executable-extension issue |

## Challenged assumptions

### “Policy and UI contributions should share one manifest”

Rejected after tracing the repository. Policy has current config, broker, supervisor, workflow,
snapshot, and recovery consumers. UI has no equivalent host contract. A shared manifest would make
policy stability depend on a future presentation design.

### “A standard policy engine is safer than a small Flow schema”

Rejected for this slice. OPA and Cedar provide mature policy models, but importing an evaluator adds
new executable semantics, data loading, runtime limits, and compatibility authority. The required
first behavior is a small closed intersection over authority Flow already understands.

### “Last configuration wins is enough”

Rejected. Override order lets a project or later package undo an operator restriction. The public
contract requires an algebra in which adding a layer cannot widen the result.

### “A package digest alone proves the effective policy”

Rejected. Package digests prove exact inputs. The effective identity must also prove the canonical
composition and bind it to the supervisor and run. Both input identities and result identity are
needed for audit and recovery.

### “Signed installation solves policy freshness”

Rejected. A publisher signature and OCI digest prove exact publisher-authenticated bytes. They do
not prove that those bytes are the newest acceptable version or not revoked. Freshness and rollback
remain a separate update-system decision.

## Decision

Add a fifth inert capability type, `policy-package`. Define a strict manifest that narrows existing
model, tool, approval, sandbox, and workflow-budget authority. Reuse the established local catalog,
installed-bundle, immutable snapshot, and offline recovery pattern. Extend trusted configuration
with exact sorted package references. Compose every selected definition through one canonical
narrowing function before supervisor or run mutation.

Keep enforcement Flow-owned. Package data is validated at admission and projected onto existing
workflow and config contracts. The existing broker, command approval, sandbox, budget, provider,
and replay implementations remain the enforcement authorities. No public package field selects an
evaluator or executable.

## Completed RED → GREEN → REFACTOR sequence

1. **Manifest RED/GREEN** — Bind the strict inert schema, exact semantic identity, bounds, unknown
   field rejection, and canonical digest.

2. **Composition RED/GREEN** — Prove associativity, commutativity, idempotence, no widening, empty
   compatibility, contradiction handling, and stable effective identity.

3. **Snapshot and bundle RED/GREEN** — Add immutable policy snapshots and deterministic bundle
   entries. Reject altered bytes, metadata, definitions, order, duplicates, and digest drift.

4. **Catalog RED/GREEN** — Add safe project and installed discovery, exact selection, collision
   handling, source-drift rejection, and no-code inspection.

5. **Configuration RED/GREEN** — Add exact operator-required and project-added references. Resolve
   the immutable selected snapshot before supervisor mutation and preserve the no-selection digest.

6. **Workflow admission RED/GREEN** — Apply model, tool, permission, approval, sandbox, and budget
   constraints before provider, executor, or run-state mutation. Bind child, detached, recovery, and
   replay behavior to the admitted snapshot.

7. **CLI and docs RED/GREEN** — Add list, inspect, and validate behavior plus one worked package.
   Update README, roadmap, capability sourcing, workflow, recovery, security, testing, and examples.

8. **Adversarial and release verification** — Run property tests, mutation tables, full quality,
   runtime, coverage, package, dependency, documentation, graph, and hosted checks.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict inert manifest and exact identity | Contract/error | `npx vitest run test/unit/capability/policy-packages.test.ts` | Exact bounded manifests parse and freeze; unknown, executable, ambiguous, oversized, duplicate, and mutable input rejects | General-purpose policy languages |
| Narrowing algebra and deterministic effective identity | Property/security | `npx vitest run test/unit/policy/policy-package-composition.test.ts` | Permutations, duplicates, and grouping produce one result; added layers never widen; contradictions reject | Dynamic attribute-based policy |
| Immutable snapshot and bundle distribution | Data/recovery | `npx vitest run test/unit/capability/agent-skills.test.ts test/unit/capability/capability-bundles.test.ts` | Policy bytes, identity, trust, provenance, order, and digest round-trip; mutations reject | Freshness or automatic updates |
| Safe local and installed catalog | Integration/security | `npx vitest run test/unit/capability/local-policy-packages.test.ts` | Exact versions snapshot; unsafe entries, collisions, missing versions, and source drift fail without execution | Remote discovery |
| Operator and project selection | Config/security | `npx vitest run test/unit/config/resolver.test.ts test/integration/config/project-config.test.ts` | Required and added references compose canonically; projects cannot remove requirements; no-selection digest stays exact | Workflow-selected policy |
| Pre-mutation workflow enforcement | Behavioral/error | `npx vitest run test/unit/policy/policy-package-admission.test.ts test/integration/cli/policy-packages.test.ts` | Every authority family accepts admitted values and rejects a single-leaf contradiction before run/provider/executor mutation | New enforcement engines |
| Attached, detached, child, recovery, and replay identity | Recovery/integration | `npx vitest run test/integration/supervisor/worker.test.ts test/unit/run/policy-package-reducer.test.ts test/integration/cli/policy-packages.test.ts` | Exact durable snapshot is reused offline; changed, missing, or live-substituted evidence rejects | Catalog availability after admission |
| Signed OCI and HTTPS bundle compatibility | Distribution/regression | `npx vitest run test/unit/application/install-signed-oci-capability-bundle.test.ts test/integration/cli/capability-packages.test.ts` | Existing exact installers carry policy entries and later operations remain offline | Private registry credentials |
| Public documentation | Docs | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts test/integration/package/docs-ste.test.ts` | Authoring, selection, algebra, provenance, limits, recovery, and roadmap text match behavior | UI packages or updates |
| Release quality | Release/runtime | `npm run check && npm run test:coverage && npm run test:runtime && npm run pack:check && npm audit --omit=dev --audit-level=low` | Build, type, lint, full tests, coverage, runtime, package, docs, and dependency gates pass | Hosted service availability |

Every Issue #82 acceptance criterion maps to at least one row. Final verification must record
negative evidence, platform skips, untested paths, and any gap between local and hosted execution.

## Verification evidence

Local verification on 2026-08-13 produced the following evidence:

- The Issue #82 selector passed 129 tests across manifest parsing, algebra, config, catalogs,
  admission, CLI, replay, distribution, and the detached worker.

- The memory-bounded full suite passed 2,988 tests in 226 files. Four tests and one file used their
  declared skip conditions.

- Serial coverage passed with 82.54% statements, 76.42% branches, 89.14% functions, and 82.65%
  lines. The policy domain measured 98.33% statements and 94.03% branches.

- Type checking, the production build, scoped Biome formatting and lint, changed-document prose
  lint, 31 public-documentation tests, and `git diff --check` passed.

- Runtime verification passed 39 tests. Thirty-three tests used declared platform or configuration
  skips. Clean-package verification installed the generated tarball, executed the installed CLI,
  and reached the Prime runtime-preparation boundary.

- The aggregate `npm run check` stopped at its whole-tree formatter because unrelated user-owned
  `.claude` and `.codex` files and generated `graphify-out` caches are outside canonical formatting.
  Its product gates were run independently and passed. Those unrelated files are not part of this
  change.

- The managed environment denied `npm audit` because that request would disclose the production
  dependency graph to the public npm advisory endpoint without a separate informed authorization.
  The audit remains a hosted-CI or explicitly authorized network gate.

- Graphify rebuilt the repository graph from 445 code files. The graph contains 8,543 nodes and
  19,621 edges. Generated graph artifacts remain uncommitted.

## Primary references

- OPA bundle management: <https://www.openpolicyagent.org/docs/management-bundles>

- Cedar policy model: <https://docs.cedarpolicy.com/policies/syntax-operators.html>

- Cedar schema and validation: <https://docs.cedarpolicy.com/schema/schema.html>

- TUF specification: <https://theupdateframework.github.io/specification/latest/>

- VS Code contribution points: <https://code.visualstudio.com/api/references/contribution-points>

- WASI capability model: <https://github.com/WebAssembly/WASI/blob/main/docs/Capabilities.md>

- WebAssembly security: <https://webassembly.org/docs/security/>

- WebAssembly component model: <https://component-model.bytealliance.org/>
