# Decision Journal: Issue #83 — Install signed OCI capability bundles from private registries

**Issue**: #83

**Branch**: `codex/issue-83-private-oci-credentials`

**Started**: 2026-08-13

---

## Status

Implementation and mapped local verification are complete. The production dependency audit and
hosted CI evidence remain pending, so release verification is not complete.

## Specification

_Captured by the specification-capture skill on 2026-08-13. Source: extracted from Issue #83 and
the user-approved roadmap objective._

### Non-goals

- Do not create a registry login session or persist a username, password, access token, refresh
  token, or derived authorization header.

- Do not read Docker configuration or invoke a credential helper.

- Do not load an environment-variable secret or accept a password as a command argument.

- Do not add an interactive prompt, browser flow, device-code flow, OAuth authorization-code flow,
  refresh-token flow, or automatic token renewal.

- Do not add registry push, publisher signing, mutable tags, discovery, or version solving.

- Do not add automatic updates, freshness, revocation, rollback protection, or trust-root refresh.

- Do not change publisher verification, bundle validation, installed provenance, or admission.

- Do not change execution, child work, detached execution, recovery, replay, inspection, or removal
  authority.

- Do not let a package, workflow, project file, or model select credentials.

- Do not let those sources select a token realm, registry service, repository scope, or credential
  source.

### Failure modes

- **Timeouts and cancellation** — The existing one total OCI acquisition deadline starts before a
  credential callback can read secret input. The same signal covers the callback, DNS, token,
  manifest, and layer operations. Cancellation closes any opened response and publishes nothing.
  A credential result that settles after cancellation is cleared and starts no later request.

- **Partial failures** — A secret, token, manifest, layer, or publisher failure activates no package
  version. A bundle or durable publication failure also activates no version. No credential enters
  an error cause or durable recovery record. No authorization value enters either location.

- **Invalid input** — Missing paired flags, invalid usernames, empty secrets, or oversized secrets
  reject. Invalid UTF-8, NUL, carriage return, internal newline, or an extra line also rejects. An
  unsafe challenge, broader scope, redirect, schema change, or token bound failure rejects. Each
  error has a fixed public stage.

- **Missing context** — A credential callback is optional. When absent, the existing anonymous
  token exchange remains exact. A required but missing callback rejects before publication. A
  refused anonymous token request also rejects before publication.

### Interface contracts

- The public command shape is `flow packages install-oci <digest-reference>
  --certificate-issuer <https-url> --certificate-identity <exact> [--username <exact>
  --password-stdin]`. Username and password-stdin must appear together. No other command accepts
  them.

- The username is one bounded non-secret command argument. Flow treats it as private operational
  data: it is not printed or persisted. It cannot contain a colon, NUL, carriage return, newline, or
  unsupported control character.

- Password input is one non-empty UTF-8 record of at most 16,384 bytes. One terminal LF is removed.
  An embedded LF, a second LF, CR, NUL, fatal UTF-8, empty value, or byte 16,385 rejects. The secret
  reader never returns a JavaScript string.

- A credential callback is scoped to one `acquire` call. The registry invokes it only after it has
  validated the exact canonical HTTPS Bearer realm, service, and `repository:<name>:pull` scope.
  The callback receives that immutable challenge and the acquisition signal.

- The callback transfers one username and mutable secret buffer to the registry. The registry
  constructs RFC 7617 Basic credentials. It sends them only to that exact token-realm request. It
  clears owned mutable secret buffers in `finally`. Flow cannot overwrite JavaScript or HTTP
  implementation copies. Flow retains no copy after request settlement.

- Basic authorization never reaches a registry manifest, blob request, redirect, different realm,
  or second request. The returned Bearer token goes only to the original registry origin. The
  existing exact pull flow remains unchanged.

- The token request does not request offline access. Its strict response accepts one bounded
  `token` or `access_token` and rejects `refresh_token`, both token fields, extra fields, redirects,
  or non-success status.

- Anonymous installation is byte-for-byte and request-for-request compatible when no credential
  callback is supplied. Public pulls do not read secret input.

- Installed bundle identity and provenance do not contain the username, credential mode, token
  realm, password, Basic header, or Bearer token. Later operations remain offline.

## Current flow

```text
exact digest reference
  -> public registry manifest request
  -> exact Bearer challenge
  -> anonymous token request
  -> Bearer manifest and layer reads
  -> offline publisher verification
  -> atomic local publication
```

The registry already validates a canonical HTTPS realm, exact service, exact pull scope, public
address, no token redirect, one total deadline, and bounded response. It also validates
Bearer-origin isolation. The new behavior must reuse those gates. It must not create a parallel
authenticated fetch path.

## Approaches considered

| Approach | Strength | Weakness | Disposition |
| --- | --- | --- | --- |
| Reuse Docker configuration and credential helpers | Broad registry compatibility and familiar local setup | Imports ambient host files and executes helper programs; credentials become implicit authority | Rejected |
| Read a password or token from an environment variable | Easy automation and small CLI change | Environment values leak through process launch, CI configuration, crash tooling, and child inheritance mistakes | Rejected |
| Accept a password command argument | Minimal parser and transport work | Shell history, process listings, workflow logs, and invocation evidence can expose it | Rejected |
| Read one bounded secret from stdin after the exact challenge | Familiar non-interactive flow, no durable store, one deadline, and exact realm binding | Requires a new bounded secret-input port and honest best-effort memory clearing | **Selected** |
| Add a general credential-provider plugin | Future keychain and workload-identity flexibility | Introduces executable provider authority and lifecycle before one safe concrete flow exists | Later issue |

## Challenged assumptions

### “A private registry should authenticate the first manifest request”

Rejected for the selected token-authentication contract. CNCF Distribution starts with the resource
request, returns a Bearer challenge, and then authenticates the client to the authorization service.
Sending Basic credentials to the registry would expose them to a different authority and bypass the
challenge-bound realm and scope proof.

### “Docker login compatibility requires Docker credential files”

Rejected. Docker documents stdin input that keeps a password out of shell history and log files.
One exact Flow acquisition does not need persistent login behavior. Reading Docker configuration
would contradict Flow's existing rejection of ambient registry authority.

### “A Bearer token can follow the artifact to object storage”

Rejected. RFC 6750 identifies token disclosure and redirect as threats. The current client sends a
Bearer token only to the original registry origin and deliberately strips it from blob redirects.
Private authentication does not change that rule.

### “Best-effort zeroization proves no secret remains in memory”

Rejected as an overclaim. Mutable input buffers can be cleared, but Base64 conversion, header
strings, TLS libraries, and the JavaScript runtime can create copies that cannot be overwritten
deterministically. The enforceable contract is bounded lifetime, no retention, no logging, no
durable storage, and no later authority.

### “Credential input can happen before registry acquisition”

Rejected. Reading first would consume a secret for public artifacts and would sit outside the
registry's total deadline and validated challenge context. Challenge-driven acquisition proves the
realm, service, and scope before it requests the secret.

### “Flow can prove that a delegated token realm belongs to the registry operator”

Rejected. The Distribution protocol lets the authenticated registry select a separate realm and
service. Flow can validate HTTPS, public addressing, exact propagation, and pull scope. It cannot
prove common organizational ownership across those origins. The operator must trust the selected
registry and its token service. A registry-specific credential limits the residual risk.

The Bearer token is opaque. Flow confines its use but cannot verify its embedded grants.

## Decision

Add one optional per-acquisition credential callback to the strict OCI registry boundary. The
registry calls it only inside the validated Bearer-token stage and under the existing total signal.
The CLI supplies a callback only when both explicit username and password-stdin options are
present. The callback reads one bounded secret record and transfers its mutable bytes for one Basic
authorization request.

Keep the rest of the acquisition and install pipeline unchanged. The registry gets one strict
Bearer token and sends it only to the original registry. It verifies both exact layers and returns
the same artifact shape. It retains no authentication metadata. The installer, publisher verifier,
store, and capability snapshot remain credential-free. Admission, execution, recovery, and replay
also remain credential-free.

## Planned RED → GREEN → REFACTOR sequence

1. **Secret-input RED/GREEN** — Prove exact byte bounds and optional one LF. Prove fatal UTF-8,
   control, empty, cancellation, settlement, and mutable-buffer behavior through an injected stream.

2. **Registry RED/GREEN** — Prove one challenge-driven Basic request and exact callback context.
   Prove authorization isolation, anonymous compatibility, fixed failures, cleanup, deadline, and
   cancellation.

3. **CLI RED/GREEN** — Prove paired options and no secret read for invalid or anonymous commands.
   Prove private success, fixed failures, and no secret in output or errors.

4. **Atomic install RED/GREEN** — Prove authentication and publisher verification precede local
   publication and that installed provenance contains no authentication data.

5. **Offline regression RED/GREEN** — Prove list, inspect, verify, workflow use, and child work stay
   offline. Prove detached execution, recovery, and replay do not call a credential callback.

6. **Docs and release verification** — Update the public command, limits, sourcing, security,
   recovery, roadmap, and testing documentation. Run focused, full, runtime, coverage, package,
   documentation, dependency, graph, and hosted gates.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Bounded non-argv secret input | Contract/error | `npx vitest run test/unit/cli/bounded-secret-input.test.ts` | Exact 16,384-byte UTF-8 input and one terminal LF pass; empty, +1, multiline, CR, NUL, invalid UTF-8, cancellation, and read faults reject with fixed text | Interactive prompts or arbitrary binary passwords |
| Exact token-realm authentication | Security/integration | `npx vitest run test/unit/infrastructure/http/strict-oci-capability-registry.test.ts` | Basic appears once on the validated token realm; callback sees the exact service and pull scope; challenge, origin, scope, status, and token mutations reject | Direct registry Basic authentication or OAuth device flow |
| Authorization isolation and privacy | Security/error | `npx vitest run test/unit/infrastructure/http/strict-oci-capability-registry.test.ts test/unit/infrastructure/http/node-https-capability-bundle-transport.test.ts` | Basic never reaches registry/storage; Bearer never reaches storage; private canaries are absent from public error graphs and durable state; mutable request buffers are cleared after settlement | Heap forensics or TLS-library zeroization |
| CLI and anonymous compatibility | Behavioral/config | `npx vitest run test/integration/cli/capability-packages.test.ts test/integration/cli/main.test.ts` | Paired options invoke secret input only after challenge; anonymous form makes no secret call; invalid forms reject before acquisition | Persistent login sessions |
| Atomic publication and credential-free provenance | Data/recovery | `npx vitest run test/unit/application/install-signed-oci-capability-bundle.test.ts test/unit/infrastructure/fs/local-capability-package-store.test.ts test/integration/cli/capability-packages.test.ts` | Authentication, exact artifact, and publisher checks precede publication; store and lock files contain no canary after success or failure | Registry-side audit correctness |
| One total deadline, cancellation, and settlement | Behavioral/runtime | `npx vitest run test/unit/infrastructure/http/strict-oci-capability-registry.test.ts test/unit/cli/bounded-secret-input.test.ts` | Secret, DNS, token, manifest, and layer stalls settle under one signal; responses close; a late credential Buffer clears; no later phase starts | Remote service availability |
| Offline later use | Integration/recovery | `npx vitest run test/integration/cli/capability-packages.test.ts test/integration/cli/remote-capability-workflow.test.ts test/integration/supervisor/worker.test.ts` | One private install is followed by trapped list, inspect, verify, admission, attached child execution, detached snapshot execution, recovery, and replay; no private canary enters durable events | Availability of deleted local package bytes |
| Public documentation | Docs | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts test/integration/package/docs-ste.test.ts` | README, roadmap, sourcing, security, limits, recovery, and tests match the shipped private flow | Other credential protocols |
| Release quality | Release/runtime | `npm run check && npm run test:coverage && npm run test:runtime && npm run pack:check && npm audit --omit=dev --audit-level=low` | Build, type, lint, full tests, coverage, runtime, package, docs, and production dependency gates pass | Hosted private-registry uptime |

Every Issue #83 acceptance criterion maps to at least one row. Final evidence must identify platform
skips, network fixtures, untested registry variants, known evidence limits, and negative cases.

## Verification evidence

Local verification on 2026-08-15 has produced this evidence:

- The mapped Issue #83 selector passed 238 tests in 11 files. The selector covered bounded secret
  input, registry and transport isolation, installation, the store, and CLI behavior. It also
  covered offline workflow and worker use and public documentation. The registry file passed 63
  focused tests after exact cancellation, RFC 6750 token grammar, secret-boundary, and late-cleanup
  regressions were added.

- The first restricted run could not create temporary SRT Unix sockets. The same selector passed
  outside that desktop restriction. This was an environment limit, not a product failure.

- Type checking, the production build, scoped Biome, and `git diff --check` passed. The compiled
  CLI exists at `dist/cli/main.js`.

- The serial full suite passed 3,187 tests in 228 files. One file and four tests skipped through
  their declared platform conditions. The one-worker run limited memory pressure after the host
  restart.

- The one-worker coverage suite completed. It covered 82.98% of lines, 82.87% of statements,
  89.34% of functions, and 76.86% of branches.

- The unrestricted runtime suite passed 39 tests in eight files. Nine files and 33 tests skipped
  through platform conditions. A restricted first run failed only because the desktop sandbox
  denied home-directory fixtures and Unix sockets.

- The clean-package gate built the tarball and installed it in a temporary consumer. The installed
  CLI reached the Prime preparation boundary. The gate verified this policy digest:

  ```text
  5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4
  ```

- Graphify rebuilt 447 code files into 8,592 nodes and 19,702 edges. Its symbol graph shows the
  provider only in the CLI, installer, strict registry, and their tests. The secret reader has no
  store, workflow, worker, recovery, or replay edge.

- Stage 1 review maps every functional and documentation criterion to current passing evidence.
  Stage 2 security, correctness, performance, and maintainability review has no open P1, P2, or P3
  finding. Release quality remains partial because the dependency and hosted gates are pending.

- Registry and CLI tests use synthetic HTTPS responses and private canaries. They do not contact a
  live private registry, signature service, or trust-root service.

- Every Issue #83 documentation line passes the prose rules. The changed-document command and the
  public documentation integration tests pass against the current `origin/main` base.

- Whole-tree formatting passed over 448 files. Whole-tree lint passed with one inherited
  informational constructor notice in `src/application/external-harness-adapter.ts`. Scoped checks
  over every Issue #83 TypeScript and test file also pass.

- The production dependency audit found zero vulnerabilities. The Prime audit passed for the Node
  lock and 60 Python packages. Hosted CI evidence remains pending, so no claim of hosted release
  readiness is made yet.

## Primary references

- Docker login password input: <https://docs.docker.com/reference/cli/docker/login/#provide-a-password-using-stdin---password-stdin>

- CNCF Distribution token authentication: <https://distribution.github.io/distribution/spec/auth/token/>

- CNCF Distribution token scope: <https://distribution.github.io/distribution/spec/auth/scope/>

- OCI Distribution Specification: <https://github.com/opencontainers/distribution-spec/blob/main/spec.md>

- RFC 7617, Basic HTTP Authentication: <https://www.rfc-editor.org/rfc/rfc7617>

- RFC 6750, Bearer Token Usage: <https://www.rfc-editor.org/rfc/rfc6750>
