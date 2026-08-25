# Decision journal: Issue #179 — Correct the npm package scope

**Issue**: #179 | **Branch**: `codex/issue-179-correct-npm-scope` | **Started**: 2026-08-25

---

## Context

Flow `0.1.0-alpha.2` was published as an immutable GitHub prerelease after exact-source CI,
Ubuntu 24.04 x64 verification, macOS 15 Intel verification, and GitHub artifact attestation. Its
manifest names `@synaptiai/flow-harness`.

The first npm publication failed after interactive authentication because the `synaptiai` npm
scope does not exist. The existing organization is `synapti`, and the authenticated maintainer is
its owner. npm created no package, version, or distribution tag. The intended
`@synapti/flow-harness` package remains unused.

GitHub release immutability prevents correction of the `0.1.0-alpha.2` assets. Repacking those
sources under another package name would break the reviewed one-archive chain between source,
release evidence, GitHub provenance, and npm. The approved recovery preserves `0.1.0-alpha.2` as
GitHub-only historical evidence and advances the corrected package to `0.1.0-alpha.3`.

## Existing evidence

- GitHub release `v0.1.0-alpha.2` is immutable and targets
  `ce61d5093e521a155ee17a62864956490b6e0b5a`.

- Its npm archive has SHA-256 digest
  `53bd1a9798b2891790dfc4a8cf03ce58453c5dc07936d2771f3381c8613ca390` and SHA-512 digest
  `4ce8af4d42ed5c7a2fa16eeccf25956b50e8a35f7afb1271c834cd43e6f2669d130d39ca854f4132e46dc88bd81afc16a996a176048e30e56c3875a098058e0b`.

- GitHub release, release-asset, and signer-workflow attestation verification succeeded for all
  three `0.1.0-alpha.2` assets.

- npm returned `E404 Scope not found` for the direct publication. A subsequent exact-version query
  also returned `E404`, which confirms that the failed request did not create the package.

- `npm org ls synapti --json` reports the authenticated `danielbentes` account as organization
  owner. `npm view @synapti/flow-harness` returns `E404`, so the intended package name is unused.

## Approved design

### Correct the complete package identity

The reviewed package name becomes `@synapti/flow-harness`. The package manifest, shrinkwrap root,
release-identity resolver, archive naming, release-evidence validator, installed-package verifier,
tests, and current operator documentation must agree on that value.

The source repository remains `synaptiai/flow-harness`. npm organization identity and GitHub
organization identity are independent external authorities and do not need the same spelling.

### Advance the immutable version

The corrected release uses `0.1.0-alpha.3`. The manifest remains the single version authority and
derives these public names:

- Git tag `v0.1.0-alpha.3`;
- archive `synapti-flow-harness-0.1.0-alpha.3.tgz`;
- attestation bundle `flow-harness-0.1.0-alpha.3.intoto.jsonl`;
- title `Flow 0.1.0-alpha.3`; and
- release notes `docs/releases/0.1.0-alpha.3.md`.

Historical `0.1.0-alpha.1` and `0.1.0-alpha.2` release documents remain evidence of their shipped
contracts. Current installation, status, roadmap, and operator guidance point to `0.1.0-alpha.3`.

### Preserve publication hardening

The release continues to build one archive from an exact successful default-branch CI revision.
Ubuntu 24.04 x64 and macOS 15 Intel must install and verify the same bytes before GitHub attests
them. The protected environment remains the only GitHub publication gate.

The first `@synapti/flow-harness` version uses interactive npm publication with two-factor
authentication. The exact verified GitHub archive is published under `preview`; `latest` remains
unset. After bootstrap, future workflow revisions receive only stage-publish authority. Package
access requires two-factor authentication and disallows publication tokens.

### Alternatives considered

| Approach | Benefit | Cost and risk | Decision |
| --- | --- | --- | --- |
| Create a new `synaptiai` npm organization | Keeps the existing manifest | Uses the wrong organization identity and adds unnecessary external governance | Rejected |
| Modify the immutable `0.1.0-alpha.2` release | Reuses the approved version | GitHub forbids the mutation, and replacement would invalidate consumer evidence | Rejected |
| Repack and publish npm `0.1.0-alpha.2` without a matching GitHub release | Avoids a version increment | Breaks exact-archive provenance and creates two meanings for one version | Rejected |
| Correct the scope and release `0.1.0-alpha.3` | Preserves history and restores one-artifact identity | Requires a small reviewed release | Approved |

## System and operator flow

1. Tests first require the intended package name, semantic version, derived archive, and current
   documentation.
2. Source identity and every validating consumer change together.
3. Focused release tests, documentation checks, full repository gates, and local package
   verification run before review.
4. A pull request merges only after CI succeeds and review finds no P1, P2, or P3 issue.
5. A nonpublishing preview run qualifies the exact merged revision on both release hosts.
6. A separately approved publication run creates the immutable GitHub prerelease.
7. The maintainer downloads and verifies the public assets, then publishes that exact archive to
   npm under `preview` with two-factor authentication.
8. Registry metadata, archive bytes, clean installation, guided first run, trusted publisher, and
   package access are verified independently.

## Coupling analysis

- `package.json` owns package name and version declarations.
- `npm-shrinkwrap.json` mirrors the installable root identity and dependency closure.
- The release resolver derives operational names and rejects mismatched independent metadata.
- Release evidence binds the expected package and archive name to exact source and file content.
- The installed-package verifier rejects an archive whose embedded manifest uses another scope.
- Current public documentation owns install and operator commands. Historical release documents
  preserve already-published facts.
- The GitHub workflow consumes resolved identity and does not contain a second scope or version
  authority.

## Specification

### Non-goals

- Do not change, delete, recreate, or hide the immutable `0.1.0-alpha.2` GitHub release.
- Do not claim that `0.1.0-alpha.2` was published to npm.
- Do not assign npm's `latest` tag to a prerelease.
- Do not weaken exact-source CI, multi-host archive verification, provenance, environment approval,
  archive bounds, or failure-closed unused-version checks.
- Do not rename the GitHub organization, repository, executable, schema, or product.
- Do not include unrelated roadmap features or compatibility promises.

### Failure modes

- **Stale package declaration** — Manifest, shrinkwrap, evidence, or installed verification rejects
  the old npm scope.
- **Reused version** — An existing tag, GitHub release, npm version, or staged version blocks
  publication.
- **Artifact disagreement** — A filename, digest, manifest, evidence, or installed-tree mismatch
  blocks qualification or publication.
- **Partial publication** — Operators inspect exact GitHub and npm state before retry. An ambiguous
  semantic version is treated as consumed.
- **Missing authority** — Missing npm organization membership, two-factor authentication, trusted
  publisher identity, or GitHub environment approval blocks the relevant mutation.
- **Registry or GitHub failure** — Authentication, transport, timeout, service, and malformed
  responses never count as evidence that a namespace is unused.
- **Documentation drift** — Automated package, release, link, style, and clarity contracts fail.

### Interface contracts

- The npm package is `@synapti/flow-harness@0.1.0-alpha.3`.
- The executable remains `flow`.
- The GitHub source remains `https://github.com/synaptiai/flow-harness`.
- The immutable release tag is `v0.1.0-alpha.3` and is a prerelease, not latest.
- The npm distribution tag is `preview`; `latest` does not select this version.
- GitHub and npm distribute byte-identical `synapti-flow-harness-0.1.0-alpha.3.tgz` archives.
- Future trusted publishing permits `npm stage publish` only from `preview-release.yml` in the
  `preview-release` environment.

## Verification map

| Criterion | Verification | Passing evidence |
| --- | --- | --- |
| Correct identity | `node scripts/resolve-preview-release-identity.mjs` and focused release tests | Every public name resolves from `@synapti/flow-harness@0.1.0-alpha.3`; stale declarations fail |
| Documentation | `npm run docs:style`, `npm run docs:links`, and `npm run docs:ste` | Current commands use `@synapti`; historical `alpha.2` evidence remains explicit |
| Source quality | Format, lint, typecheck, unit, integration, browser, runtime, and coverage gates | All applicable local and hosted checks succeed |
| Exact package | `npm run release:prepare`, `npm run release:verify`, and `npm run pack:check` | One bounded archive installs and completes the guided package verification |
| Hosted qualification | Nonpublishing preview workflow on exact merged default-branch revision | Ubuntu, macOS, and attestation jobs succeed; publication is skipped |
| GitHub publication | Protected publishing workflow plus independent release and asset verification | Immutable prerelease targets the exact revision and all digests and attestations verify |
| npm publication | Exact-version and dist-tag queries, registry archive comparison, and clean consumer run | `preview` selects `alpha.3`, `latest` does not, bytes match GitHub, and installed commands work |
| Future hardening | `npm trust list` and package publishing-access inspection | One stage-only trusted publisher exists and publication tokens are disallowed |

## Implementation evidence

- The RED phase produced 14 expected failures across manifest, shrinkwrap, release identity, and
  current documentation contracts.
- The GREEN phase passed 127 focused tests across eight release and packaging test files.
- Formatting, lint, type checking, documentation style, documentation links, and changed-prose
  checks pass. Lint reports one pre-existing informational suggestion outside this diff.
- The unconstrained full test run exceeded host memory and ended with exit 137 while another
  repository was running Vitest concurrently. A serial retry also encountered broad unrelated
  timing failures under the same contention. Hosted CI and isolated local release verification
  remain required before merge and publication.
