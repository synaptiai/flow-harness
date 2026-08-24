# Release a Flow preview

This runbook is for maintainers who publish a Flow prerelease. It preserves one archive from source
revision through GitHub, npm, and user installation.

## Release invariants

Every release must satisfy these requirements:

- Read the package version from `package.json`. Require `npm-shrinkwrap.json` and the canonical
  release-notes heading to match it, then derive the tag, archive, attestation, title, and notes
  path. Don't enter a version through workflow input.

- Build one npm archive from a clean `main` revision that has successful CI.

- Publish the reviewed `npm-shrinkwrap.json` and verify the dependency closure that npm resolves
  from it on both release-qualified hosts.

- Verify the same archive on Ubuntu 24.04 x64 and macOS 15 Intel.

- Generate GitHub build provenance for the archive and its release-evidence document.

- Create a draft, attach every asset, and publish only after repository release immutability is
  enabled.

- Publish prereleases under an explicit tag. Never assign `latest` to a prerelease.

- Never overwrite an existing tag, release asset, npm version, or staged npm version.

- Use no long-lived npm publication token.

## Prepare GitHub authority

Before the first release, configure these repository controls:

1. Enable release immutability in **Settings > General > Releases**.

2. Create the `preview-release` GitHub environment.

3. Add required reviewers to the environment. Don't permit administrators to bypass the reviewer
   rule for this environment.

4. Confirm that `.github/workflows/preview-release.yml` has only read permissions before its
   attestation and publication jobs.

Before each publication approval, use a repository-owner GitHub CLI session to verify the setting:

```sh
gh api \
  --header 'X-GitHub-Api-Version: 2026-03-10' \
  repos/synaptiai/flow-harness/immutable-releases \
  --jq '.enabled'
```

The command must return `true`. Stop without approval if the command fails or returns another
value. The workflow's short-lived token can publish repository contents but can't read repository
administration settings. Don't add a long-lived administration token to the workflow.

## Build and verify without publication

From a clean checkout of the candidate revision, resolve and inspect the release identity:

```sh
node scripts/resolve-preview-release-identity.mjs
```

The command must report `0.1.0-alpha.2` and the matching tag, archive, attestation, title, notes
path, and `preview` npm tag. It fails if the manifest, shrinkwrap, or release notes are unsafe or
inconsistent. Review this output before you dispatch the workflow.

Dispatch **Preview release** from the exact `main` revision with `publish_github` set to `false`.
The workflow performs these actions:

1. Requires successful `CI` for the same revision.
2. Resolves the version from `package.json` and rejects inconsistent shrinkwrap or release notes.
3. Builds `release/package/synaptiai-flow-harness-0.1.0-alpha.2.tgz` once.
4. Records its source revision, SHA-512 digest, archive paths, modes, and byte counts in
   `package-release-evidence.json`.
5. Verifies the published shrinkwrap, downloaded artifact, clean installation, installed guided
   quick start, and explicit browser path on both supported x64 hosts.
6. Produces SLSA build provenance with GitHub's short-lived OpenID Connect identity.

Review every job before you authorize publication. A green workflow proves the tested artifact and
workflow identity. It doesn't replace a source review or the repository's normal CI gates.
Confirm that the publication job is skipped and that no new Git tag, GitHub release, npm version,
or npm distribution tag exists.

## Publish the immutable GitHub prerelease

Dispatch **Preview release** again from the same revision with `publish_github` set to `true`.
Approve the `preview-release` environment only after all prepare, host-verification, and attestation
jobs pass. Run the immutable-release check in [Prepare GitHub authority](#prepare-github-authority)
immediately before approval.

The publication job refuses an existing release, Git tag, or npm version. It treats only npm's
explicit `E404` response as evidence that the version is unused. Authentication, transport,
availability, and malformed-response failures block publication. It creates a draft, uploads the
npm archive, release evidence, and attestation bundle, and then publishes the prerelease. GitHub
makes the release tag and assets immutable at publication.

After publication, verify the release from a new empty directory by following
[Install the Flow preview](../guides/install-preview.md#download-and-verify-the-github-release).

## Bootstrap the npm package

npm can't configure staged trusted publishing until the package exists. For the first version, an
authorized maintainer must publish the exact GitHub archive through an interactive npm session with
two-factor authentication.

1. Download and verify the immutable release as described in
   [Install the Flow preview](../guides/install-preview.md#download-and-verify-the-github-release).

2. Confirm that the version doesn't exist:

   ```sh
   npm view @synaptiai/flow-harness@0.1.0-alpha.2 version
   ```

   npm must return a not-found response. If it returns a version, stop and compare the registry
   artifact with the GitHub archive. Don't publish or change a distribution tag.

3. Publish the verified local archive under `preview`:

   ```sh
   npm publish "$release_dir/synaptiai-flow-harness-0.1.0-alpha.2.tgz" \
     --access public \
     --tag preview
   ```

   Complete npm's interactive two-factor-authentication prompt. Don't pass a one-time password in
   a script or store a publication token.

4. Confirm the registry identity:

   ```sh
   npm view @synaptiai/flow-harness@0.1.0-alpha.2 version dist.integrity dist-tags
   ```

   The version must be `0.1.0-alpha.2`, `preview` must select that version, and `latest` must not
   select it.

## Configure later staged publications

After npm records the first package, configure one trusted publisher for future release workflow
revisions. Permit only staged publication:

```sh
npm trust github @synaptiai/flow-harness \
  --repo synaptiai/flow-harness \
  --file preview-release.yml \
  --env preview-release \
  --allow-stage-publish
```

Configure the package to require two-factor authentication and disallow publication tokens. A
future reviewed workflow change can submit an exact verified archive with `npm stage publish
<archive> --tag preview`. A maintainer must download and compare the staged archive, then approve it
with two-factor authentication. Don't grant `--allow-publish`.

## Recover from an interrupted release

The workflow doesn't overwrite or silently continue an existing release identity.

- If preparation or host verification fails, no public release exists. Fix the source in a new
  revision and repeat the workflow.

- If draft creation or asset upload fails, don't rerun publication. Inspect the draft, tag target,
  and every asset. Remove the draft and its tag only after you prove that publication didn't occur.
  You must also prove that no consumer can depend on that identity. Use a new prerelease version
  when the state is ambiguous.

- If publication returns an error, inspect the release before retry. If GitHub reports the release
  as immutable, treat it as published and verify every asset. Don't delete or recreate it.

- If the first npm publication returns an error, query the exact version and download its tarball
  before another attempt. An existing or ambiguous version consumes that semantic version.

- If staged publication or approval fails, inspect the stage ID. Reject or approve only the exact
  staged archive. Don't stage the same semantic version under a different tag.

For general interruption rules, read [Recovery and interruption safety](../recovery.md).
