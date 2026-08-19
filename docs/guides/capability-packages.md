# Use capability packages

Flow supports six inert package types. Packages add reviewed data and declarations. They do not add
arbitrary executable extension code.

Read [Capability sourcing](../capability-sourcing.md) for the authority, acquisition, storage,
freshness, TUF, Sigstore, and recovery contracts.

## Package types

| Type | Local path | Manifest | Purpose |
| --- | --- | --- | --- |
| Agent Skill | `.flow/skills/<name>/` | `SKILL.md` | Bounded instructions and progressive resources |
| Verifier | `.flow/verifiers/<name>/` | `VERIFIER.yaml` | Command or zero-tool model verification |
| Command tool | `.flow/tools/<name>/` | `TOOL.yaml` | Declarative argv rendering through existing policy and sandbox controls |
| Workflow | `.flow/workflows/<name>/` | `WORKFLOW.yaml` | Inert packaged workflow roots and children |
| Policy | `.flow/policies/<name>/` | `POLICY.yaml` | Declarative narrowing of existing authority |
| Presentation | `.flow/presentations/<name>/` | `PRESENTATION.yaml` | Closed A2UI-profile layout and attributed static notes |

## Validate local packages

Use the command for the package type:

```sh
node dist/cli/main.js skills validate
node dist/cli/main.js skills list
node dist/cli/main.js skills inspect review

node dist/cli/main.js verifiers validate
node dist/cli/main.js verifiers list
node dist/cli/main.js verifiers inspect release-tests

node dist/cli/main.js tools validate
node dist/cli/main.js tools list
node dist/cli/main.js tools inspect git-status --version 1.0.0

node dist/cli/main.js workflows validate
node dist/cli/main.js workflows list
node dist/cli/main.js workflows inspect release-check --version 1.0.0

node dist/cli/main.js policies validate
node dist/cli/main.js policies list
node dist/cli/main.js policies inspect restricted-review --version 1.0.0

node dist/cli/main.js presentations validate .flow/presentations/concise/PRESENTATION.yaml
node dist/cli/main.js presentations list
node dist/cli/main.js presentations inspect concise --version 1.0.0
```

Validation performs bounded no-follow reads and rejects source drift. List output is metadata-only.
Inspect output excludes private package resource bytes.

Local and installed packages with the same identity fail closed. Flow does not apply precedence to
resolve a collision.

## Select packages

Workflow fields select exact package names and versions. Packaged workflows can also use this
locator form:

```text
workflow:<name>@<exact-version>
```

The compiled workflow and durable run snapshot bind every selected package digest. Detached
workers, child workflows, recovery, and replay use those frozen bytes. They do not reread live
package directories.

Read the [Workflow specification](../workflow-spec.md) for each package field and compatibility
rule.

## Build an exact bundle

A bundle source contains `BUNDLE.json` and any supported package trees. Pack it into one
deterministic `.flowpkg`:

```sh
node dist/cli/main.js packages pack examples/capability-bundle-source \
  --output /tmp/review-suite-1.0.0.flowpkg
```

The command reports the exact byte count and SHA-256 digest. It refuses links, special files,
executable payloads, unknown files, unsafe paths, source races, and an existing output.

If packing reports `commit_uncertain`, inspect and verify the exact output path. Do not retry
blindly.

## Install an exact bundle

### Public HTTPS with an out-of-band digest

```sh
node dist/cli/main.js packages install \
  https://packages.example.test/review-suite-1.0.0.flowpkg \
  --sha256 <64-lowercase-hex>
```

Communicate the digest through a channel the operator trusts. Flow permits no redirect, URL
credential, query, or fragment.

The HTTPS digest identifies exact bundle bytes. It does not authenticate a publisher. Use the
signed OCI form when policy requires proof that the admitted publisher signed those bytes.

### Publisher-authenticated OCI

```sh
node dist/cli/main.js packages install-oci \
  registry.example.test/flow/review-suite@sha256:<64-lowercase-hex> \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-certificate-identity>
```

The reference must use an exact manifest digest. Flow verifies the exact bundle bytes against the
supplied issuer and identity with the trusted Sigstore root in this release.

For a private registry, pass the password through standard input:

```sh
read -r -s registry_password
printf '%s\n' "$registry_password" | node dist/cli/main.js packages install-oci \
  registry.example.test/flow/private-suite@sha256:<64-lowercase-hex> \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-certificate-identity> \
  --username registry-user --password-stdin
unset registry_password
```

Do not place registry passwords in arguments or environment variables. Flow does not read Docker
configuration or invoke credential helpers.

## Inspect installed packages

```sh
node dist/cli/main.js packages list
node dist/cli/main.js packages inspect review-suite --version 1.0.0
node dist/cli/main.js packages verify
node dist/cli/main.js packages remove review-suite --version 1.0.0
```

Removing one exact installed version does not grant replacement or reinstall authority.

## Use signed metadata

Establish metadata authority from explicit local files:

```sh
node dist/cli/main.js packages metadata refresh capability-metadata.json \
  --sigstore-bundle capability-metadata.sigstore.json \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-metadata-certificate-identity>
node dist/cli/main.js packages metadata inspect
```

Check a signed public channel without changing active metadata:

```sh
node dist/cli/main.js packages metadata check \
  https://metadata.example.test/flow/capability-metadata.json \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-metadata-certificate-identity>
node dist/cli/main.js packages metadata candidates list
node dist/cli/main.js packages metadata candidate inspect sha256:<candidate-digest>
```

Candidate review is inert. Activation requires a new exact signer policy and a fresh clock reading.
Read [Capability sourcing](../capability-sourcing.md) before activation or remediation.

## Use a TUF repository

Initialize from one explicit local root:

```sh
node dist/cli/main.js packages repository init https://updates.example.test/ \
  --trusted-root ./root.json
node dist/cli/main.js packages repository check
node dist/cli/main.js packages repository candidates list
node dist/cli/main.js packages repository candidate inspect sha256:<candidate-digest>
```

Repository checks download and authenticate metadata and candidate bytes. They do not activate or
replace a package.

The operator can then choose one explicit boundary:

- Activate a first reviewed inert candidate.
- Replace one established compatible version.
- Authorize one finite exact first activation.
- Start bounded compatible update watching for one established package.

Each command requires an exact publisher. Replacement and watching require the existing compatible
surface. Policy-bearing bundles do not use automatic activation or replacement.

The finite first activator terminates after success or its attempt limit. It grants no later update
or reinstall authority. A settled package that is later removed stays removed.

Read the standards-based repository section in [Capability sourcing](../capability-sourcing.md)
before using these mutation paths.

## Security and recovery

- Package manifests are inert. Their declarations still pass ordinary policy and sandbox gates.
- Network acquisition never becomes a later runtime instruction.
- Exact source, publisher, bytes, digest, and active metadata must agree at mutation boundaries.
- Public errors omit credentials, registry bodies, paths, publisher values, and parser causes.
- Commit uncertainty can leave durable state that needs inspection before another mutation.

Read [Recovery and interruption safety](../recovery.md) before changing an uncertain package store,
candidate store, metadata state, repository generation, or automation lock.
