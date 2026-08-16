# Decision Journal: Issue #99 — A2UI-profile presentation packages

**Issue**: #99 | **Branch**: `codex/issue-99-a2ui-presentation-packages` | **Started**: 2026-08-16

---

## Context

Issue #95 established a first-party terminal host and a strict public presentation document. Flow
still lists UI packages as planned. The remaining design question is whether a package can customize
presentation without acquiring data-selection, action, execution, or durable-run authority.

The user approved a host-slot architecture and asked that Flow prefer relevant standards. This issue
therefore adopts a constrained A2UI v0.9.1 custom-catalog profile. ACP v1 is recorded as a future
agent-client transport seam, not as the presentation schema.

## Standards evidence

- [A2UI v0.9.1](https://a2ui.org/) is the current production release. It defines declarative
  surfaces and client-owned catalogs without executing arbitrary code.

- [A2UI custom catalogs](https://a2ui.org/guides/defining-your-own-catalog/) let a client restrict
  surfaces to the exact native components it implements.

- The general [A2UI v0.9.1 protocol](https://a2ui.org/specification/v0.9.1-a2ui/) also permits literals,
  JSON-pointer bindings, functions, dynamic children, themes, and action context. The Flow package
  profile forbids those broader features.

- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) standardizes JSON-RPC communication
  between coding agents and clients. Its session features fit a future editor adapter. ACP does not
  define this static layout package ABI.

## Architecture alternatives

| Approach | Standard fit | Authority fit | Cost | Decision |
| --- | --- | --- | --- | --- |
| Flow host slots with a strict A2UI custom catalog | Strong | Closed | Moderate | **Selected** |
| Unrestricted A2UI basic-catalog surfaces | Strong | Too broad | High | Rejected |
| Flow-only layout manifest with later export | Partial | Closed | Low | Rejected: defers interoperability |
| ACP custom session updates carrying layout | Weak | Couples transport to layout | High | Rejected |
| Executable HTML, JavaScript, or Wasm package | None required | Expansive | Very high | Rejected |

The selected form stores one static A2UI surface skeleton using a pinned Flow catalog. Its six leaf
components are opaque host widgets. Closed layout containers express order, grouping, and density.
Flow supplies all public values and action identities at render time.

## Specification

### Non-goals

- Full A2UI basic-catalog support or runtime agent-generated surfaces.
- Arbitrary text, bindings, functions, actions, themes, data models, inline catalogs, code, assets,
  or remote resources.

- ACP client/server support or a custom ACP extension.

- Durable presentation selection, workflow authority, policy authority, replay coupling, automatic
  updates, version ranges, or executable extensions.

### Failure modes

- Cancellation wins before later reads or mutation. Atomic publication/settlement wins after
  ownership, and uncertain commits remain explicit.

- Invalid, excessive, ambiguous, drifted, raced, symlinked, or colliding sources fail closed before
  terminal ownership or supervisor mutation.

- Package values and nested causes never enter public output. No invalid selected package silently
  falls back after the session starts.

- Renderer, action, event, and cleanup failures retain Issue #95 precedence and exact-once cleanup.

### Interface contracts

- `PresentationPackage` uses `flow.synapti.ai/v1alpha1` and embeds exactly one A2UI v0.9
  `createSurface` followed by one `updateComponents` for the fixed Flow catalog and surface. The
  profile targets the production A2UI v0.9.1 release.

- The component graph contains one root layout, bounded groups, and exactly one of every opaque Flow
  widget. It is acyclic, reachable, duplicate-free, and contains no runtime data or actions.

- `PresentationPackageSnapshot` is immutable, digest-addressed, exact-version selected, and scoped to
  one TUI session. It is not a `CapabilitySnapshot` member.

- Local and installed discovery reuse Flow's no-follow, bounded, exact-snapshot package boundaries.

- `flow tui --presentation <name>@<version>` resolves before supervisor or terminal mutation.

## Criterion verification map

| Criterion | Verification | Negative boundary |
| --- | --- | --- |
| Strict A2UI profile and digest | `test/unit/capability/presentation-packages.test.ts` | General A2UI authority, graph errors, bounds, tampering |
| Local and installed discovery | `test/unit/capability/local-presentation-packages.test.ts` | Links, races, cancellation, collisions, drift |
| Bundle distribution | `test/unit/capability/capability-bundles.test.ts test/integration/cli/capability-packages.test.ts` | Wrong kind, invalid manifest, decoded bounds, deterministic packing |
| CLI review and TUI selection | `test/integration/cli/presentation-packages.test.ts test/integration/cli/tui.test.ts` | Grammar, privacy, pre-mutation failure, default parity |
| Layout and host parity | `test/unit/presentation/presentation-package-projector.test.ts test/unit/application/run-presentation-session.test.ts test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts` | Missing/duplicate widgets, action mutation, runtime data, default spacing |
| Dependency boundaries | `test/integration/package/dependency-boundaries.test.ts` | Domain/application imports infrastructure or A2UI renderer runtime |
| Public documentation | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts` | Planned/implemented status conflict |

## Activity log

- 2026-08-16: PR #98 merged after all hosted checks passed. Issue #97 was closed.

- 2026-08-16: User approved Approach A and requested standards alignment. Official A2UI and ACP
  specifications were reviewed. The strict custom-catalog profile was selected.

- 2026-08-16: Domain RED tests added before production implementation.

- 2026-08-16: Local and installed catalog discovery and deterministic bundle distribution were
  implemented. The change also added exact TUI selection and host-owned projection.
- 2026-08-16: The public catalog schema, documentation, and source-race defenses were completed.

- 2026-08-16: Final adversarial review added a physically bounded manifest reader and full
  authority-chain revalidation. It also added fixed diagnostics and mutation-resistant evidence.

- 2026-08-16: Official A2UI schema validation corrected the patch-release distinction. The profile
  now emits `version: v0.9` and uses canonical `/v0_9/` references. It validates offline through the
  standard envelope and the Flow catalog seam.

- 2026-08-16: Final review restored default-host spacing and closed future projection drift. It also
  added exact manifest-handle settlement and value-free filesystem diagnostics.

## Verification evidence

The exact mapped selector passed 191 tests across 12 files:

```sh
npx vitest run test/unit/capability/presentation-packages.test.ts \
  test/unit/capability/local-presentation-packages.test.ts \
  test/unit/capability/capability-bundles.test.ts \
  test/unit/capability/installed-capability-catalog.test.ts \
  test/unit/presentation/presentation-package-projector.test.ts \
  test/unit/application/run-presentation-session.test.ts \
  test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts \
  test/integration/cli/presentation-packages.test.ts \
  test/integration/cli/capability-packages.test.ts \
  test/integration/cli/tui.test.ts \
  test/integration/package/dependency-boundaries.test.ts \
  test/scaffold/community-files.test.ts
```

The frozen full serial coverage suite passed 3,655 tests with 4 platform skips across 258 files.
Coverage was 83.75% statements, 77.91% branches, 90.24% functions, and 83.86% lines.

`npm run typecheck`, `npm run build`, `npm run format:check`, `npm run lint`, `npm run docs:ste`,
and `git diff --check` passed. Lint reported only the inherited informational constructor note in
`src/application/external-harness-adapter.ts`. The isolated runtime gate passed 39 tests with 34
platform skips across 18 files. `node scripts/smoke-compiled.mjs` passed with local Unix-socket
permission. `npm run pack:check` installed and exercised the packed tarball successfully with policy
digest `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

`npm audit --omit=dev --audit-level=low` reported zero vulnerabilities. The Prime dependency audit
passed for the Node lock and 60 Python packages.
