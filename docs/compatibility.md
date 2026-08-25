# Compatibility policy

Flow is a public alpha preview. It provides a tested compatibility boundary without claiming that
the product, workflow format, or npm package is stable.

The supported npm entry point is the `flow` executable. The package doesn't provide a supported
JavaScript or TypeScript import. Flow verifies selected historical artifacts through an immutable
corpus so that maintainers can detect unintended changes before publication.

`0.1.0-alpha.4` is the first checkpoint governed by this policy. The published alpha.3 package
doesn't contain `flow compatibility check` and retains the limits in its
[historical release notes](releases/0.1.0-alpha.3.md).

## Check the installed release

After you install a preview whose help lists the command, run the read-only compatibility check
from any directory:

```sh
flow compatibility check
```

The command reads only the corpus installed inside the npm package. It doesn't discover a Flow
project, read provider credentials, contact a network service, create a run, or change project
files.

A compatible installation returns exit status 0 and one JSON report. An incompatible artifact or
safe artifact-read failure returns exit status 1 and the complete report. Invalid command syntax
returns exit status 2.

The report has this shape:

```json
{
  "version": "flow.compatibility-report/v1",
  "flow": {
    "package": "@synapti/flow-harness",
    "version": "<installed-version>"
  },
  "corpus": {
    "version": "flow.compatibility-corpus/v1",
    "id": "alpha-compatibility-v1",
    "sha256": "<manifest-sha256>"
  },
  "overall": "compatible",
  "artifacts": [
    {
      "id": "alpha1-verify-installation-workflow",
      "kind": "authored_workflow",
      "producer": {
        "package": "@synaptiai/flow-harness",
        "version": "0.1.0-alpha.1"
      },
      "sourceSha256": "<artifact-sha256>",
      "state": "compatible",
      "category": "compatible",
      "observations": {
        "apiVersion": "flow.synapti.ai/v1alpha1",
        "workflowId": "verify-installation",
        "workflowDigest": "<compiled-workflow-sha256>",
        "nodeCount": 2,
        "criterionCount": 1
      }
    }
  ]
}
```

The actual report includes one ordered result for every artifact. It contains identities, counts,
states, categories, and evidence hashes. It doesn't contain workflow source, command output,
timestamps, credentials, or filesystem paths.

### Interpret artifact categories

| Category | Meaning | Operator action |
| --- | --- | --- |
| `compatible` | The source identity and expected semantic observations match. | No action is needed. |
| `source_missing` | A manifest-declared artifact isn't present. | Reinstall the exact package and rerun the check. |
| `resource_limit` | A manifest or artifact exceeds its fixed read limit. | Treat the package as invalid. Don't increase the limit to admit unknown bytes. |
| `artifact_identity_mismatch` | Artifact bytes or file identity changed. | Reinstall from an immutable source and verify the package provenance. |
| `artifact_malformed` | The artifact isn't valid UTF-8, strict JSON, workflow YAML, or run evidence for its declared kind. | Keep the report and exact package version, then report a compatibility defect. |
| `semantic_mismatch` | The artifact parses, but its workflow identity, run verdict, sequence, or evidence hashes changed. | Don't rely on the release as a compatible replacement. Report the changed observation. |

The command can also emit a stable diagnostic before it has a trustworthy manifest:

| Diagnostic | Meaning |
| --- | --- |
| `corpus_missing` | The installed manifest or corpus directory is missing. |
| `corpus_malformed` | The manifest has invalid encoding, duplicate JSON keys, unsafe paths, invalid fields, or an invalid file type. |
| `unsupported_corpus` | The installed corpus uses an unknown version. |
| `resource_limit` | The manifest exceeds its fixed size or complexity limit. |
| `artifact_identity_mismatch` | The corpus directory or manifest changed while Flow read it. |

These diagnostics don't include the rejected source or a private path.

## Know which surfaces are supported

Flow classifies each externally visible surface separately. One surface's version doesn't make
another surface stable.

| Surface | Current classification | Consumer contract |
| --- | --- | --- |
| CLI invocation | Supported alpha surface | Call the `flow` executable with a documented command. Exit status and documented output apply to that command. |
| Authored workflow and configuration schemas | Supported alpha surface | Author only fields documented by the [workflow specification](workflow-spec.md) and [configuration guide](configuration.md). Expect prerelease changes to require migration. |
| Public machine output | Supported per command | Depend only on documented, versioned fields or a named public projection. Don't treat unlisted fields or diagnostic prose as stable. |
| Durable run, session, supervisor, package, and evaluation records | Flow-owned persistence | Read and recover them through Flow commands. Don't author, edit, or import them as an application database. |
| Capability packages | Versioned alpha contracts | Use the exact package kind, schema, digest, authority, and activation rules in [Use capability packages](guides/capability-packages.md). A capability version isn't an npm module ABI. |
| Presentation packages and catalogs | Versioned, host-bounded contracts | Use only the documented Flow A2UI profile and exact catalog version. A presentation cannot gain workflow, tool, provider, file, or policy authority. |
| Compiled JavaScript modules and declaration files | Unsupported internal implementation | Package-name imports and undeclared subpaths fail. File presence in the npm archive doesn't create a public API. |

### CLI invocation

The npm manifest declares this executable:

```json
{
  "bin": {
    "flow": "dist/cli/launcher.js"
  },
  "exports": {}
}
```

Node's `exports` field defines named package entry points and prevents other package-name subpath
imports. Flow uses an empty map because it currently exports no library entry point. For the
underlying Node behavior, read [Package entry points](https://nodejs.org/api/packages.html#package-entry-points).

These forms are unsupported and fail by design:

```js
await import("@synapti/flow-harness");
await import("@synapti/flow-harness/dist/cli/main.js");
```

An absolute filesystem import can bypass Node's package-name encapsulation. It remains unsupported,
can break in any prerelease, and must not be used as a compatibility workaround.

### Authored schemas

An authored document is input that a person or generator intentionally creates. Examples include
workflow YAML, project configuration, an evaluation plan, and an inert capability package manifest.
Its own `apiVersion`, `kind`, or format version selects its parser contract.

The compatibility corpus proves only the historical examples listed in the corpus. It doesn't
prove that every file accepted by an older prerelease remains accepted.

### Public output

A public output is a documented result written by a CLI command or presentation projector. A
version field governs only the object that contains it. Unversioned diagnostic text is for people
and can change when remediation improves.

When automation needs a field that isn't documented, open a proposal before depending on it. The
proposal must define the field's authority, privacy, bounds, failure behavior, and version owner.

### Durable records

Durable records let Flow recover exact state after interruption. They contain more detail and have
stricter invariants than public output. Their schemas can add replay defaults while retaining an
old record's run identity, event sequence, verdict, and hashes.

Never edit a ledger to make it pass a newer parser. Keep the original bytes and use the Flow release
that created them when a later release can't read them.

### Capability and presentation packages

Capability packages are inert inputs until an operator admits and activates exact bytes. Their
schema version and package version don't expose Flow's TypeScript modules. Presentation packages
can arrange or annotate a closed host catalog. They don't execute code or control the run.

## Understand the current corpus

The current source corpus binds two artifacts to the verified immutable
`@synaptiai/flow-harness@0.1.0-alpha.1` archive. The historical package used the previous npm scope.
Its archive SHA-256 is
`3a8d76564dae33e2c43951c483a3cd69b146fa7788ce311949d5242cb0229568`.

| Artifact | What the current release proves |
| --- | --- |
| `verify-installation.workflow.yaml` | The production compiler preserves the API version, workflow ID, compiled workflow digest, node count, and criterion count. |
| `terminal-run.events.jsonl` | The production event parser and reducer preserve the run ID, workflow ID and digest, terminal verdict, last sequence, and command stdout and stderr hashes. |

The workflow bytes are the example shipped in the historical archive. The ledger was produced by
running that verified release through its production terminal path. The current command validates
the artifacts offline and never rewrites them.

This evidence is intentionally narrow. It doesn't establish compatibility with every alpha.1
workflow, every interrupted run, alpha.2, a future prerelease, or a library import.

## Apply prerelease change rules

Semantic Versioning requires a declared public API. Flow declares the surfaces in this document so
that prerelease changes are reviewable even though `0.x` alpha versions can change. Read the
[Semantic Versioning specification](https://semver.org/#semantic-versioning-specification-semver)
for the general version rules.

### Version and channel rules

- `preview` is the supported npm prerelease channel. Pin an exact version for reproducible use.
- `latest` isn't a compatibility signal. Its first-publication use was an explicit bootstrap
  exception and must not replace the documented `preview` channel.
- A prerelease increment can contain a breaking alpha change. Release notes must identify the
  affected surface, failure behavior, migration, and rollback path.
- A schema version governs its own document. The npm version governs the packaged implementation.
  Neither silently upgrades the other.
- A future stable channel requires a separate approved compatibility and migration program. This
  alpha policy doesn't precommit its support window.

### Additions and deprecations

An additive field must have a safe default for older records and must not change an existing
verdict, hash, or authority boundary. A new required authored field needs a new schema version or an
explicit migration.

Alpha deprecations have no fixed time window. When practical, Flow announces a planned removal for
at least one preview release. A security, corruption, or authority defect can require immediate
removal. The release notes must explain why the shorter path is necessary.

### Migration and rollback

Flow doesn't currently provide a general migration command. A change that needs migration must ship
one of these paths before maintainers claim replacement compatibility:

1. The new release reads the old artifact without changing its identity or verdict.
2. A bounded, explicit migration creates a new artifact beside the original and records provenance.
3. The release notes instruct the operator to keep using an exact older Flow version for that
   artifact.

Rollback means reinstalling a previously verified exact package and selecting retained Flow state.
It doesn't mean editing a historical ledger or retagging an npm version.

Before an upgrade, retain the exact package identity, project `.flow` directory, required capability
bytes, and any external artifact blobs. After an upgrade, run `flow compatibility check` before
starting new work. The command validates the packaged corpus, not the retained project. Also run the
documented project and workflow checks. If the compatibility check fails, preserve the report and
reinstall the previous exact version.

## Maintain the contract

Every change to a classified surface must complete these checks in the same pull request:

1. Identify the owning schema, command, package, catalog, or record.
2. State whether the change is additive, breaking, or internal.
3. Add or update a failing contract test before changing behavior.
4. Add an immutable corpus artifact when the change creates meaningful cross-release evidence.
5. Update the corpus manifest without changing prior artifact bytes.
6. Update release notes, migration instructions, rollback instructions, project status, roadmap,
   and architecture when their claims change.
7. Build and install the packed npm archive. Execute `flow compatibility check` and verify that
   package-root and undeclared-subpath imports fail.

The archive gate requires `compatibility/manifest.json`, verifies every installed file against
release evidence, and executes the installed command from a clean consumer project.

## Protect private data

Only package-owned, reviewed artifacts belong in the corpus. Don't add credentials, provider
responses, private repository content, user home paths, or secret environment values. Prefer
deterministic command evidence with content-free expected hashes.

Report a suspected disclosure or package-boundary bypass through the
[security policy](../SECURITY.md), not a public issue.
