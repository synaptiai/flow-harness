# Decision Journal: Issue #60 — Support digest-pinned remote capability bundles

**Issue**: #60 | **Branch**: `codex/issue-60-remote-capability-bundles` | **Started**: 2026-08-09
**Base dependency**: PR #59, commit `0fecf0027c44ce12aea093e54ca88272cf1aa60f`

---

## Context and mapped flows

Gate 6 has three provider-neutral capability ABIs: Agent Skills, versioned verifier packages, and
versioned declarative command-tool packages. Each ABI already has strict local discovery, explicit
workflow selection, an immutable run snapshot, portable provenance, and replay-bound evidence. The
missing capability is distribution. Today users copy directories into a project by hand, which
provides no transport identity, installation transaction, deterministic lock state, or repeatable
inspection of remotely published bytes.

Remote acquisition must not become a second runtime or a route around the existing capability
validators. Flow must terminate the network boundary before workflow admission, preserve the exact
downloaded bytes locally, and feed only previously supported inert package forms into the existing
snapshot boundary.

### Publisher: build a portable bundle

1. A publisher prepares a bounded source directory containing bundle metadata and one or more
   existing Agent Skill, verifier, or command-tool packages.
2. Flow reuses the existing package validators, refuses symbolic links and special files, and emits
   one deterministic strict-JSON bundle with no archive, dependency graph, or executable hook.
3. The publisher computes and distributes the SHA-256 digest out of band with the bundle URL.
4. Rebuilding unchanged source bytes produces the same bundle bytes and digest.

### Operator: install and audit exact remote bytes

1. The operator invokes an explicit install command with one public HTTPS URL and one expected
   lowercase SHA-256 digest.
2. Flow sends no ambient credentials, cookies, or authorization headers, follows no redirects,
   applies one deadline and byte limit, buffers only within that limit, then hashes the exact bytes.
3. Flow checks the exact byte count and expected digest before parsing any bundle content.
4. Flow validates every contained package through its existing ABI. Any failure rejects the whole
   bundle and leaves active installation state unchanged.
5. Flow publishes the immutable blob first and atomically publishes a deterministic lock entry
   last. Repeating the exact install is idempotent; an identity collision with different bytes
   fails closed.
6. Listing, inspection, verification, and removal are local metadata operations and never invoke a
   package driver.

### Workflow author: select an installed contribution

1. Existing `skills`, packaged verifier, and `toolPackages` declarations remain unchanged.
2. Catalog composition merges local project packages with packages from lock-selected immutable
   blobs.
3. Any name, version, provider-facing tool, or bundle identity collision rejects the complete
   catalog; no precedence rule silently chooses a winner.
4. Admission snapshots only the exact selected package bytes. Bundle name, version, and digest are
   embedded in portable provenance and therefore in the existing package digest.

### System: execute, detach, recover, and replay offline

1. Workflow validation and run admission read only local content-addressed blobs referenced by the
   project lock. A missing, corrupt, replaced, or unreferenced blob fails closed.
2. `run_started`, detached job records, child ledgers, workers, and recovery carry the existing
   immutable capability snapshot. They do not carry a URL or a fetch instruction.
3. Agent Skills remain model-readable prompt resources; model verifiers remain bounded rubrics;
   command verifiers and command tools retain their existing policy and sandbox paths.
4. Replay derives package identity from the attached snapshot and never consults the live lock,
   local package catalog, remote source, or publisher metadata.

## Research and challenged assumptions

- Pi's package manager proves useful install/list/update ergonomics across npm, Git, and local
  sources. It also explicitly states that packages have full system access, runs dependency
  installation for package sources, loads in-process extensions, and reconciles mutable package
  state. Reusing it would import Pi's trust and settings semantics into Flow rather than merely
  transport bytes. Flow will reuse neither `DefaultPackageManager` nor `DefaultResourceLoader` for
  this boundary. See <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>.
- OMP's capability providers and source precedence demonstrate broad ecosystem compatibility, but
  "first wins" collision handling makes the selected resource depend on discovery order. Flow
  requires an explicit selection to resolve one unambiguous identity, so local/installed name
  collisions fail rather than inherit OMP precedence. See
  <https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md>.
- OCI descriptors provide the correct primitive: verify expected size and digest before consuming
  untrusted content, and treat a digest as a content identifier. Full OCI distribution would add
  registry authentication, manifests, layers, and tar extraction that this first bundle ABI does
  not need. Flow adopts the descriptor rule, not the container image format. See
  <https://github.com/opencontainers/image-spec/blob/main/descriptor.md>.
- npm lockfiles validate the value of exact `resolved` plus `integrity` state for reproducibility,
  but npm lifecycle scripts and dependency resolution are outside the capability safety floor.
  Flow uses an exact source locator plus digest lock without invoking npm. See
  <https://docs.npmjs.com/cli/configuring-npm/package-lock-json> and
  <https://docs.npmjs.com/cli/using-npm/scripts/>.
- The Update Framework distinguishes target-file hashes from publisher trust, freshness, rollback
  protection, expiry, and delegated signing authority. A caller-supplied SHA-256 digest proves
  exact bytes only. It does not prove who published them or whether they are current. Signed
  discovery and update metadata remain a future registry layer. See
  <https://theupdateframework.github.io/specification/>.
- A tar or zip bundle initially appeared more conventional. It was rejected because traversal,
  duplicate entries, symlinks, hard links, device nodes, decompression ratios, and platform-specific
  metadata create a large parser and extraction surface. Strict JSON with canonical base64 content
  has modest size overhead but no extraction semantics.
- Materializing decoded packages into catalog directories initially appeared to maximize reuse. It
  was rejected because it creates a second mutable truth and a verification-to-snapshot race. The
  original content-addressed bundle remains the only stored package source. Catalog admission
  reopens, rehashes, and revalidates each locked blob once, then snapshots consume the captured
  immutable in-memory content.
- Automatic lockfile synchronization initially appeared necessary for fresh clones. It was rejected
  in v1 because a reviewed project file could otherwise make an operator fetch an arbitrary URL.
  Installation always requires the URL on the current command line. Teams may commit exact bundle
  blobs or repeat the explicit digest-pinned install in bootstrap automation.
- "Inert" applies to installation, not eventual behavior. A selected Agent Skill or model rubric
  can influence a model, and an existing command verifier can describe a sandboxed command. Remote
  bundles execute nothing while installing, listing, inspecting, verifying, or removing; later
  workflow execution retains each package type's existing trust and authority model.

## Specification

_Captured by specification-capture on 2026-08-09. Source: Issue #60, the approved design
discussion, and repository contracts._

### Non-goals

- Does not load package-supplied JavaScript, TypeScript, Python, Wasm, native libraries, Pi/OMP
  extensions, providers, middleware, hooks, install scripts, dependency manifests, or executables.
- Does not add npm, Git, OCI-registry, SSH, authenticated/private-registry, mutable tag, version
  range, redirect, mirror, or automatic lockfile synchronization support.
- Does not provide publisher signatures, transparency logs, revocation, freshness, expiry, rollback
  protection, delegated trust, or a claim that a digest authenticates a publisher.
- Does not automatically discover, install, update, enable, or select any package. A network request
  occurs only for an explicit operator install command containing the exact URL and digest.
- Does not add new capability kinds, widen the existing package ABIs, or weaken permission, policy,
  approval, sandbox, graph, evidence, replay, or recovery rules.
- Does not make skills or model rubrics prompt-injection-proof, make command verifiers read-only, or
  make SRT equivalent to a VM-grade hostile-code boundary.
- Does not add user-global packages, a hosted marketplace, a remote package service, garbage
  collection of arbitrary files, or multi-host/distributed installation locking.
- Does not make remote availability part of workflow execution, detached work, recovery, replay,
  or inspection of an existing run.

### Failure modes

- **Timeouts** — DNS, connection, TLS, response, and body reads share one bounded install deadline.
  Timeout aborts acquisition, persists no lock entry, activates no package, and reports one bounded
  typed error. There is no background continuation or retry.
- **Partial failures** — The response blob is published before the lock entry. A crash may leave an
  unreferenced content-addressed blob, which discovery ignores. A lock entry is never published
  before the complete blob is durable. Removal publishes the new lock state before optional orphan
  cleanup, so a crash cannot reactivate a removed package.
- **Invalid input** — Non-public or non-HTTPS URLs, credentials/query/fragment in a URL, invalid or
  uppercase digests, redirects, non-success status, conflicting length, malformed/ambiguous JSON,
  unknown fields, noncanonical base64, unsafe paths, unsupported kinds, invalid contained package
  contracts, collisions, and every byte/file/package bound reject before activation.
- **Missing context** — A missing project root, lock, locked blob, source URL, expected digest, exact
  bundle identity, or requested installed package produces a typed error. Workflow execution never
  attempts to repair missing context from the network.
- **Dependency outage** — Remote source or DNS/TLS failure affects only the explicit install command.
  Already installed packages, workflow validation, attached/detached runs, recovery, and replay
  remain local and deterministic.
- **Corruption or tampering** — Lock and blob reads are bounded, no-follow, regular-file-only, and
  identity checked. Bundle bytes are rehashed and revalidated before discovery and again when a
  new catalog is admitted; selected-package snapshots consume that catalog's captured immutable
  bytes without reopening mutable storage. A same-user attacker who can replace both project lock
  and blob remains inside the documented trusted-local-configuration boundary.
- **Concurrency** — Project package mutations serialize through one owner-only local lock. A live
  or exited owner causes a bounded busy error. Flow never automatically retires the pathname
  because stale inspection followed by unlink cannot exclude a replacement owner. After verifying
  that no mutation is active, an operator may remove only the exact stale lock. Competing installs
  cannot use last-writer-wins or lose a lock entry.
- **Resource exhaustion** — URL, response, bundle, JSON depth/node count, package count, file count,
  file bytes, decoded aggregate bytes, lock entries, lock bytes, error text, and metadata are
  bounded. Response and file reads stop at one byte beyond their limit, and a shared source-tree
  budget stops traversal before parsing excess packages.
- **Identity collision** — The same bundle `(name, exact version)` with the same digest is an
  idempotent install. The same identity with different bytes, or any local/installed contribution
  name collision, rejects the complete operation/catalog. Updates require a new exact bundle
  version and explicit install; there is no precedence fallback.
- **Removal cleanup failure** — Once the new lock is durable, the bundle is inactive even if its
  unreferenced blob cannot be deleted. The command reports bounded cleanup status and verification
  ignores the orphan.
- **Commit uncertainty** — Lock replacement precedes parent-directory sync. A failure after rename,
  or after a completed mutation but before mutation-lock release, reports `commit_uncertain` and
  requires list/verify reconciliation before retry. If the operation already failed, a release
  failure remains secondary evidence and does not replace the primary typed error.

### Interface contracts

Published `.flowpkg` v1 is strict UTF-8 JSON. Object keys are unique, strings are valid Unicode,
numbers are safe integers, unknown fields fail, and package/file arrays are canonical and unique.
The exact response bytes—not a reserialized object—produce the transport digest.

```json
{
  "apiVersion": "flow.synapti.ai/v1alpha1",
  "kind": "CapabilityBundle",
  "metadata": {
    "name": "review-suite",
    "version": "1.0.0",
    "description": "Review capabilities for a Flow project.",
    "license": "Apache-2.0",
    "compatibility": "Flow v1alpha1 capability ABIs"
  },
  "spec": {
    "packages": [
      {
        "kind": "agent-skill",
        "files": [
          { "path": "SKILL.md", "contentBase64": "LS0t..." }
        ]
      },
      {
        "kind": "verifier-package",
        "manifestBase64": "YXBpVmVyc2lvbjo..."
      },
      {
        "kind": "tool-package",
        "manifestBase64": "YXBpVmVyc2lvbjo..."
      }
    ]
  }
}
```

Package identity is derived from contained bytes by the existing parser; it is not duplicated as
trusted bundle metadata. Entries are ordered by `(kind, derived name, exact version when present)`.
Agent Skill files are ordered by portable relative path. Partial paths, absolute paths, dot
segments, backslashes, control characters, duplicates, and noncanonical base64 fail.

The project lock is strict deterministic JSON and is intended for source review. Its entries are
ordered by bundle name and exact version. `source` never becomes run evidence or a fetch instruction.

```json
{
  "apiVersion": "flow.synapti.ai/v1alpha1",
  "kind": "CapabilityLock",
  "bundles": [
    {
      "name": "review-suite",
      "version": "1.0.0",
      "source": "https://packages.example.test/review-suite-1.0.0.flowpkg",
      "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "bytes": 12345
    }
  ]
}
```

The initial operator surface is:

```text
flow packages pack <source-directory> --output <bundle.flowpkg>
flow packages install <https-url> --sha256 <64-lowercase-hex>
flow packages list
flow packages inspect <name> --version <exact>
flow packages verify
flow packages remove <name> --version <exact>
```

`pack` accepts one strict bundle metadata manifest plus conventional `skills/`, `verifiers/`, and
`tools/` source roots and uses the same no-follow validators as live local packages. It writes
canonical bundle bytes atomically and reports name, version, byte count, and `sha256:<hex>`.

`install` is the only network operation. It accepts exactly one explicit public HTTPS URL, one
expected digest, no redirect, no URL credentials/query/fragment, no ambient authentication, one
deadline, and one response limit. It verifies size and digest before parsing, validates all package
entries, writes the content-addressed blob, and atomically updates the lock.

`list`, `inspect`, `verify`, and `remove` are local. They never invoke a package driver, expose
encoded private package content, or contact a recorded source. Inspection reports bundle identity,
source, bytes, digest, contained package identities, license/compatibility, and validation state.

The content-addressed blob path includes the lowercase SHA-256 hex. Installed package provenance is
portable and has the conceptual form
`.flow/packages/sha256/<bundle-digest>/<kind>/<package-name>`. Existing package snapshot digests
therefore bind the bundle identity without adding a second execution-time package protocol.

## Trust boundaries and abuse analysis

| Boundary | Attacker-controlled data | Existing/new control | Residual risk |
| --- | --- | --- | --- |
| Publisher -> operator | URL, bundle bytes, advertised digest | Explicit CLI digest, public HTTPS, no redirect/auth, bounded body | Digest may come from the same compromised publisher and is not authenticity |
| Network -> parser | Status, length, stream bytes, JSON | Deadline, size cap, hash exact bytes before strict parse | Public TLS/CA and DNS remain platform dependencies |
| Bundle -> package ABI | Metadata, paths, base64, skill/rubric/command manifest | Strict schema, canonical bytes, existing package validators, no code/hooks | Selected skills/rubrics can influence models; command verifiers can later execute under existing sandbox |
| Package store -> catalog | Lock and blob files | Owner-only atomic writes, no-follow reads, rehash/revalidate, collision refusal | Same trusted OS user can replace both lock and bytes |
| Catalog -> run | Selected package snapshot | Existing immutable capability snapshot and requirement reconciliation | Author still must review workflow and selected content |
| Run -> replay | Durable snapshot/evidence | Existing digest reconstruction; no URL or live catalog lookup | Historical v1 snapshot contract remains the authority |

## Coupling analysis

```text
publisher sources -> Flow packer -> canonical .flowpkg -> HTTPS server
                                                    |
operator URL + digest -> bounded fetch -> hash bytes -> strict bundle validator
                                                    |
                                                    v
                                    blob publish -> atomic project lock
                                                    |
local package roots -------------------------------+-> combined capability catalog
                                                       |
workflow exact selection -> existing resolver --------+-> immutable run snapshot
                                                          |
                                                          +-> Pi / verifier adapters
                                                          +-> detached and child transport
                                                          +-> recovery and replay
```

- Bundle domain code owns strict JSON shape, bounds, canonical ordering, derived identities, and
  exact digest verification. It imports no filesystem, network, Pi, workflow, or executor types.
- Acquisition is an application port. The production HTTPS adapter owns TLS requests, redirect
  refusal, deadline, status, response length, bounded streaming, and no-credential behavior.
- Filesystem infrastructure owns the project mutation lock, content-addressed blob publication,
  deterministic lock replacement, bounded no-follow reads, and orphan cleanup.
- Catalog composition owns local/installed collision detection and converts a verified bundle entry
  to the same existing package snapshot input. It does not execute packages or fetch sources.
- CLI composition is the only caller allowed to acquire or mutate installation state. Workflow
  validation calls only catalog read/snapshot functions.
- Existing scheduler, supervisor, Pi adapter, verifier executor, command recorder, policy, sandbox,
  event schemas, and replay logic require no remote source awareness.

## Approaches considered

The weighted comparison used ecosystem value 25%, roadmap unlock 20%, safety fit 20%, reuse of
proven seams 15%, stacked-PR isolation 10%, and product differentiation 10%.

| Next milestone | Score / 5 | Strength | Primary weakness | Disposition |
| --- | ---: | --- | --- | --- |
| Digest-pinned inert capability bundles | 4.45 | Completes distribution for all three existing ABIs | Adds acquisition and publisher-trust boundary | **Selected** |
| Versioned workflow packages | 3.70 | Reuses compiler and snapshot model | Does not solve distribution and workflows are already portable | Later Gate 6 |
| VM or managed sandbox backend | 3.85 | Strongest safety improvement before executable extensions | Backend-specific and does not unlock ecosystem sharing | Required before hostile executable packages |
| Prime-style adaptive candidate refinement | 3.80 | Highest long-term harness differentiation | Activation/trust is premature without package/evaluation primitives | Gate 7 after distribution |

Equal weighting still ranked bundles first at 4.33 versus 3.67. A safety-heavy 40% scenario lowers
the bundle choice because existing command verifiers can describe sandboxed commands; under that
scenario a VM backend ranks first. The decision remains bundles because installation executes
nothing, selection remains explicit, and this slice does not introduce executable package code.
The sensitivity result is an explicit sequencing constraint: do not add executable extensions before
the stronger sandbox milestone.

Transport alternatives were evaluated separately:

| Transport | Advantages | Failure surface | Disposition |
| --- | --- | --- | --- |
| Reuse Pi npm/Git package manager | Proven UX, ecosystem compatibility | Full-trust code, dependency scripts, mutable settings, provider coupling | Rejected |
| OCI artifact by digest | Standard registry/auth/content addressing | Registry protocol, manifests, layers, tar extraction, client dependency | Deferred registry adapter |
| Git checkout pinned to commit | Familiar publishing and review | Credentials, submodules, filters, worktrees, checkout and ref semantics | Rejected for v1 |
| Tar/zip download by SHA-256 | Conventional artifact | Traversal, links, duplicates, bombs, platform metadata | Rejected |
| Strict JSON blob by SHA-256 | Small ABI, no extraction/hooks, exact bytes, easy offline audit | Base64 overhead, custom publishing format | **Selected** |

## Decision

Implement a Flow-owned strict JSON `CapabilityBundle` that contains only the three existing package
forms. Add a deterministic packer, explicit digest-pinned public-HTTPS installer, content-addressed
project blob store, atomic reviewable lock, and local metadata/removal commands. Compose installed
entries with existing local catalogs and bind bundle identity into portable package provenance.

Every download is initiated only by the current install command. Exact bytes are bounded and hashed
before parse. Installation executes nothing. Workflow validation and every execution/recovery path
operate offline from locally verified blobs and existing immutable snapshots. Keep publisher
signatures, registries, mutable updates, automatic synchronization, executable extensions, new
package kinds, and user-global installation out of v1.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Bounded mixed bundle and exact identity | Contract/data | `npx vitest run test/unit/capability/capability-bundles.test.ts` | Canonical mixed bundles derive existing identities; exact size/digest and deterministic pack bytes match | Publisher authenticity or registry compatibility |
| Digest-before-parse secure remote install | Security/error | `npx vitest run test/unit/infrastructure/http/strict-capability-bundle-fetcher.test.ts test/unit/infrastructure/http/node-https-capability-bundle-transport.test.ts test/integration/cli/capability-packages.test.ts -t "install|digest"` | HTTPS only, no credentials/query/fragment/redirect/auth, public-address pinning, shared deadline/body cap, mismatch rejection, and zero store mutation before validation | Private registries, redirects, retries, mirrors, or signatures |
| Malformed/oversized/unsafe rejection | Adversarial | `npx vitest run test/unit/capability/capability-bundles.test.ts test/unit/infrastructure/fs/local-capability-package-store.test.ts test/integration/cli/capability-packages.test.ts -t "rejects|refuses|unsafe|corrupt"` | Duplicate keys/identities/paths, unknown fields, noncanonical base64, size/count overflow, symlinks, source races, and corruption fail closed | Protection from a trusted same-user replacing lock and bytes together |
| No install-time code or authority | Security/contract | `npx vitest run test/unit/capability/capability-bundles.test.ts test/integration/cli/capability-packages.test.ts` | Only the three existing inert ABIs parse; metadata commands invoke no driver and only explicit install calls the injected fetcher | Safety of later explicitly selected skill/rubric/command behavior |
| Existing package operations and provenance | Integration | `npx vitest run test/unit/capability/installed-capability-catalog.test.ts test/integration/cli/remote-capability-workflow.test.ts` | Installed skills/verifiers/tools list, inspect, validate, select, snapshot, execute, and carry bundle-bound provenance through the existing path | New package kinds or changed workflow syntax |
| Deterministic atomic installation state | Filesystem/adversarial | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts` | Parent-synced blob-before-lock publication, exact lock ordering, idempotency, fail-closed stale locks, bounded no-follow reads, commit-uncertain fault boundaries, primary-error preservation, corruption, and orphan behavior match the journal | Multi-host/distributed transactions or automatic stale-lock reaping |
| Explicit update/removal and collision refusal | Behavioral/error | `npx vitest run test/unit/infrastructure/fs/local-capability-package-store.test.ts test/unit/capability/installed-capability-catalog.test.ts test/integration/cli/capability-packages.test.ts` | Same identity/same digest is stable; changed bytes, bundle/package/tool conflicts, ambiguous state, and explicit lock-first removal behave deterministically | Mutable same-version replacement or automatic GC |
| No runtime network dependency | Integration/holdout | `npx vitest run test/integration/cli/remote-capability-workflow.test.ts test/integration/cli/capability-packages.test.ts` | Execution and replay remain valid after live package removal with a throwing fetcher; list, inspect, verify, and remove call the fetcher zero times | Availability of a missing blob during new admission |
| Local package compatibility | Regression | `npx vitest run test/unit/capability/local-agent-skills.test.ts test/unit/capability/local-verifier-packages.test.ts test/unit/capability/local-tool-packages.test.ts test/integration/cli/skills.test.ts test/integration/cli/verifier-packages.test.ts test/integration/cli/tool-packages.test.ts` | Existing local-only discovery, selection, errors, provenance, and CLI output remain compatible | Silent precedence between local and installed duplicates |
| Publishing and operator CLI | Integration/runtime | `npx vitest run test/integration/cli/capability-packages.test.ts && npm run build && node dist/cli/main.js packages pack examples/capability-bundle-source --output /tmp/flow-review-suite.flowpkg` | Pack/install/list/inspect/verify/remove have bounded deterministic output; pack reports reproducible bytes/digest | Hosted publishing service |
| Public docs and examples | Docs/contract | `npx vitest run test/scaffold/community-files.test.ts -t "remote capability bundles"` | README, architecture, security, sourcing, workflow spec, roadmap, examples, and contribution docs agree on trust/offline/update/non-goal behavior | Marketplace availability or benchmark superiority |
| Full release quality | Release | `npm run check && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Formatting, lint, typecheck, all tests, build, runtime, coverage, clean packed CLI, and production dependency audit pass | Hosted CI or provider credentials |

## Verification evidence

- Issue-owned formatting and lint scopes pass across every changed source, test, example, decision,
  and public documentation file. Global formatting was intentionally not applied to unrelated
  user-owned untracked `.codex/` and `graphify-out/` content.
- TypeScript type checking passes with no diagnostics. The focused Issue #60 matrix passes 104 tests
  across eight files.
- Final full coverage passes 120 test files and 1,529 tests: 84.35% statements, 77.87% branches,
  93.27% functions, and 84.44% lines.
- The production build passes. The compiled runtime matrix passes 21 tests across three files.
- Clean tarball installation and CLI execution pass for
  `synaptiai-flow-harness-0.0.0.tgz`; the production dependency audit reports zero vulnerabilities.
- Three independent adversarial passes covered security, test/error boundaries, and hidden holdout
  scenarios. Every P1/P2/P3 finding was fixed and regression-tested; all three final convergence
  passes returned zero findings.

## Planned RED -> GREEN -> REFACTOR sequence

1. [x] Define strict duplicate-key-aware JSON and bounded mixed bundle parsing; watch exact invalid
   and valid package tests fail before implementation.
2. [x] Add deterministic source packing and exact raw-byte digest/size verification.
3. [x] Add the explicit HTTPS acquisition port and production adapter with redirect, credential,
   timeout, status, length, and streaming bounds.
4. [x] Add atomic content-addressed blob and deterministic lock publication, same-host mutation
   serialization, idempotency, corruption detection, and removal.
5. [x] Compose verified installed bundle entries with the three local catalogs, refuse every
   collision, and bind virtual bundle provenance into existing snapshots.
6. [x] Add package CLI commands and prove install is the sole network caller.
7. [x] Exercise an installed mixed bundle through the existing snapshot, attached execution, and
   replay path with a fetcher that fails if runtime code calls it; retain the existing detached and
   child snapshot-transport regression suites.
8. [x] Add reproducible public example/source bundle and update all public contracts.
9. [x] Run focused, full, coverage, runtime, clean-install, audit, mutation, holdout, and adversarial
   verification; fix every finding before PR.

## Implementation tasks

1. [x] Capture and validate the specification, design, coupling, threat, and criterion map.
2. [x] Implement the strict bundle domain contract and deterministic pack representation with TDD.
3. [x] Implement bounded HTTPS acquisition and digest-before-parse orchestration with TDD.
4. [x] Implement the atomic project bundle store and lock with TDD.
5. [x] Implement installed/local catalog composition and immutable provenance with TDD.
6. [x] Implement install/list/inspect/verify/remove/pack CLI behavior with TDD.
7. [x] Prove offline snapshot execution/replay behavior and local compatibility.
8. [x] Update public documentation, examples, security guidance, and roadmap status.
9. [x] Complete release-quality verification and independent adversarial review.
