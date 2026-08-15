# Decision Journal: Issue #85 — Discover and stage signed capability metadata

**Issue**: #85

**Stack**: Clean branch from merged Issue #84 commit `bea1471`.

**Started**: 2026-08-14

---

## Status

Approach C and the defaults in this journal were approved by the operator on 2026-08-14.
Implementation and local verification are complete on a clean post-Issue #84 branch. Publication
remains governed by the final review, pull request, CI, and merge gates.

## Specification

_Captured by the specification-capture skill on 2026-08-14. Source: mixed — extracted from Issue
#85 and confirmed by the operator's approval of Approach C with the proposed defaults._

### Non-goals

- Do not change or execute a capability package because of metadata check or activation.

- Do not create a Flow daemon, timer, background loop, startup check, or hidden network path.
  An operator-owned external scheduler may invoke the explicit check command.

- Do not let project-controlled configuration grant channel, redirect, credential, signer, or
  network authority.

- Do not add private-channel credentials, mutable package tags, version ranges, dependency
  solving, or automatic conflict handling.

- Do not treat staged candidates as admission, execution, recovery, replay, or rollback authority.
  Only active metadata may constrain new package installation and catalog admission.

- Do not claim threshold signatures, delegated roles, root rotation, compromise recovery, or full
  TUF repository semantics. Those protections require a separately designed repository and
  operating model.

- Do not add a TUF dependency only for parsing. Node compatibility is not the blocker.
  The missing trust-root, role, threshold, and repository lifecycle is the blocker.

### Failure modes

- **Timeouts and cancellation.** One total deadline covers DNS and the pinned HTTPS request.
  It also covers response settlement, decoding, metadata verification, and publication checks.
  The operator signal is checked before and after each asynchronous boundary and immediately
  before mutation. Synchronous parsing and signature verification are not falsely described as
  preemptible. Cancellation publishes no new candidate unless the atomic candidate commit already
  crossed its uncertain boundary.

- **Partial failures.** Transport or response failures leave active metadata unchanged. Envelope,
  metadata, signature, freshness, monotonicity, capacity, or storage failures do the same.
  Installed packages also remain unchanged.
  Content is synchronized before the latest-check observation is replaced. A post-rename failure
  reports one fixed commit-uncertain stage. It does not claim rollback.

- **Crash debris.**
  An existing `.flow/packages.metadata.check.lock` fails closed. Flow does not infer liveness or
  reclaim it automatically. An operator may remove that exact file only after confirming that no
  candidate-store operation owns it. Flow never traverses or deletes crash debris automatically.
  After the same ownership check, the operator may inspect and remove only the exact
  `.flow/.packages.metadata.candidate.pending` directory or
  `.flow/.packages.metadata.check.pending` file. Operations fail closed while either exists.

- **Invalid input.** Invalid channel URLs, redirects, credentials, DNS answers, or media types
  reject. Malformed, oversized, non-canonical, stale, or substituted evidence also rejects. Every
  rejection uses a fixed public stage. Those stages contain no host values. Raw URLs, addresses, paths,
  and response bytes remain private. Parser issues, certificate data, and nested causes also remain
  private.

- **Missing context.** Check requires an exact HTTPS channel and signer policy. Activation requires
  an exact candidate digest and signer policy. No ambient credential or project config grants
  authority. No previous candidate or candidate-controlled field supplies missing authority. Activation without
  active metadata may establish authority only after all independent checks pass.

- **Dependency outage.** DNS, TLS, channel, or local storage outage fails closed. There is no
  retry, fallback mirror, automatic daemon restart, or alternate authority. A later explicit check
  may be invoked by the operator or external scheduler.

- **Resource exhaustion.** Response and decoded component sizes are fixed and bounded. JSON,
  target, candidate, path, record, and deadline bounds are also fixed. Exactly four candidates may coexist. Exact duplicates
  are idempotent. A fifth distinct candidate rejects until explicit removal.

### Interface contracts

- Public commands are:

  ```text
  flow packages metadata check <https-channel-url> --certificate-issuer <exact-https-issuer> --certificate-identity <exact-identity>
  flow packages metadata candidates list
  flow packages metadata candidate inspect <sha256:digest>
  flow packages metadata candidate remove <sha256:digest>
  flow packages metadata activate <sha256:digest> --certificate-issuer <exact-https-issuer> --certificate-identity <exact-identity>
  ```

  The existing local `metadata refresh` and `metadata inspect` commands remain available.

- The channel is one canonical public HTTPS URL without credentials, query, or fragment.
  The client follows no redirect and sends no ambient credential.
  It admits only all-public DNS answers and pins one address. It accepts only HTTP 200 and the exact metadata media type.
  It uses one total deadline.

- The response is strict canonical JSON with exactly `apiVersion`, `kind`, `metadataBase64`, and
  `sigstoreBundleBase64`. `apiVersion` is `flow.synapti.ai/v1alpha1`. `kind` is
  `SignedCapabilityMetadataEnvelope`. The maximum envelope size is 2,097,285 UTF-8
  bytes: `4*ceil(524288/3) + 4*ceil(1048576/3) + 129` fixed JSON bytes.

- Metadata and Sigstore bundle fields use canonical padded base64. Decoded metadata is at most
  524,288 bytes. The decoded Sigstore bundle is at most 1,048,576 bytes. The envelope is transport,
  not authority. The offline verifier authenticates the exact metadata bytes. It uses the
  operator-supplied issuer and identity.

- Candidate identity uses a canonical SHA-256 digest. It binds metadata and bundle byte counts and
  digests. It also binds metadata identity, complete targets, and exact signer policy. Channel URL,
  observation time, and envelope digest are latest-check observations, not candidate identity.

- Candidate storage is inert and content-addressed. Only active metadata is rollback authority.
  A candidate below the active version, or an equal active version with different bytes or signer
  policy, rejects. Candidates create no monotonic high-water mark over other candidates. A staged
  high-version candidate cannot block a different candidate.

- Activation reopens and rehashes the stored candidate. It reparses metadata and re-verifies the
  exact signature and signer policy. It rechecks freshness. It uses a fresh trusted
  clock instant. The existing metadata store performs monotonic active publication. Activation
  never installs or removes packages.

- Runs, catalog snapshots, workers, children, recovery, and replay never read candidate state.
  They continue to consult active metadata during admission and immutable snapshots afterward.

## Functional flows

### Explicit or scheduled check

```text
operator channel + exact signer policy + fixed check-start instant
  -> canonical public-HTTPS validation
  -> all-public DNS resolution and pinned-address request
  -> exact status, media type, byte bound, and no-redirect checks
  -> strict canonical envelope decoding
  -> strict metadata parsing and fixed-time freshness check
  -> offline Sigstore verification over exact metadata bytes
  -> compare only with active rollback authority
  -> publish or reuse one inert content-addressed candidate
  -> atomically replace the bounded latest-check observation
```

### Reviewed activation

```text
exact candidate digest + newly supplied exact signer policy + fresh clock instant
  -> reopen candidate content and identity records
  -> rehash and reparse every authoritative byte
  -> repeat offline signature and freshness verification
  -> acquire the existing package mutation owner
  -> repeat active monotonic comparison
  -> atomically publish active metadata
  -> leave candidate and installed packages unchanged
```

### Explicit candidate removal

```text
exact candidate digest
  -> validate content-addressed identity
  -> remove only that inert candidate
  -> leave latest active metadata, installed packages, and run snapshots unchanged
```

## Approaches considered

| Approach | Strength | Weakness | Disposition |
| --- | --- | --- | --- |
| Full TUF repository/client | Threshold trust, root rotation, delegation, snapshot/timestamp roles, and mature rollback/freeze defenses | Requires a real repository, root ceremony, threshold policy, rotation, delegation, and operating model that Flow does not yet have | Future architecture target |
| OCI tags/referrers as discovery authority | Fits existing registries and digest artifacts | Tags are mutable; referrers fallback is client-maintained and races; subject is a weak association | Rejected as authority; possible future transport |
| Flow signed HTTPS channel with inert staging | Smallest slice that preserves explicit network and activation authority while reusing current signatures and monotonic active state | Single-role signer lacks TUF threshold/root-rotation protection | **Selected** |

## Decision

Implement Approach C with the approved defaults. One explicit public HTTPS check may stage a bounded
authenticated candidate. A separate explicit activation command may promote one exact reviewed
candidate only after repeating signer, byte, freshness, and monotonic verification. Flow itself
does not poll or activate automatically.

Treat the channel and candidate files as untrusted input. Treat only the operator-supplied signer
policy, offline verification result, active monotonic state, and atomic active-state publication as
authority. Keep all public failures closed and value-free.

Defer full TUF until Flow has a repository and trust-root operating model. Defer OCI discovery as
authority. A future adapter may transport the same signed envelope without changing activation.

## Planned RED -> GREEN -> REFACTOR sequence

1. **Envelope** — RED canonical encoding, exact bounds, fatal UTF-8, duplicate keys, base64
   canonicality, and decoded component bounds. GREEN one domain parser and serializer.

2. **Verification-only service** — RED exact signer, signature, freshness, cancellation, and
   private-cause suppression without active mutation. GREEN extract shared verification from the
   current mutating importer.

3. **Channel** — RED URL/DNS/redirect/status/media/response/deadline/cancellation cases. GREEN one
   application port and strict pinned HTTPS adapter.

4. **Candidate store** — RED idempotence, capacity, tampering, atomic settlement, candidate
   independence, latest observation, exact removal, and active-state non-interference. GREEN one
   bounded content-addressed store.

5. **Check and activation** — RED full order, no install mutation, fresh activation verification,
   signer mismatch, expiry, rollback, equal substitution, and cancellation. GREEN application
   orchestration over ports.

6. **CLI** — RED exact grammar, summaries, fixed errors, no ambient authority, and unchanged local
   refresh. GREEN explicit command composition.

7. **Verification** — Run mapped selectors and full serial tests. Run typecheck, build, prose,
   formatting, dependency, review, diff, and graph gates.

## Verification map

| Criterion | Evidence | Runnable command |
| --- | --- | --- |
| Strict canonical envelope and decoded bounds | Domain parser tests cover exact and +1 byte limits, fatal UTF-8, strict JSON, canonical base64, defensive byte ownership, and identity | `npx vitest run test/unit/capability/signed-capability-metadata-envelope.test.ts --maxWorkers=1` |
| Verification without active mutation | Application tests cover signer policy, signature/freshness order, exact bytes, cancellation, private-cause suppression, and importer reuse | `npx vitest run test/unit/application/verify-signed-capability-metadata.test.ts test/unit/application/import-capability-metadata.test.ts --maxWorkers=1` |
| Strict public HTTPS channel | Adapter tests cover canonical URLs, all-public DNS, pinned addresses, redirects, status, media type, response bounds, one deadline, and exact cancellation | `npx vitest run test/unit/infrastructure/http/strict-capability-metadata-channel.test.ts --maxWorkers=1` |
| Inert candidate identity and storage | Domain and store tests cover full identity, idempotence, capacity four, no-follow bounded reopen, tampering, atomic visibility, fail-closed crash debris and stale locking, latest observation, removal, and active-state independence | `npx vitest run test/unit/application/capability-metadata-candidate.test.ts test/unit/infrastructure/fs/local-capability-metadata-candidate-store.test.ts --maxWorkers=1` |
| Check and explicit activation | Application tests cover operation order, one end-to-end deadline, all-settled cancellation, active-only rollback authority, no install mutation, fresh activation verification, candidate reconstruction, signer mismatch, and expiry | `npx vitest run test/unit/application/check-capability-metadata-channel.test.ts test/unit/application/activate-capability-metadata-candidate.test.ts --maxWorkers=1` |
| Public CLI review flow | Integration evidence spans separate check, list, inspect, activate, and remove invocations, exact grammar failures, and existing package behavior. It proves active metadata remains unchanged until activation. | `npx vitest run test/integration/cli/capability-packages.test.ts --maxWorkers=1` |
| Inert review state is not runtime authority | One durable execution-chain test plants a contradictory signed-metadata candidate and proves attached execution, detached workers, children, resume, and replay use only admitted snapshots without candidate reads or network and credential fallback | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts --maxWorkers=1` |
| Layering and compiled product | Dependency, type, build, documentation, scoped format, and complete serial test gates | `npx vitest run test/integration/package/dependency-boundaries.test.ts --maxWorkers=1 && npm run typecheck && npm run build && npm run docs:ste && npx biome check src/application/*capability-metadata*.ts src/domain/capability/*capability-metadata*.ts src/infrastructure/fs/*capability-metadata*.ts src/infrastructure/fs/local-capability-package-store.ts src/infrastructure/http/*capability-metadata*.ts src/infrastructure/http/node-https-capability-bundle-transport.ts src/cli/main.ts test/unit/**/*capability-metadata*.test.ts test/integration/cli/capability-packages.test.ts && npx vitest run --maxWorkers=1` |

This evidence does not promise automatic package installation or private channel credentials. It
does not promise full TUF semantics, background polling, automatic activation, package conflict
handling, automatic rollback, or a trustworthy local clock. Publication remains a separate
operator decision.

## Verification evidence

The final mapped selector passed 153 tests across ten files. It covers the canonical envelope,
verification-only service, local importer reuse, strict HTTPS channel, and candidate storage.
It also covers explicit activation, the complete capability-package CLI regression file, and
runtime independence from inert candidate state.
The dependency-boundary selector passed 10 tests.

The complete host-permitted serial suite passed 3,366 tests across 238 files, with one file and four
tests intentionally skipped. The runtime suite passed 39 tests, with 33 platform-gated tests
skipped. Type checking, build, package dry-run, dependency resolution, formatting, documentation
prose, scoped lint, and `git diff --check` passed. The repository-wide lint gate retained one
pre-existing informational item outside the Issue #85 change set.
