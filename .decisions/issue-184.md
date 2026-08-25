# Decision Journal: Issue #184 — Define Flow's public compatibility contract

**Issue**: #184 | **Branch**: `codex/issue-184-public-compatibility` | **Started**: 2026-08-25

---

## Context

Flow is available from npm as `@synapti/flow-harness@0.1.0-alpha.3`. The package documents a CLI,
but its manifest does not define `exports`, so consumers can accidentally import the package's
compiled modules. Those modules span hundreds of files and were not designed, documented, or
versioned as a JavaScript library API.

Flow also produces authored workflow files, machine-readable command output, and append-only run
evidence. Operators need to know which of these surfaces are contracts, how compatibility is tested,
and what an alpha release can change. Issue #184 establishes that boundary without claiming stable
compatibility or exporting an in-process library.

## Existing evidence

- The published package declares only the `flow` executable. The documentation does not describe a
  package-root or subpath import.
- The current package has 318 compiled JavaScript modules and thousands of exported declarations.
  Treating them as public would freeze internal composition, persistence, provider, and security
  boundaries before they have independent lifecycle contracts.
- The immutable `0.1.0-alpha.1` npm archive has SHA-256 digest
  `3a8d76564dae33e2c43951c483a3cd69b146fa7788ce311949d5242cb0229568`. It can run a deterministic
  terminal workflow whose ledger the current parser can replay.
- The workflow shipped at `examples/verify-installation.workflow.yaml` in `0.1.0-alpha.1` compiles
  with the current production compiler.
- The `0.1.0-alpha.1` release notes explicitly made no compatibility promise. This issue therefore
  defines a prospective alpha policy and a bounded tested corpus, not retroactive universal support.

## Approved architecture

### Refined A1: CLI-only package with an immutable compatibility corpus

The npm package exposes one supported executable, `flow`, and an empty `exports` map. Node package
imports of the package root and every undeclared subpath fail. The packed-archive verification gate
tests both the executable and the import refusal from a clean consumer installation.

The package includes a versioned, immutable compatibility corpus. Each artifact has a content digest,
producer release identity, kind, and exact expected observations. The corpus initially contains one
authored workflow from `0.1.0-alpha.1` and one terminal run ledger produced by that immutable release.
It contains no credentials and requires no network access.

`flow compatibility check` reads only that packaged corpus. It verifies every file before parsing,
uses the production workflow compiler and run-event reducer, and emits one bounded, content-free JSON
report. The report identifies the installed Flow release, corpus, every artifact, each result, and
the overall result. It returns success only when every artifact remains compatible.

The command does not rewrite historical artifacts, create project state, acquire run ownership, or
invoke providers. Missing, changed, malformed, oversized, unsupported, or identity-mismatched corpus
input fails closed under stable diagnostic categories.

### Alternatives considered

| Approach | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| Export the current compiled module tree | Immediate in-process access | Makes internal modules a public contract; exposes high-authority runtime and persistence surfaces | Rejected |
| Export a curated library API in this issue | Can support typed validation and inspection | Requires independent versioning, cancellation, error, authority, and lifecycle contracts before evidence exists | Deferred for decision-grade assessment |
| CLI-only package with a compatibility corpus | Small supported surface; real cross-release evidence; preserves process isolation | Process startup cost; machine clients must consume CLI output | Approved |
| Document policy without executable checks | Small implementation | Policy and behavior can drift; does not prove historical artifacts remain readable | Rejected |

## User, operator, and system flows

### Install and invoke Flow

1. A user installs the packed npm archive or published package.
2. The package exposes the `flow` executable.
3. Package-root and undeclared-subpath imports fail before loading Flow internals.
4. The user follows the CLI documentation for supported commands and machine-readable output.

### Check historical compatibility

1. An operator runs `flow compatibility check` without a project or network connection.
2. Flow reopens the packaged manifest and each declared artifact without following links.
3. Flow verifies bounded size, immutable file identity, digest, kind, and producer identity.
4. Flow compiles the historical workflow and replays the historical ledger with current production
   parsers.
5. Flow compares only documented observations and emits one report. It never emits workflow source,
   command output, or private paths.

### Detect release drift

1. CI builds and packs the exact npm archive.
2. CI installs it into a clean consumer directory with lifecycle scripts disabled.
3. CI checks the manifest boundary, rejected imports, compatibility command, and corpus results.
4. A changed entry point, missing corpus file, changed digest, parser incompatibility, or report drift
   blocks the package gate.

## Coupling analysis

- The compatibility domain defines the manifest, report, categories, and observation comparison. It
  depends only on existing production compiler and replay semantics.
- Filesystem infrastructure owns bounded no-follow reads, package-relative containment, file identity
  checks, strict JSON decoding, and SHA-256 verification.
- The CLI owns argument parsing, installed-package location, output, and exit codes. It does not
  interpret workflow or ledger semantics.
- The release verifier owns the installed manifest boundary and exact packed tree. It requires the
  empty `exports` map and packaged compatibility directory.
- Documentation owns surface classification, alpha policy, migration/deprecation guidance, and the
  non-contractual library API assessment.

## Specification

### Non-goals

- No stable npm version, stable channel, or tag promotion.
- No supported JavaScript or TypeScript library API.
- No workflow API change, historical ledger rewrite, or migration-on-read.
- No remote compatibility service, provider call, executable extension, or model-owned network tool.
- No stronger sandbox claim than Flow already documents and verifies.

### Failure modes

- **Missing corpus** — Return a stable `corpus_missing` diagnostic without creating files.
- **Malformed manifest or artifact** — Return `corpus_malformed` or `artifact_malformed` without
  accepting partial observations.
- **Oversized input** — Return `resource_limit` before unbounded allocation or parsing.
- **Unsupported version or kind** — Return `unsupported_corpus` or `unsupported_artifact`.
- **Digest or identity mismatch** — Return `artifact_identity_mismatch` before semantic validation.
- **Parser incompatibility** — Include an incompatible artifact result with a bounded semantic
  category; never include private source content in the report.
- **Partial corpus** — Evaluate all safely readable declared artifacts, but the overall result remains
  incompatible if any artifact cannot be established.
- **Dependency outage** — No dependency is contacted. Any network activity is a defect.
- **Timeout or cancellation** — The fixed bounded corpus prevents open-ended work. Process-level
  cancellation remains authoritative and produces no modified state.

### Interface contracts

- The only supported npm entry point is the `flow` executable. The package root and all subpaths are
  unexported.
- `flow compatibility check` accepts no path, project, mutation, or network options.
- The report has one versioned schema and contains package identity, corpus identity, an ordered result
  for every artifact, stable states and categories, documented observations, and one overall result.
- Workflow observations include API version, workflow identifier, node count, criterion count, and
  the expected compiled identity. Run observations include run and workflow identifiers, workflow
  digest, terminal status, last sequence, and expected stdout and stderr hashes.
- Historical source bytes remain unchanged. Compatibility logic can normalize parser defaults in its
  report, but cannot rewrite an artifact, change its verdict, or manufacture evidence.
- The library API assessment is documentation and creates no package export or compatibility promise.

## Verification map

| Criteria | Type | Verification command | Passing evidence | Does not promise |
| --- | --- | --- | --- | --- |
| 1 | Package contract | `node_modules/.bin/vitest run test/scaffold/package.test.ts test/unit/infrastructure/release/package-release-verifier.test.ts` | Exact `flow` binary and empty `exports` boundary are required | Browser bundler support |
| 2–4 | Domain and error | `node_modules/.bin/vitest run test/unit/compatibility/check.test.ts test/unit/infrastructure/compatibility/local-corpus.test.ts` | Bounded report, both historical kinds, stable rejection categories, and read-only snapshots pass | Every pre-alpha artifact ever produced |
| 2–4 | CLI integration | `node_modules/.bin/vitest run test/integration/cli/compatibility.test.ts` | One argument form emits the versioned report and stable failures | An in-process API |
| 5 | Packed archive | `npm run pack:check` | Clean install executes the CLI, rejects imports, and verifies the packaged corpus | Registry availability |
| 6–8 | Documentation | `npm run docs:style` plus `npm run docs:links` plus `npm run docs:ste` plus `node_modules/.bin/vitest run test/integration/package/documentation-structure.test.ts test/integration/package/architecture-documentation.test.ts` | README, docs hub, policy, API assessment, roadmap, status, Mermaid diagram, and repository map agree | Stable compatibility |
| 1–8 | Full local gate | `npm run ci:local` | Static, test, build, runtime, documentation, and package gates pass | Live paid-provider behavior |

## Implementation sequence

1. RED/GREEN the compatibility manifest, report, workflow checks, ledger checks, and stable failures.
2. Add the immutable `0.1.0-alpha.1` corpus and provenance record.
3. RED/GREEN the CLI argument, report output, and read-only behavior.
4. RED/GREEN the package export boundary and packed-consumer checks.
5. Publish the compatibility policy and deep library API assessment; update all documentation maps.
6. Run focused, complete, runtime, package, documentation, and adversarial review gates.
