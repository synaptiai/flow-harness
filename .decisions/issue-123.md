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
| Link and anchor integrity | `npm run docs:links` | Every tracked relative Markdown link and local anchor resolves |
| Safety and prerequisite preservation | Focused content tests and review | Pre-alpha, hostile-workload, Prime-host, recovery, and authority warnings remain discoverable |
| Public prose | `npm run docs:ste` | Changed prose passes the repository style rules |
| Repository quality | `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build && npm run pack:check` | No code, package, or release regression |

## Verification evidence

The final README has 154 lines and 6,683 bytes. The previous README had 1,776 lines and 100,936
bytes.

The focused public-documentation command passed 45 tests across four files:

```sh
npx vitest run test/integration/package/docs-links.test.ts \
  test/integration/package/documentation-structure.test.ts \
  test/scaffold/community-files.test.ts \
  test/integration/package/prime-agent-package.test.ts
```

The complete serial suite passed 4,333 tests across 314 files. Four tests were skipped by their
declared platform or runtime conditions:

```sh
npm test -- --maxWorkers=1
```

These final gates also passed:

```sh
npm run docs:links
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
