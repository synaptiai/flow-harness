# Decision journal: Issue #136 — Publish an installable Flow preview package

**Issue:** #136 | **Branch:** `codex/issue-136-install-preview` | **Started:** 2026-08-21

## Context

Flow already defines a public scoped package, a `flow` executable, Linux and macOS constraints, and
a clean-room packed-install smoke test. The package remains version `0.0.0`, the npm name is absent,
and the repository has no release, tag, or deployment environment. Gate 8.1 adds public release
authority and cross-platform evidence. It does not redesign the harness runtime.

## Research

- npm trusted publishing uses short-lived OpenID Connect credentials. It creates provenance for a
  public package from a public GitHub repository. npm requires an existing package before a
  stage-only workflow can be used.

- npm prereleases must use an explicit distribution tag to avoid changing `latest`.

- npm excludes `package-lock.json` from published packages. `npm-shrinkwrap.json` is the
  publishable lock intended for deployed command-line applications. A clean consumer test remains
  necessary because npm and registry behavior are outside the archive's byte identity.

- GitHub immutable releases bind the tag and attached assets after publication. GitHub recommends
  attaching every asset to a draft before publishing it.

- GitHub artifact attestations bind an artifact to its source revision and workflow. An attestation
  proves origin, not package safety, so Flow must still inspect and execute the packed artifact.

- Node.js 26 is Current on the captured date. Flow uses 26.7.0 as its baseline.

Primary sources:

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm staged publishing](https://docs.npmjs.com/staged-publishing/)
- [npm distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/)
- [npm shrinkwrap](https://docs.npmjs.com/cli/v11/commands/npm-shrinkwrap/)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)

## Approaches

| Approach | Summary | Main advantage | Main risk |
| --- | --- | --- | --- |
| npm first | Publish the first version manually with two-factor authentication, then configure trusted publishing. | One familiar install channel. | No public artifact until npm bootstrap succeeds. |
| GitHub release only | Publish an immutable, attested npm tarball as a prerelease asset. | No npm authority is required. | Installation and discovery remain second class. |
| Exact-artifact bridge | Publish one verified immutable release asset, use the exact digest for the first npm publish, then use stage-only trusted publishing. | Immediate artifact plus a secure canonical transition. | More release settlement states must be explicit. |
| Token automation | Publish directly with a stored registry token. | Simple automation. | Adds a long-lived release credential and weakens proof of presence. |

## Decision

The user approved the exact-artifact bridge on 2026-08-21. It uses version `0.1.0-alpha.1` and npm
tag `preview`. One exact archive passes Linux and macOS verification before an immutable GitHub
prerelease. Stage-only trusted publishing follows the first two-factor-authenticated npm
publication. The release must not assign the `latest` tag.

## Specification

_Captured on 2026-08-21. Source: issue contract, repository evidence, external primary sources, and
the approved exact-artifact bridge._

### Non-goals

- The preview does not promise stable workflow compatibility, Windows support, or automatic
  updates. It also excludes a hosted service, VM-grade isolation, provider credentials, and a
  stable release tag.

- The release does not make Docker, Prime, or a model provider a credential-free prerequisite.

- The package launcher does not diagnose the full host. `flow doctor` owns detailed diagnostics in
  Gate 8.2.

- The release workflow builds one package for all target operating systems.

### Failure modes

- **Timeouts** — A platform verification or publication query has a fixed deadline. A timeout fails
  the release without publication or an automatic retry.

- **Partial failures** — A built but unverified artifact remains private. A public release asset or
  registry version is inspected before retry and is never overwritten or silently substituted.

- **Invalid input** — A fixed public stage reports invalid release input. Invalid input includes a
  malformed version, mismatched tag, unsupported host, unexpected file, or conflicting identity.
  It fails before publication or project mutation.

- **Missing context** — Missing release approval, registry authority, attestation permission, or
  platform evidence prevents publication. Credential-free local package checks remain usable.

- **Dependency outage** — A registry, release API, or hosted-runner outage fails publication. Flow
  does not weaken verification or fall back to another artifact.

- **Resource exhaustion** — Package file count, archive bytes, command output, test duration, and
  workflow artifacts remain explicitly bounded.

### Interface contracts

- The installed command is `flow`. The package identity is `@synaptiai/flow-harness`. Supported
  hosts are `linux` and `darwin`. The minimum Node.js version remains `26.7.0`. One reviewed change
  must update every owning contract before that version can change.

- The package launcher checks host compatibility before importing the full CLI. Failure output names
  only the public requirement and exits nonzero without project mutation.

- One release identity binds one semantic prerelease version and one source revision. It also binds
  one installed-file manifest, one published dependency resolution, archive digest, and provenance
  statement. Hosted verification records the npm closure resolved at publication time. The archive
  doesn't make later registry responses immutable.

- Linux and macOS verify the same archive bytes. Publication consumes those bytes rather than
  rebuilding them.

- Release details live in a canonical release guide. The README provides only the preferred install
  command, status warning, and link.

- The public channel is an immutable GitHub prerelease followed by an exact-byte npm publication
  under the `preview` tag. An authorized operator makes the first npm publication with two-factor
  authentication. npm must record the package before a maintainer configures stage-only trusted
  publishing.

## Compatibility-boundary decision

The package `engines` declaration cannot prove refusal. npm might install an incompatible package
with a warning.

A check inside the existing CLI would load the complete command module graph first. The package bin
therefore points to a minimal launcher. The launcher validates only the public Node.js and
operating-system contract. It emits fixed value-free failures and imports the CLI only after
success.

## Acceptance verification map

| Criterion | Evidence command | Expected result |
| --- | --- | --- |
| The package has one prerelease identity and an early host boundary. | `npx vitest run test/unit/cli/launcher.test.ts test/scaffold/package.test.ts` | Version, executable, Node.js minimum, and operating-system refusal pass. |
| One clean revision creates one bounded canonical artifact. | `npx vitest run test/unit/release/package-release-evidence.test.ts test/unit/infrastructure/release/package-release-artifact.test.ts test/unit/infrastructure/release/local-package-release-builder.test.ts test/unit/infrastructure/release/package-release-command.test.ts` | Evidence parsing, npm output binding, atomic settlement, cancellation, conflict, and clean-source checks pass. |
| The release verifier consumes exact bytes and an exact installed tree. | `npx vitest run test/unit/infrastructure/release/package-release-verifier.test.ts && npm run release:verify` | Archive identity, installed files, package metadata, command discovery, initialization, example execution, browser presentation, and Prime validation pass. |
| Linux x64 and macOS x64 consume the same workflow artifact. | `npx vitest run test/scaffold/preview-release-workflow.test.ts` and the manual `Preview release` workflow | The workflow contract passes. Both hosted matrix jobs must pass before attestation. |
| Publication is provenance-bound, protected, immutable, and not `latest`. | `npx vitest run test/scaffold/preview-release-workflow.test.ts` and the protected publication job | Pinned provenance runs after host verification. Publication requires the environment and immutable-release setting. |
| The first npm bridge uses exact bytes and later authority is stage-only. | `npx vitest run test/scaffold/community-files.test.ts` and the operator steps in `docs/operations/release-preview.md` | No workflow npm token, direct npm publish, or `latest` assignment exists. The first interactive publication and later trust configuration use the documented archive and tags. |
| Public guidance is segmented, linked, clear, and current. | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/documentation-structure.test.ts` | Every page has a canonical route. The README remains a landing page. All documentation gates pass. |
| The repository and packed product remain releasable. | `npm run check && npm run test:coverage && npm run test:browser && node scripts/smoke-compiled.mjs && npm run pack:check && node scripts/audit-prime-dependencies.mjs && npm audit --omit=dev --audit-level=low` | The complete default, runtime, coverage, browser, compiled, clean-install, and dependency gates pass. |

## Local evidence

Local verification on 2026-08-21 produced these results:

- `npm run check` passed 4,619 default tests with four skips. It also passed 43 compiled-process
  runtime tests with 34 platform skips.

- `npm run test:coverage` passed the same 4,619 tests. Coverage was 84.76% statements, 79.38%
  branches, 91.41% functions, and 84.90% lines.

- `npm run test:browser` passed two real-browser tests.

- `node scripts/smoke-compiled.mjs` and `npm run pack:check` passed.

- `node scripts/audit-prime-dependencies.mjs` verified the Node lock and 60 Python packages.
  `npm audit --omit=dev --audit-level=low` reported zero vulnerabilities.

- Documentation structure, style, link, clarity, type, and diff checks passed.

Hosted Ubuntu 24.04 x64 and macOS 15 Intel verification remains pending. GitHub prerelease and npm
publication also remain pending. Local evidence does not satisfy those publication criteria.
