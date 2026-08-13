# Decision Journal: Issue #80 — Install publisher-authenticated capability bundles from a registry

**Issue**: #80

**Branch**: `codex/issue-80-signed-oci-registry`

**Started**: 2026-08-13

---

## Status

Implementation and local release verification are complete. Flow now has the strict digest-only
OCI artifact, bounded public registry client, offline publisher verifier, shipped public-good trust
root, atomic signed installation coordinator, durable publisher audit identity, CLI command,
offline workflow evidence, Node.js 26.7.0 baseline, and public documentation. Stacked pull-request
CI remains the hosted verification authority.

## Specification

_Captured by the specification-capture skill on 2026-08-13. Source: extracted from Issue #80 and
the user-approved architecture discussion._

### Non-goals

- Do not publish or push registry artifacts.
- Do not add private registry credentials or reuse ambient Docker credential files.
- Do not accept mutable tags, version ranges, registry discovery, or package-provided references as
  installation authority.
- Do not add automatic updates, freshness metadata, revocation, rollback protection, or online
  trust-root refresh.
- Do not execute package code, hooks, dependency scripts, or package-selected policy.
- Do not contact a registry, token service, transparency log, certificate authority, or trust-root
  service during workflow admission, execution, child execution, detached execution, inspection,
  recovery, or replay.
- Do not claim that a valid publisher signature makes a package safe or correct.
- Do not change the separately attested Prime OCI image Node.js closure. The host Flow process and
  the Prime external harness have independent runtime identities.

### Failure modes

- **Timeouts** — DNS, registry challenge, anonymous token acquisition, manifest acquisition, bundle
  acquisition, and signature acquisition share one total deadline. Timeout closes every response,
  publishes no package state, and emits one bounded value-free stage.
- **Partial failures** — A fetched or verified object remains inactive until the existing package
  store publishes the content-addressed blob and then the deterministic lock. A manifest, payload,
  signature, verification, or store failure leaves the prior lock authoritative.
- **Invalid input** — Non-canonical registry references, tag references, invalid digests, unexpected
  media types, extra descriptors, malformed strict JSON, descriptor contradictions, and invalid
  signature bundles reject before package state changes. Public errors contain fixed stages, never
  tokens, remote bodies, certificate identities, registry paths, or parser causes.
- **Missing context** — Missing issuer or publisher identity rejects before the first network
  request. Missing built-in trust material is a packaging failure and cannot fall back to an online
  fetch.

### Interface contracts

- Installation authority is one canonical public registry repository, one exact `sha256` OCI
  manifest digest, and one exact trusted publisher policy containing a certificate issuer and one
  subject-alternative-name value.
- The OCI manifest is an exact OCI image manifest with one empty config descriptor and exactly two
  ordered layers: one strict Flow capability bundle and one Sigstore v0.3 message-signature bundle.
  Unknown annotations are not authority. Unknown or extra descriptors reject.
- Every registry object is bounded before strict JSON parsing. Descriptor digest and size are checked
  against the exact received bytes before the bytes reach bundle or signature parsing.
- Signature verification uses `@sigstore/verify` 4.1.2 and `@sigstore/bundle` 5.0.0 with Flow-shipped
  trusted-root material. It requires a v0.3 message-signature bundle, at least one valid signed-time,
  one certificate-transparency proof, and one transparency-log inclusion proof. The publisher SAN
  is escaped and anchored before it becomes a verifier regular expression. No verifier-owned
  network or TUF refresh runs during installation.
- Anonymous token negotiation accepts only a public HTTPS bearer realm and the exact
  `repository:<name>:pull` scope. A token is memory-only and is sent only to the original registry
  origin. Cross-origin blob redirects receive no authorization header.
- The existing `CapabilityBundle` parser and `LocalCapabilityPackageStore` remain the only package
  content and publication authorities. The installed immutable bytes remain the only later
  admission, execution, recovery, and replay source.

## Current flow

```text
operator
  -> flow packages install <public HTTPS URL> --sha256 <bundle digest>
  -> one DNS-pinned bounded HTTPS response
  -> exact response SHA-256
  -> strict CapabilityBundle parser
  -> mutation lock
  -> content-addressed .flowpkg blob
  -> deterministic package lock
  -> offline catalog / immutable run snapshot / recovery / replay
```

The current source URL is acquisition metadata, not execution authority. The new flow must preserve
that property while adding registry and publisher identity.

## Actor and system flows

### Operator flow

1. The operator chooses one canonical registry repository, exact manifest digest, exact issuer, and
   exact publisher identity.
2. Flow validates all four values before network access.
3. Flow resolves, verifies, and installs the artifact or returns one closed failure stage.
4. The operator can list, inspect, and verify the installed immutable identity without network
   access.

### Workflow and model flow

1. A workflow continues to select exact package name and version.
2. The model sees only the existing selected inert capability definitions.
3. Neither workflow source nor model input contains registry, signature, issuer, token, trust-root,
   or update authority.

### Recovery and replay flow

1. Detached workers and child runs carry the admitted immutable capability snapshot.
2. Recovery verifies durable event and snapshot relationships without consulting live package lock
   state or network services.
3. Replay derives the same capability and command relationships from the captured snapshot.

### Publisher flow

1. A publisher creates deterministic `.flowpkg` bytes outside Flow.
2. A publisher signs those exact bytes and publishes the payload and Sigstore verification bundle
   under one digest-addressed OCI manifest.
3. Flow does not provide credentials, signing, or upload behavior in this issue.

## Approaches considered

| Approach | Strength | Weakness | Disposition |
| --- | --- | --- | --- |
| Signed OCI artifact for existing inert bundles | Interoperable content-addressed storage, publisher identity, reuses existing package authority | Requires a strict multi-request registry client and pinned trust root | **Selected** |
| WASI executable component host | Capability-by-import and language portability | Adds executable code, host calls, runtime ABI, and a new containment surface | Later executable-extension decision |
| Native executable bundle in `flow-container-v1` | Reuses Issue #78 command containment | Linux x64 shared-kernel residual and no publisher/update solution | Not safe as the next ecosystem default |
| MCP stdio server in a sandbox | Broad tool ecosystem and standard lifecycle | Protocol is not isolation; dynamic discovery conflicts with immutable package authority | Potential later adapter over a chosen sandbox |
| TUF registry/update layer first | Strong freshness, rollback, delegation, and key compromise recovery | Much larger trust system and no immediate publisher-authenticated artifact path | Follow-up after exact signed pulls |

The selected approach does not imply that OCI is trusted. Registry claims are transport hints. The
caller-supplied manifest digest, descriptor checks, exact package parser, publisher verification,
and local atomic publication remain independent checks.

## Challenged assumptions

### “Node.js 27 is the latest release”

Disproved against the official Node distribution index on 2026-08-13. The newest published release
is v26.7.0 from 2026-08-05. The Node project has announced a new annual cycle beginning with 27, but
27 is not yet present in the release index. Flow will pin host CI and its minimum engine to 26.7.0.

### “The high-level Sigstore client is a pure verifier”

Disproved by inspecting the published `sigstore` client. Its verifier calls `@sigstore/tuf` to get a
trusted root and can update cache state over the network. That bypasses Flow's one bounded registry
transaction. Flow will use the lower-level verifier with release-shipped trust material.

### “A string publisher identity is exact”

Disproved by inspecting `@sigstore/verify` 4.1.2. A string SAN policy is passed to JavaScript regular
expression matching. Flow must escape and anchor the exact operator input.

### “An OCI digest makes publisher verification redundant”

Rejected. The manifest digest proves exact bytes selected by the operator. The signature proves that
the admitted publisher signed the payload. A registry can satisfy neither policy by assertion alone.

### “MCP provides a sandbox”

Rejected. MCP defines negotiation and transports. It does not constrain process, filesystem,
network, credential, or kernel authority.

## Decision

Add an explicit signed-registry installation path for the existing inert `CapabilityBundle` ABI.
Use an exact digest-only OCI reference, a strict two-layer manifest, Flow-owned bounded public HTTPS
and anonymous token handling, offline Sigstore v0.3 message-signature verification, and the existing
atomic package store. Preserve the explicit HTTPS plus SHA-256 installer unchanged.

Upgrade the host application and CI minimum to Node.js 26.7.0 and `@types/node` 26.2.0. Add
`@sigstore/verify` 4.1.2, `@sigstore/bundle` 5.0.0, and the directly imported protobuf definitions at
0.5.1. Do not import the high-level `sigstore` or `@sigstore/tuf` clients into production.

## Planned RED → GREEN → REFACTOR sequence

1. **Node compatibility RED/GREEN** — Bind manifest, CI, public prerequisites, package tests, and
   Sigstore v4 imports to the exact published Node baseline.
2. **Reference and manifest RED/GREEN** — Parse only canonical digest references and strict bounded
   two-layer OCI manifests; reject tags, algorithms, media types, sizes, extras, duplicates, and
   contradictions.
3. **Publisher verification RED/GREEN** — Verify one offline v0.3 message signature with exact
   issuer and escaped/anchored SAN; reject every missing or contradictory proof without private
   causes.
4. **Registry transport RED/GREEN** — Implement one total deadline, public DNS pinning, strict
   challenge parsing, exact anonymous pull scope, memory-only token handling, redirect isolation,
   response settlement, and object digest/size checks.
5. **Installation RED/GREEN** — Compose acquisition, verification, and the existing package store;
   extend durable audit identity without changing run-time source authority.
6. **CLI and offline RED/GREEN** — Add the operator command and prove list, inspect, verify,
   workflow, detached, child, recovery, and replay paths perform no network access.
7. **Docs/refactor** — Update README, roadmap, capability sourcing, testing, examples, help, and
   package checks. Remove duplication without broadening authority.
8. **Adversarial and hosted verification** — Run focused mutation matrices, full release gates,
   package audit, credential-free registry integration, and independent security/correctness review.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Exact digest reference; no mutable authority | Contract/error | `npx vitest run test/unit/capability/oci-capability-artifacts.test.ts` | Canonical exact references pass; tags, ranges, alternate algorithms, queries, fragments, credentials, and non-public forms reject | Registry discovery or updates |
| Bounded strict manifest and descriptor identity | Contract/data | `npx vitest run test/unit/capability/oci-capability-artifacts.test.ts` | Exact manifest and boundary bytes pass; malformed, extra, duplicate, wrong-media, wrong-size, and wrong-digest cases reject | Registry availability |
| Offline publisher identity and proof thresholds | Security/contract | `npx vitest run test/unit/capability/sigstore-capability-verifier.test.ts` | Exact payload, issuer, escaped SAN, signed-time, CT, and tlog proof pass; every mutation fails with fixed text | Publisher correctness, revocation, or online freshness |
| Bounded public registry and token isolation | Security/integration | `npx vitest run test/unit/infrastructure/http/strict-oci-capability-registry.test.ts test/unit/infrastructure/http/node-https-capability-registry-transport.test.ts` | DNS rebinding, private IPs, challenge mutations, scope changes, token/body bounds, redirects, cancellation, and response cleanup follow policy | Private registry credentials |
| Atomic install and durable audit identity | Behavioral/recovery | `npx vitest run test/unit/application/install-signed-oci-capability-bundle.test.ts test/unit/infrastructure/fs/local-capability-package-store.test.ts test/integration/cli/capability-packages.test.ts` | Acquisition and verification precede publication; faults preserve old authority; exact registry and publisher identity round-trips | Atomic remote publication |
| Offline list/admission/execute/recover/replay | Integration/recovery | `npx vitest run test/integration/cli/capability-packages.test.ts test/integration/cli/remote-capability-workflow.test.ts test/integration/supervisor/worker.test.ts test/unit/run/tool-package-reducer.test.ts` | Installed signed bytes work with a network trap; snapshots, removed-package inspection, and replay use no registry fallback | Availability of removed local package state outside captured runs |
| Existing HTTPS installer compatibility | Regression | `npx vitest run test/unit/infrastructure/http/strict-capability-bundle-fetcher.test.ts test/integration/cli/capability-packages.test.ts` | Existing URL plus SHA command and safety matrix remain unchanged | Publisher authentication for legacy installs |
| Node.js and Sigstore dependency contract | Config/package | `npm run typecheck && npx vitest run test/scaffold/package.test.ts && npm run build && npm run pack:check` | Host engine, CI, types, compiled files, packed files, and verifier imports agree on Node 26.7.0; Prime image identity remains separately pinned | Node 27 before official release or a Prime image upgrade |
| Public documentation | Docs | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts test/integration/package/docs-ste.test.ts` | README, roadmap, sourcing, limits, recovery, and prerequisites match the shipped behavior | Automatic updates or TUF refresh |
| Credential-free end-to-end and release quality | Release/runtime | `npm run check && npm run test:coverage && npm run test:runtime && npm run pack:check && npm audit --omit=dev --audit-level=low` | Full build, type, lint, unit, integration, runtime, coverage, package, docs, and runtime-dependency gates pass; registry fixture needs no credential | Hosted service uptime or private registries |

Every Issue #80 acceptance criterion maps to at least one row. Verify-time evidence must also list
untested paths, known evidence limitations, and negative/adversarial cases.

## Verification evidence

- The final complete default suite passed with 2,941 tests and four platform-gated skips.
- Coverage passed with 82.41% statements, 76.29% branches, 88.98% functions, and 82.53% lines.
- Compiled runtime verification passed with 39 tests and 33 platform-gated skips.
- TypeScript, the clean build, changed-file Biome checks, changed-document STE, and
  `git diff --check` pass.
- The clean package gate rebuilt, packed, installed with lifecycle scripts disabled, and executed
  the installed CLI under Node.js 26.7.0.
- The repository graph was rebuilt after implementation. Generated Graphify output is not product
  or commit content.
- The full-tree Biome commands also inspect unrelated untracked `.claude`, `.codex`, and
  `graphify-out` files in this shared workspace. The changed Issue #80 files pass scoped formatting
  and lint checks. Those unrelated files remain untouched and uncommitted.
- The production dependency audit requires disclosure of the dependency graph to the public npm
  advisory endpoint. It was not sent from this desktop session. The pinned hosted CI audit remains
  the release evidence for that criterion.

Negative evidence covers mutable or malformed references; private DNS; changed media types,
digests, sizes, layers, payloads, signatures, issuers, identities, expiry, proofs, token scopes, and
redirects; a non-settling response body; cancellation before publication; provenance conflicts;
corrupt or unsafe store state; and network traps during later admission and execution. Private
registry credentials, online trust refresh, freshness, revocation, rollback protection, and
automatic update discovery are deliberately untested because they are outside Issue #80.

## Primary references

- Node release index: <https://nodejs.org/dist/index.json>
- Node release policy: <https://nodejs.org/en/about/previous-releases>
- OCI Distribution Specification: <https://github.com/opencontainers/distribution-spec/blob/main/spec.md>
- OCI image manifest: <https://github.com/opencontainers/image-spec/blob/main/manifest.md>
- Registry bearer authentication: <https://distribution.github.io/distribution/spec/auth/token/>
- Sigstore bundle: <https://docs.sigstore.dev/about/bundle/>
- Sigstore client wire format: <https://github.com/sigstore/architecture-docs/blob/main/client-spec.md>
- Sigstore trusted-root schema: <https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_trustroot.proto>
- TUF specification: <https://theupdateframework.github.io/specification/latest/>
