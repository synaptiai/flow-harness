# Decision Journal: Issue #119 — Bounded attributed presentation-package content

**Issue**: #119 | **Branch**: `codex/issue-119-a2ui-package-content` | **Started**: 2026-08-18

---

## Context

Issue #99 established exact inert presentation packages that arrange six host-owned run widgets
through a strict Flow custom-catalog profile of A2UI v0.9.1. Issue #101 later applied the same
public presentation document to a first-party local browser. The current package profile deliberately
forbids package-provided text. Issue #119 adds a small, reviewable content seam without granting
packages data-selection, action, execution, protocol, or durable-run authority.

The user approved refined Approach A: an additive A2UI custom-catalog revision with bounded static
notes. Existing catalog-v1 packages remain unchanged. Only the terminal and local browser render
the notes, using existing host-owned presentation primitives. ACP remains a separate standard
transport and does not carry this content.

## Standards evidence

- A2UI v0.9.1 remains the current production family. A2UI v1.0 is a release candidate. This issue
  does not force a compatibility migration solely to gain content support.

- A2UI custom catalogs let Flow define direct, closed component properties. The general v0.9 Basic
  Catalog `Text` component accepts `DynamicString` and Markdown. That broader component is outside
  the approved authority boundary.

- ACP v1 standardizes agent-client sessions, updates, and permissions. It does not define Flow's
  presentation package ABI. The existing ACP projection remains intentionally content-blind.

- TUF authenticates distributed package metadata and targets, but application activation policy
  remains Flow-owned. Existing exact publisher, content-addressed store, and offline rules apply.

## Architecture alternatives

| Approach | Compatibility | Authority | Standards fit | Decision |
| --- | --- | --- | --- | --- |
| Add one static-note component in a new Flow A2UI catalog | Strong | Closed | Strong | **Selected** |
| Mutate the existing catalog in place | Weak: changes the meaning of v1 | Closed | Moderate | Rejected |
| Use A2UI Basic Catalog `Text` | Moderate | Too broad: dynamic strings and Markdown | Strong | Rejected |
| Add content fields to the public presentation ABI | Requires a second renderer contract | Closed | Weak | Rejected |
| Transport content through ACP extensions | Couples presentation to agent transport | Expansive | Weak | Rejected |

## Approved design

- Preserve `https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1` exactly.

- Add `https://flow.synapti.ai/a2ui/catalogs/run-presentation/v2` in the same A2UI v0.9 protocol
  family.

- Catalog v2 adds exactly one `FlowPackageNotes` leaf. It contains one to four direct literal
  `{title, body}` entries and is the final direct child of the root layout.

- A title is at most 128 UTF-8 bytes. A body is at most 1,024 UTF-8 bytes. All note text is at most
  4,096 UTF-8 bytes in aggregate. Every string must satisfy Flow safe-display-text rules.

- The content leaf accepts no bindings, functions, actions, themes, links, URLs, or assets. It also
  accepts no data models, dynamic children, inline catalogs, code, markup, or remote resources.

- Projection appends one host-owned section with id `presentation-package-content`, an exact
  package-identity title, a fixed provenance notice, and existing heading/info-notice components.

- The projection preserves `run`, `actions`, `truncated`, layout behavior, and all authoritative
  host sections. Catalog-v1 packages add no section and keep their existing digest and rendering.

- Terminal and local browser render the existing presentation primitives. The browser keeps using
  DOM `textContent`. The terminal keeps using safe terminal text.

- ACP validates the public presentation document but ignores the package-content section. It gains
  no option, extension, update type, or dependency.

## Specification

_Captured by specification-capture skill on 2026-08-18. Source: user-confirmed._

### Non-goals

- Agent-generated, remotely streamed, or automatically activated surfaces.
- Markdown, HTML, CSS, JavaScript, Wasm, native code, hooks, templates, assets, links, URLs,
  bindings, functions, arbitrary events, themes, or remote resources.
- A2UI Basic Catalog support or migration to the A2UI v1.0 release candidate.
- Durable presentation selection, workflow or policy authority, action authority, replay or
  recovery coupling, detached-worker requirements, or automatic version selection.
- ACP extensions, custom methods, or presentation-content transport over ACP.

### Failure modes

- **Timeouts** — The new parser and projector perform no external or unbounded wait. Existing
  discovery, browser, and supervisor deadlines remain unchanged and package content cannot extend
  them.

- **Partial failures** — Failure before terminal/browser ownership or supervisor mutation publishes
  nothing. After an existing atomic or host-ownership boundary, existing settlement, cleanup, and
  primary-error precedence remain authoritative.

- **Invalid input** — Unsupported catalog versions, unsafe text, excessive text, and unknown members
  fail closed. Ambiguous placement, missing content, graph errors, source drift, and tampering also
  fail closed. Errors are fixed and value-free. No selected package silently falls back after host
  ownership.

- **Missing context** — An absent, ambiguous, uninstalled, or policy-incompatible exact selection
  fails before host mutation. Omitting `--presentation` preserves the existing default view.

- **Cancellation** — Cancellation before an owned mutation stops all later reads and preserves the
  exact caller reason. Settlement wins after an owned atomic boundary.

- **Privacy** — Package metadata, source paths, note text, raw package bytes, and nested causes never
  enter public errors. Valid note text is intentionally public only in inspect and selected
  first-party presentation output.

### Interface contracts

- Presentation-package API version and exact `<name>@<version>` selection syntax remain unchanged.

- Catalog v1 has its existing closed graph, accepted manifests, canonical identity, and digest.

- Catalog v2 is an additive strict union member in the A2UI v0.9 protocol family. Its graph contains
  every host widget exactly once plus one final direct package-notes leaf exactly once.

- `PresentationPackageSnapshot` remains immutable, reconstructible from its exact manifest,
  digest-addressed, content-addressed in installed bundles, and absent from durable run authority.

- `FlowPresentationDocument` remains version 1. Notes project into existing safe section and
  component shapes. The provenance boundary is fixed. Packages control no component kind, tone,
  action, or section identity.

- Terminal and browser render only validated `FlowPresentationDocument` values. ACP continues to
  project only plan, status, and permissions and ignores the attributed content section.

- Existing publisher authentication, package replacement, audit, removal, no-follow discovery,
  cancellation, race detection, and offline snapshot rules apply unchanged.

## Criterion verification map

| # | Acceptance criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- | --- |
| 1 | Exact selection renders bounded static notes in terminal and browser | UI / behavioral | `npx vitest run test/unit/presentation/presentation-package-projector.test.ts test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts test/browser/local-browser-presentation.browser.test.ts` | Attributed note title/body render as inert text in both hosts | Remote or third-party renderers |
| 2 | Content is visibly attributed and distinct from Flow authority | Behavioral / UI | `npx vitest run test/unit/presentation/presentation-package-projector.test.ts test/unit/infrastructure/terminal/flow-terminal-renderer.test.ts test/browser/local-browser-presentation.browser.test.ts` | Fixed package identity and provenance notice appear; actions/run remain exact | Custom package styling or tone |
| 3 | Existing packages preserve identity and rendering | Contract | `npx vitest run test/unit/capability/presentation-packages.test.ts test/unit/presentation/presentation-package-projector.test.ts` | Fixed v1 digest/snapshot and v1 projection regressions pass | Compatibility with unrestricted A2UI catalogs |
| 4 | Content remains plain, static, and closed | Contract / error | `npx vitest run test/unit/capability/presentation-packages.test.ts` | Official envelope/catalog validation passes; dynamic/markup/action/binding/theme/resource mutations reject | Markdown or rich text |
| 5 | UTF-8, count, aggregate, safety, and placement limits fail closed | Contract / error | `npx vitest run test/unit/capability/presentation-packages.test.ts` | Exact-bound positives and +1/unsafe/duplicate/misplaced negatives pass | Locale-specific typography beyond safe text |
| 6 | Invalid selection fails before host or supervisor mutation | Error handling | `npx vitest run test/integration/cli/tui.test.ts test/integration/cli/web.test.ts test/integration/cli/presentation-packages.test.ts` | Invalid v2 content produces fixed errors with zero renderer/listener/supervisor mutations | Recovery after host ownership |
| 7 | Content does not alter run, actions, replay, recovery, workers, or events | Behavioral | `npx vitest run test/unit/presentation/presentation-package-projector.test.ts test/integration/cli/tui.test.ts test/integration/cli/web.test.ts` | Run/actions/truncation remain exact and no durable selection is recorded | Persisted UI preferences |
| 8 | ACP behavior and output remain unchanged | Contract / behavioral | `npx vitest run test/unit/infrastructure/acp/flow-acp-presentation.test.ts` | ACP projections are byte-equivalent with and without package content; note canaries are absent | A custom ACP presentation extension |
| 9 | Distribution and offline review preserve exact identity | Data / behavioral | `npx vitest run test/unit/capability/capability-bundles.test.ts test/unit/capability/local-presentation-packages.test.ts test/integration/cli/capability-packages.test.ts test/integration/cli/presentation-packages.test.ts` | Local/installed/bundled v2 snapshots retain exact digest/content and work offline | Automatic updates or version ranges |
| 10 | Cancellation, races, links, collisions, and partial installs remain fail closed | Error handling | `npx vitest run test/unit/capability/local-presentation-packages.test.ts test/unit/capability/capability-bundles.test.ts test/integration/cli/capability-packages.test.ts` | Existing source/store adversarial matrix also exercises v2 without publication or network fallback | Cross-host filesystem guarantees |
| 11 | Public documentation matches authoring, trust, limits, recovery, and ACP boundaries | Documentation | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts` | Changed prose passes STE checks and repository-contract assertions name both catalogs and boundaries | A2UI v1.0 migration guidance |
| 12 | Mapped, schema, UI, package, runtime, dependency, and full gates pass | Configuration / runtime | `npm run typecheck && npm run build && npm run format:check && npm run lint && npm run test -- --maxWorkers=1 && npm run test:browser && npm run test:runtime && npm run pack:check && npm audit --omit=dev --audit-level=low && npm run docs:ste && git diff --check` | Every command exits zero; platform skips are recorded honestly | Hosted Prime authority on non-Linux platforms |

## Planned TDD slices

1. RED/GREEN the catalog-v2 domain contract, exact limits, official A2UI validation, v1 identity
   fixture, and immutable snapshot helpers.
2. RED/GREEN projection of the fixed attributed section while proving v1 and host authority parity.
3. RED/GREEN terminal, browser, CLI pre-mutation, and ACP non-exposure behavior.
4. RED/GREEN local/installed/bundled identity and offline behavior, then update public documentation.
5. Run the mapped selector, browser/runtime/package checks, full serial/coverage quality gates, and a
   zero-finding adversarial review.

## Activity log

- 2026-08-18: User approved refined Approach A after standards and authority comparison.

- 2026-08-18: Issue #119 created after open/closed duplicate search. Closed Issue #99 is the
  predecessor, not a duplicate.

- 2026-08-18: Clean branch created from `origin/main` at `8ed8816281ea40a42f2e0df10aeedab3e217cea4`.

- 2026-08-18: Domain RED produced four expected failures. Catalog v2 was unsupported, its public
  schema was absent, and the note accessor was absent. All 29 legacy tests passed in the RED run.

- 2026-08-18: Catalog-v2 GREEN passed 33 domain tests. Type checking, scoped Biome, and diff checks
  also passed. The slice preserves a fixed catalog-v1 digest.

- 2026-08-18: Projection RED proved that parsed v2 notes did not reach the public document.
  Projection GREEN appends one attributed host-owned section and preserves run, action, truncation,
  and layout authority. The combined domain and projector selector passed 38 tests.

- 2026-08-18: Terminal and ACP host checks passed 20 tests. The real authenticated browser host
  passed two tests with loopback permission. Desktop, tablet, and mobile screenshots show visible
  attribution, literal markup text, responsive layout, separate actions, and no console errors.

- 2026-08-18: Distribution and selection checks passed 46 tests across four files. Evidence covers
  public inspect output and deterministic bundle bytes. It also covers installed offline TUI use
  and local browser use. Invalid content rejects before supervisor or renderer ownership.

- 2026-08-18: Public authoring, trust, ACP, recovery, and testing documentation is updated. It now
  distinguishes the layout-only v1 catalog from the bounded attributed-content v2 catalog. The repository prose
  gate and the 29-test community contract pass. Recovery remains session-local. An exact installed
  package remains available offline through the existing content-addressed store.
