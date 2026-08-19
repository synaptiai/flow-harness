# Decision Journal: Issue #123 — Restructure public documentation around reader tasks

**Issue**: #123 | **Branch**: `codex/issue-123-documentation-architecture` | **Started**: 2026-08-19

---

## Specification

### Reader flows

| Reader | Trigger | Required path | Outcome |
| --- | --- | --- | --- |
| New user | Opens the repository | Purpose → maturity → safety → prerequisites → first run | Can assess Flow and complete one credential-free run |
| Operator | Needs to run or recover work | Configuration → run control → approvals → recovery | Can perform the task without reading internal architecture |
| Prime operator | Needs the higher-isolation profile | Dedicated-host warning → exact prerequisites → provisioning → preparation → verification → rollback | Can prepare or reject a host safely |
| Workflow author | Needs an executable graph | Examples → workflow specification → configuration | Can author and validate a workflow |
| Capability author | Needs a portable package | Package guide → sourcing contract → examples | Can create, distribute, inspect, and activate inert capability bytes |
| Evaluator | Needs comparative evidence | Evaluation quick start → plan contract → candidate and activation guidance | Can run a reproducible comparison without contaminating holdouts |
| Contributor | Needs to change Flow | Contribution rules → architecture → testing → release gates | Can prepare a reviewable change |

### Non-goals

- Do not change runtime behavior, CLI grammar, schemas, policy, or compatibility promises.
- Do not introduce a hosted documentation site or a documentation framework.
- Do not move established reference paths only to create a visual directory hierarchy.
- Do not copy normative workflow, recovery, or security contracts into task guides.
- Do not retain detailed runbooks in the README for backward compatibility.

### Failure modes

| Failure mode | Required behavior |
| --- | --- |
| Broken relative file link | Documentation gate fails with the source path and target |
| Broken local anchor | Documentation gate fails with the source path and anchor |
| External URL, generated fragment, or example placeholder | Link gate identifies it as outside local-file validation |
| Duplicate topic ownership | Documentation hub names one canonical document and guides link to it |
| Lost safety warning or prerequisite | Focused preservation review blocks the change |
| README growth resumes | Structure test enforces the landing-page scope and bounded size |
| Old external link to an established document | Existing top-level reference paths remain stable |
| New user follows contributor or Prime setup by mistake | Getting started contains only ordinary source-preview requirements and one credential-free run |

## Decision

### Selected approach

Use a concise root README, a canonical `docs/README.md` hub, focused task guides, and stable detailed references.

```text
README
  -> Getting started
  -> Documentation hub
       -> Guides
       -> Operations
       -> Concepts and specifications
       -> Development and project status
```

The README owns project orientation, maturity, a short capability summary, one first run, safety routing, community links, and license information.

The documentation hub owns audience routing and topic ownership. New task documents use `docs/guides/` and `docs/operations/`. Existing architecture, workflow, recovery, configuration, ACP, evaluation, testing, sourcing, and roadmap paths remain stable.

### Approaches considered

| Approach | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| Reader-journey hub plus focused guides | Clear navigation, stable references, low duplication, incremental growth path | Requires disciplined topic ownership and link checks | **Selected** |
| Move every document into category directories | Visible hierarchy in the filesystem | Breaks external links and creates compatibility stubs without improving content | Rejected |
| Prune the README only | Small immediate diff | Leaves the flat docs collection hard to navigate and invites regression | Rejected |
| Adopt a hosted documentation framework now | Search, navigation, and versioned site options | Adds build, deployment, theme, and maintenance scope before a stable release | Deferred |

### Consequences

- The README becomes a landing page rather than a manual.
- New users no longer need Prime, provider, or contributor setup for the first run.
- Detailed contracts retain their established locations and review history.
- New feature documentation must choose one owner in the hub before adding prose.
- Link and structure checks become release gates.

### Documentation style baseline

Public documentation follows the Google Developer Documentation Style Guide after applying Flow's
project-specific contract and security rules. The repository stores this decision in two durable
forms:

- `AGENTS.md` gives repository-scoped instructions to future automated contributors.
- `docs/documentation-style.md` gives public guidance to human and automated contributors.

The `docs:style` gate scans the complete public Markdown set for objective rules. It checks heading
structure and sentence case, descriptive links, image alternatives, directional references, and a
small set of prohibited constructions. Human review remains responsible for active voice, second
person, global readability, inclusive language, technical accuracy, and topic ownership.

### Architecture visualization

The canonical architecture document now starts with a C4-style context and component overview in
stable Mermaid flowchart syntax. It answers six reader questions. The view shows who uses Flow,
where requests enter, which components decide and execute, what survives interruption, and which
systems remain external.

Three approaches were evaluated:

| Approach | Strengths | Costs and risks | Decision |
| --- | --- | --- | --- |
| One plain-language context/component flowchart plus the existing detailed reference | Accessible first view, standard Mermaid rendering, and direct mapping to the repository | Cannot show every subsystem or call | **Selected** |
| Mermaid C4 diagram syntax | More formal architecture vocabulary | Newer syntax has less uniform renderer support and is harder for first-time readers | Rejected |
| Separate diagram for every subsystem | Maximum local detail | Duplicates the existing prose, raises maintenance cost, and obscures the complete flow | Deferred until a subsystem needs a task-specific diagram |

The diagram maps every top-level runtime module and `prime-container/`. Repository instructions,
the style policy, and the contributor guide require updates for structural changes. These changes
include entry points, runtime modules, execution boundaries, durable stores, external dependencies,
and ownership relationships. A focused test enumerates the runtime modules. It also binds the
diagram groups and maintenance contract. Official Mermaid CLI 11.16.0 rendered every diagram after
the review replaced one legacy reserved node identifier.

## Implementation plan

1. Add the documentation hub and current-status document.
2. Add focused getting-started, operator-control, capability, and Prime runbooks.
3. Replace the README with a concise landing page and credential-free quick start.
4. Update contribution and cross-document links.
5. Add local file and anchor validation plus a bounded README structure check.
6. Run documentation, static, test, build, package, and adversarial review gates.

## Verification map

| Criterion | Verification | Required evidence |
| --- | --- | --- |
| README scope and first run | Documentation structure tests and command review | Concise landing page; no host runbook or exhaustive reference |
| Hub and category coverage | Documentation structure tests | Every public document appears in one reader-oriented category |
| Link and anchor integrity | `npm run docs:links` | Every relative Markdown link and local anchor in the defined public corpus resolves |
| Safety and prerequisite preservation | Focused content tests and review | Pre-alpha, hostile-workload, Prime-host, recovery, and authority warnings remain discoverable |
| Public prose | `npm run docs:ste` | Changed prose passes the repository style rules |
| Google documentation style | `npm run docs:style` and `test/integration/package/docs-style.test.ts` | The complete public corpus passes objective style rules and each rule has a negative regression |
| Architecture overview and currentness | `npx vitest run test/integration/package/architecture-documentation.test.ts` | Plain-language Mermaid overview; every runtime module and Prime container mapped; update contract retained |
| Repository quality | `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build && npm run pack:check` | No code, package, or release regression |

## Verification evidence

The final README has 154 lines and 6,683 bytes. The previous README had 1,776 lines and 100,936
bytes.

The focused public-documentation command passed 62 tests across six files:

```sh
npx vitest run test/integration/package/docs-links.test.ts \
  test/integration/package/docs-style.test.ts \
  test/integration/package/architecture-documentation.test.ts \
  test/integration/package/documentation-structure.test.ts \
  test/scaffold/community-files.test.ts \
  test/integration/package/prime-agent-package.test.ts
```

The complete serial suite passed 4,344 tests across 315 files after the style policy and checker
were implemented. Four tests were skipped by their declared platform or runtime conditions:

```sh
npm test -- --maxWorkers=1
```

These final gates also passed:

```sh
npm run docs:links
npm run docs:style
npm run docs:ste
npm run typecheck
npm run build
npm run format:check
npm run lint
npm run pack:check
git diff --check
```

Lint retained one pre-existing informational note in
`src/application/external-harness-adapter.ts`. It produced no error or changed file.

The first complete-suite attempt ran inside a desktop sandbox that denied temporary Unix sockets.
The unrestricted local rerun passed. The same permission was required for the clean package smoke
test, which installed the generated tarball and exercised the packaged CLI successfully.

The final refinement made discovery automatic for root documents, `docs/`, contributor-facing
`.github/` Markdown, and public example documentation. It excludes executable evaluation task and
result artifacts, internal decision journals, test fixtures, generated files, and vendored content.
The refinement also moved documentation checks earlier in local CI. The architecture overview adds
four focused currentness tests, bringing the final-tree command to 62 tests. A second complete run
against the earlier tree was killed with exit 137 while unrelated Vitest pools were active on the
host. Four unchanged tests had reached their fixed timeouts.

One timed-out supervisor case passed an isolated rerun. Three filesystem-heavy cases reached the
same timeout while the other pools remained active. No documentation test failed.
