# Decision Journal: Issue #177 — Qualify Flow 0.1.0-alpha.2

**Issue**: #177 | **Branch**: `codex/issue-177-alpha2-checkpoint` | **Started**: 2026-08-24

---

## Context

Flow `0.1.0-alpha.1` proved the immutable release, provenance, and protected-preview path. The
current source now includes the public quickstart, installation doctor, browser presentation, and
Gate 9–10 capability surfaces that the first alpha didn't contain. The project needs a second
usability checkpoint that people can install and evaluate, but this issue stops before publication.

Release identity is currently repeated across the package manifest, shrinkwrap, workflow artifact
names, attestation bundle name, release tag, title, and release notes. Hand-maintained copies can
silently diverge. The approved design makes `package.json` the only reviewed version authority,
validates every independent declaration against it, and derives every operational name from the
validated value.

## Existing evidence

- The exact main commit before this branch passed the ordinary hosted CI jobs. The unusually long
  proof-runtime job completed successfully.

- GitHub immutable releases are enabled. The `preview-release` environment accepts only `main`,
  requires the repository owner as a reviewer, and doesn't allow administrator bypass.

- `npm run pack:check` already builds the npm archive, installs it into an isolated project, and
  verifies discovery, quickstart, doctor, browser presentation, capability documentation, and the
  Prime process boundary without model credentials.

- The current archive contains 1,418 entries, is about 2.32 MB packed and 13.14 MB unpacked, and is
  below all configured file-count and size ceilings.

- The preview workflow already rebuilds one clean archive, transfers it to Ubuntu 24 x64 and macOS
  15 Intel, verifies its digest and installed behavior, creates a GitHub attestation, and gates the
  optional publication job behind both a Boolean dispatch choice and the protected environment.

- `@synaptiai/flow-harness` is not published to npm. `v0.1.0-alpha.1` is the only existing release
  tag and remains immutable historical evidence.

## Approved architecture

### Manifest-derived release identity

`package.json` contains the single release version. A dependency-free Node script reads that
manifest from the repository root, accepts only the reviewed Flow alpha version grammar, and
derives these values:

- package name and version;
- Git tag `v<version>`;
- npm archive name from the scoped package name and version;
- attestation bundle `flow-harness-<version>.intoto.jsonl`;
- release title `Flow <version>`; and
- canonical release-notes path `docs/releases/<version>.md`.

The resolver reopens `npm-shrinkwrap.json` and the canonical release notes without following
symbolic links, enforces bounded regular-file reads, and requires all root package declarations and
the notes heading to match the manifest. It emits only fixed GitHub output keys whose values have
already passed strict character and length validation. Missing, malformed, linked, oversized, or
inconsistent metadata fails before archive preparation, attestation, or publication.

The prepare job exports the validated identity as job outputs. Verification, attestation, and
publication consume those outputs. The workflow dispatch accepts only the existing Boolean
`publish` choice; it doesn't accept a version, tag, title, archive, or notes override.

### Exact-source and exact-archive qualification

The prepare job requires successful CI for the exact `main` commit and verifies a clean source
tree. It creates one npm archive and one release-evidence document, checks the archive bounds, and
publishes them only as short-lived workflow artifacts. Ubuntu 24 x64 and macOS 15 Intel download
that same archive, confirm its digest against the evidence, install it into fresh temporary
projects, and run the installed-package verification suite.

The attestation job signs the qualified archive digest and verifies the downloaded attestation
bundle against the repository identity. The nonpublishing path ends after this qualification. It
must not create a tag, GitHub release, npm version, or npm dist-tag.

### Publication guardrails retained for a later approval

The optional GitHub publication job remains protected by the `preview-release` environment and
exact `main` branch policy. Before any future publish, an owner must confirm that GitHub immutable
releases are enabled. The job rejects an existing Git tag or GitHub release, and the runbook
distinguishes an unused npm version (`E404`) from registry authentication, availability, or
transport failures. The job creates a GitHub prerelease that isn't latest. The established
exact-artifact bridge then requires a maintainer to publish those verified bytes through an
interactive npm session with two-factor authentication under the `preview` dist-tag. CI receives
no npm publication token and never moves `latest`.

No publication is authorized by this issue or its pull request.

### Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Replace every `alpha.1` literal with `alpha.2` | Small diff | Preserves multiple authorities and makes future drift likely | Rejected |
| Derive identity from `package.json` and validate independent declarations | One reviewed authority, reusable guardrails, early deterministic failure | Adds a small resolver and negative tests | Approved |
| Accept a dispatch-supplied version or tag | Convenient for operators | Lets mutable input disagree with reviewed source and weakens exact-commit evidence | Rejected |
| Automatically increment the prerelease version | Less manual editing | Makes version assignment a CI side effect and complicates retries and auditability | Rejected |

## User, operator, and system flows

### Prepare the checkpoint

1. A maintainer reviews the version change in `package.json`, the matching shrinkwrap metadata,
   and the canonical release notes in one pull request.
2. The identity resolver validates those files and derives all operational names.
3. The repository runs the focused release tests, documentation gates, complete local CI, package
   verification, and high-severity dependency audit.
4. The pull request is reviewed and merged only when no P1, P2, or P3 finding remains.

### Run the nonpublishing hosted preview

1. The operator dispatches the preview workflow on the exact clean `main` commit with publication
   disabled.
2. Flow confirms that ordinary CI passed for the same commit, resolves identity, and prepares one
   bounded archive.
3. Ubuntu and macOS verify the same archive independently.
4. GitHub creates and verifies the repository attestation.
5. The workflow ends without entering the protected publication environment or creating public
   release state.

### Publish later, under separate approval

1. The operator obtains explicit approval to publish the already-qualified version.
2. The workflow is dispatched on `main` with publication enabled and waits for protected-environment
   review.
3. It rechecks all exact-commit, identity, immutability, unused-version, provenance, and prerelease
   conditions immediately before mutation.
4. It publishes the immutable GitHub prerelease. A separately authorized maintainer verifies those
   exact bytes, bootstraps the npm version with two-factor authentication under `preview`, and
   confirms that `latest` didn't move.

## Coupling analysis

- `package.json` owns the reviewed package identity. It doesn't contain workflow-specific names.

- The identity resolver owns strict parsing, cross-file consistency, bounded no-follow reads, and
  pure name derivation. It doesn't build, sign, upload, or publish anything.

- `npm-shrinkwrap.json` remains npm's reproducible dependency and installed-root metadata. It is a
  checked declaration, not a second version authority.

- The preview workflow owns exact-commit gating, host qualification, artifact transfer,
  attestation, environment approval, and publication ordering. It consumes resolved identity and
  can't override it.

- Release preparation and verification own archive bytes, bounds, contents, evidence schema, and
  digest agreement. They don't choose a release version.

- Release notes own public-facing changes, compatibility boundaries, installation and verification
  guidance. Historical alpha notes remain unchanged.

## Specification

_Captured by specification-capture skill on 2026-08-24. Source: user-confirmed._

### Non-goals

- No Git tag, GitHub release, npm package version, or npm dist-tag is published in this issue.

- No operator-supplied, workflow-supplied, date-derived, Git-derived, or automatically incremented
  release identity is accepted.

- No stable API, migration, backward-compatibility, or production-readiness promise is added.

- No release condition is weakened: exact-main CI, archive limits, multi-host verification,
  provenance, immutable releases, protected environment approval, prerelease status, and the
  non-latest npm tag remain required.

- No catalog segmentation, remote execution, multitenant isolation, or unrelated roadmap feature
  is included.

### Failure modes

- **Missing or invalid metadata** — Missing, linked, oversized, malformed, unsupported, or
  inconsistent manifest, shrinkwrap, or release notes fail before archive preparation.
- **Exact CI unavailable or unsuccessful** — A missing, pending, cancelled, timed-out, or failed CI
  run for the exact commit blocks the preview. A passing run for another commit is insufficient.
- **Build or verification failure** — No attestation or publication job runs. A successful host
  cannot compensate for another host's failure.
- **Artifact disagreement** — A missing archive, unexpected filename, changed digest, invalid
  evidence, or extra archive fails qualification.
- **Registry or GitHub outage** — The publication preflight fails closed. It cannot interpret an
  authentication, rate-limit, DNS, TLS, timeout, or service error as proof that an identity is
  unused.
- **Reused identity** — An existing Git tag, GitHub release, or npm version blocks publication.
  Immutable state is never overwritten.
- **Partial publication** — Operators inspect GitHub and npm state before retry. If any consumer
  could depend on the identity, the version is treated as consumed and isn't silently reused.
- **Missing approval or configuration** — Missing protected-environment approval, immutability,
  provenance, release notes, or branch eligibility blocks publication.
- **Nonpublishing regression** — A dispatch with publication disabled that creates a tag, release,
  npm version, or dist-tag is a release-blocking defect.

### Interface contracts

- The package version is exactly `0.1.0-alpha.2` for this checkpoint. The package name remains
  `@synaptiai/flow-harness`.

- Derived public names are `v0.1.0-alpha.2`, `synaptiai-flow-harness-0.1.0-alpha.2.tgz`,
  `flow-harness-0.1.0-alpha.2.intoto.jsonl`, and `Flow 0.1.0-alpha.2`.

- The canonical release notes are `docs/releases/0.1.0-alpha.2.md` and begin with the exact release
  title heading.

- Release evidence retains schema `flow.synapti.ai/v1alpha1`; this checkpoint changes release
  identity, not the evidence contract.

- The workflow has one Boolean `publish_github` input whose safe default is `false`. No other input
  can affect release identity.

- A nonpublishing run may create only temporary Actions artifacts and a GitHub artifact
  attestation. It doesn't enter the publication environment or mutate GitHub release or npm package
  state.

- A future published npm version uses the exact verified GitHub archive and the `preview` dist-tag.
  It doesn't update `latest`.

## Verification map

| Criteria | Type | Verification command | Passing evidence | Doesn't promise |
| --- | --- | --- | --- | --- |
| 1 | Metadata and failure contract | `npx vitest run test/scaffold/preview-release-identity.test.ts test/scaffold/preview-release-workflow.test.ts test/scaffold/package.test.ts` | Manifest, shrinkwrap, notes, derived names, job outputs, and negative mismatch cases pass | Publication occurred |
| 2 | Exact archive and host contract | `npm run release:prepare && npm run release:verify` plus the nonpublishing preview workflow | One digest-bound archive passes local verification and the same artifact passes Ubuntu 24 x64 and macOS 15 Intel | Other operating systems or architectures |
| 3 | Installed behavior | `npm run pack:check` | Fresh installed projects pass discovery, quickstart, doctor, browser, capability-reference, and Prime-boundary checks without model credentials | Paid-provider or production workload behavior |
| 4 | Publication safety | `npx vitest run test/scaffold/preview-release-workflow.test.ts` | Exact-main CI, unused identity, immutable release, provenance, protected environment, prerelease, and non-latest gates are present and manifest-derived | Authorization to publish |
| 5 | Nonpublishing hosted qualification | Dispatch `.github/workflows/preview-release.yml` on clean `main` with `publish=false`, then inspect GitHub tags/releases and npm | Workflow succeeds; no new tag, release, npm version, or dist-tag exists | Permanent public distribution |
| 6 | Production documentation | `npm run docs:capabilities:generate && npm run docs:capabilities:check && npm run docs:style && npm run docs:links && npm run docs:ste` | Release notes, installation, release process, compatibility, status, roadmap, architecture, and documentation hub are current; README stays concise | Stable API or support guarantee |
| All | Full quality gate | `npm run ci:local && npm run check && npm audit --audit-level=high` | Formatting, lint, type checking, tests, build, packaging, runtime checks, docs, and high-severity audit pass | Hosted runner availability |
