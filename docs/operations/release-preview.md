# Release a Flow preview

This runbook is for maintainers who publish a Flow prerelease. It preserves one archive from a
reviewed source revision through qualification, an immutable GitHub release, staged npm review,
public npm approval, and consumer verification.

## Release invariants

Every release must satisfy these requirements:

- Read the package version from `package.json`. Require `npm-shrinkwrap.json` and the canonical
  release-notes heading to match it, then derive the tag, archive, attestation, title, and notes
  path. Don't enter a version through workflow input.
- Build one npm archive from a clean `main` revision that has successful CI.
- Publish the reviewed `npm-shrinkwrap.json` and verify the dependency closure that npm resolves
  from it on Ubuntu 24.04 x64 and macOS 15 Intel.
- Generate GitHub build provenance for the archive and its release-evidence document.
- Create a complete draft GitHub prerelease, attach every asset, then publish it only when release
  immutability is enabled.
- Stage only the immutable GitHub archive on npm. Reverify its release identity, source revision,
  provenance, installed behavior, and unused npm version before staging.
- Publish prereleases under the explicit `preview` tag. Don't move `latest` to a prerelease. npm's
  first-publication exception left `latest` on alpha.3. The first stable release must replace it.
- Keep GitHub publication, npm staging, and npm approval as separate authority decisions.
- Never overwrite an existing tag, release asset, npm version, or staged npm version.
- Use no long-lived npm publication token. Don't pass a one-time password through a workflow or
  command argument.

## Understand the release states

The same semantic version moves through distinct states:

| State | Visible to | Mutable action allowed |
| --- | --- | --- |
| Qualified workflow artifact | Repository maintainers | Discard the temporary workflow artifact and fix source. |
| Draft GitHub prerelease | Repository maintainers | Inspect an incomplete draft before publication. |
| Immutable GitHub prerelease | Public users | No asset or tag replacement. |
| Staged npm version | Authorized npm maintainers | Download, inspect, approve, or reject the exact stage. |
| Public npm version | Public users | No version replacement. Distribution tags can move only under channel policy. |

Qualification doesn't publish. GitHub publication doesn't make an npm version available. npm
staging doesn't make the version public or move `preview`. npm approval publishes the staged bytes
and applies the requested `preview` tag.

## Prepare publication authority

Configure these controls once, then verify them before each release.

### GitHub controls

1. Enable release immutability in **Settings > General > Releases**.
2. Create the `preview-release` GitHub environment. Permit deployments from `main` only. Don't
   permit tags or other branches.
3. Add required reviewers. Don't permit administrators to bypass the reviewer rule.
4. Keep both preview workflows read-only before their protected publication jobs.

Before each GitHub publication approval, use a repository-owner GitHub CLI session:

```sh
gh api \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  repos/synaptiai/flow-harness/immutable-releases \
  --jq '.enabled'
```

The command must return `true`. Stop if the command fails or returns another value. Don't add a
long-lived repository-administration token to either workflow.

### npm controls

Use npm 11.19.0 or newer. Configure the package to require two-factor authentication and disallow
publication tokens. Configure one GitHub trusted publisher with stage-only authority:

```sh
npm trust github @synapti/flow-harness \
  --repo synaptiai/flow-harness \
  --file preview-npm-stage.yml \
  --env preview-release \
  --allow-stage-publish
```

Confirm the recorded relationship:

```sh
npm trust list @synapti/flow-harness
```

The relationship must name `synaptiai/flow-harness`, `preview-npm-stage.yml`, and
`preview-release`, and it must allow staged publication only. Don't grant `--allow-publish`.
Changing the workflow filename or protected environment requires a reviewed trust update before
the next stage attempt.

## Qualify without publication

From a clean checkout of the candidate `main` revision, inspect the derived identity:

```sh
node scripts/resolve-preview-release-identity.mjs
```

For this checkpoint, the command must report `0.1.0-alpha.4`, `v0.1.0-alpha.4`,
`synapti-flow-harness-0.1.0-alpha.4.tgz`,
`flow-harness-0.1.0-alpha.4.intoto.jsonl`, the versioned notes path, and the `preview` npm tag. It
fails if the manifest, shrinkwrap, or release notes are unsafe or inconsistent.

Dispatch **Preview release** from the exact `main` revision with `publish_github` set to `false`.
The workflow:

1. Requires successful `CI` for the same revision.
2. Builds the archive once and records its source revision, SHA-512 digest, file paths, modes, and
   byte counts in `package-release-evidence.json`.
3. Verifies the same archive through a clean installed-package path on Ubuntu 24.04 x64 and macOS
   15 Intel.
4. Verifies command discovery, the guided first run, environment diagnostics, and browser
   presentation. It also checks the compatibility corpus, rejected package imports, and Prime
   preparation boundary.
5. Produces GitHub build provenance through a short-lived OpenID Connect identity.

Review every job. Confirm that the publication job was skipped and that no new Git tag, GitHub
release, npm version, staged version, or distribution tag exists.

## Publish the immutable GitHub prerelease

Dispatch **Preview release** again from the same revision with `publish_github` set to `true`.
Approve the `preview-release` environment only after the prepare, host-verification, and attestation
jobs pass. Repeat the immutable-release check immediately before approval.

The publication job accepts only an unused GitHub tag, GitHub release, and npm version. It treats
only npm's explicit `E404` response as evidence that the version is unused. It creates a complete
draft with the archive, release evidence, and attestation bundle, then publishes the immutable
prerelease.

After publication, follow
[Download and verify the GitHub release](../guides/install-preview.md#download-and-verify-the-github-release)
from a new empty directory. Don't stage npm until every command succeeds.

## Stage the immutable release on npm

Dispatch **Preview npm stage** from `main`. Enter the exact immutable tag `v0.1.0-alpha.4` as
`release_tag`. The workflow rejects another dispatch ref before it checks out release source.

The unprotected `verify` job completes before GitHub requests environment approval. It keeps the
reviewed `main` verifier in the root checkout and places release source in a separate tag checkout.
Main-owned scripts validate the tag, assets, and provenance before the job installs dependencies or
builds release source. The job requires all of these facts:

- The manifest-derived tag matches the input.
- The GitHub release is published, immutable, prerelease-only, and targeted at the checked-out
  40-character source revision.
- The title, notes, archive, release-evidence document, and attestation names are exact, with no
  missing or extra release asset.
- GitHub verifies the release and all three assets.
- GitHub provenance binds the archive and release evidence to the release workflow, repository,
  hosted runner, and exact source revision.
- A clean installed package passes the full release verifier.
- The public `preview` and `latest` tags exist, and no public tag already selects the candidate.
- npm returns an explicit not-found response for the version.

Review the `verify` job before you approve the `preview-release` environment. The protected `stage`
job downloads the immutable archive again, reverifies the release asset and provenance, captures
the public distribution tags, and calls:

```sh
npm stage publish <verified-archive> \
  --access public \
  --tag preview \
  --provenance
```

GitHub OpenID Connect supplies short-lived stage-only authority. The job fails if the version is no
longer unused. After staging, it requires the public distribution tags to remain byte-for-byte
unchanged. It doesn't approve the stage.

## Inspect and approve the npm stage

Use an authorized maintainer session with two-factor authentication. Don't approve from the
workflow log alone.

1. Find the exact stage and record its ID:

   ```sh
   npm stage list @synapti/flow-harness --json
   npm stage view <stage-id> --json
   ```

   Require package `@synapti/flow-harness`, version `0.1.0-alpha.4`, and tag `preview`. Require the
   actor to identify the configured trusted publisher. Record the staged SHA-1 and any access or
   provenance fields that npm returns. Don't infer a repository or workflow field that the registry
   doesn't return. Stop on any reported mismatch.

2. Download the staged tarball in a new empty directory:

   ```sh
   stage_id='<stage-id>'
   stage_dir="$(mktemp -d)"
   cd "$stage_dir"
   npm stage download "$stage_id"
   stage_archive="$stage_dir/synapti-flow-harness-0.1.0-alpha.4-${stage_id}.tgz"
   ```

   npm includes the stage ID in the downloaded filename. Require that exact regular file before
   comparison.

3. Download the immutable GitHub assets through the
   [installation guide](../guides/install-preview.md#download-and-verify-the-github-release). Compare
   the staged tarball with `synapti-flow-harness-0.1.0-alpha.4.tgz`:

   ```sh
   cmp --silent \
     "$stage_archive" \
     "$release_dir/synapti-flow-harness-0.1.0-alpha.4.tgz"
   shasum -a 512 "$stage_archive"
   jq -r '.archive.sha512' "$release_dir/package-release-evidence.json"
   ```

   `cmp` must succeed, and the two SHA-512 values must match. Inspect the staged manifest and file
   list before approval. Don't install or execute a mismatched stage.

4. Approve the exact stage and complete npm's interactive two-factor prompt:

   ```sh
   npm stage approve <stage-id>
   ```

   Don't pass `--otp` in shell history or automation. If review fails, use `npm stage reject
   <stage-id>` and complete the interactive prompt. Record the reason.

## Verify public npm publication

Query the exact version and channels:

```sh
npm view @synapti/flow-harness@0.1.0-alpha.4 version dist.integrity --json
npm view @synapti/flow-harness dist-tags --json
```

The version must be `0.1.0-alpha.4`. `preview` must select alpha.4. `latest` must remain
`0.1.0-alpha.3`. Download the registry tarball and compare it with the GitHub archive:

```sh
registry_dir="$(mktemp -d)"
npm pack @synapti/flow-harness@0.1.0-alpha.4 \
  --ignore-scripts \
  --pack-destination "$registry_dir"
cmp --silent \
  "$registry_dir/synapti-flow-harness-0.1.0-alpha.4.tgz" \
  "$release_dir/synapti-flow-harness-0.1.0-alpha.4.tgz"
```

Finally, use a clean consumer environment to follow
[Install from npm](../guides/install-preview.md#install-from-npm), run `flow --help`, complete
`flow quickstart .`, and run `flow compatibility check`.

## First-publication history

Alpha.3 bootstrapped the npm package through an interactive publication because npm couldn't record
a trusted publisher before the package existed. npm also assigned `latest` to alpha.3 even though
publication requested `preview`. Authenticated removal attempts returned HTTP 400. This accepted
exception is historical. Later prereleases use the staged workflow and don't move `latest`.

## Recover from an interrupted release

The workflows don't overwrite or silently continue an existing identity.

- If qualification fails, no public release exists. Fix source in a reviewed revision and qualify
  again.
- If draft creation or upload fails, inspect the draft, tag target, and every asset. Remove a draft
  and tag only after proving that publication didn't occur and no consumer can depend on them. Use a
  new prerelease version when state is ambiguous.
- If GitHub publication returns an error, inspect the release. Treat an immutable release as
  published. Verify it and don't delete or recreate it.
- If npm staging fails, list and inspect staged versions before retrying. A created stage can exist
  even when a client loses the response. Don't create a second stage for the same semantic version.
- If stage review fails, reject only the exact stage after recording its identity and reason. A
  rejected or ambiguous npm version can require a new prerelease identity. Don't assume reuse is
  safe.
- If npm approval returns an error, query the exact public version and stage ID before another
  action. An existing or ambiguous public version consumes that semantic version.
- If post-publication comparison fails, don't replace the version or move tags. Preserve the bytes,
  remove the affected channel from user guidance, and prepare a new prerelease through review.

For general interruption rules, read [Recovery and interruption safety](../recovery.md).
