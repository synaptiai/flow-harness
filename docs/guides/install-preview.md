# Install the Flow preview

This guide installs the public Flow preview and verifies the release before you execute it. Use
this path when you want to evaluate Flow without building the repository.

Flow `0.1.0-alpha.3` is a prerelease. Its workflow and storage contracts can change before the
first stable version. Don't use it as a security boundary for hostile or multi-tenant workloads.
Read the [security policy](../../SECURITY.md) before unattended use.

## Before you begin

Install these prerequisites:

- Node.js 26.7.0 or newer.
- npm with global package support.
- GitHub CLI 2.93.0 or newer if you want to verify release integrity and provenance.
- An x64 Linux or macOS host for a release-qualified installation.
- Bubblewrap, CA certificates, curl, ripgrep, socat, util-linux, and unprivileged user namespaces on Ubuntu 24.04.

The release workflow verifies the same archive on GitHub-hosted Ubuntu 24.04 x64 and macOS 15
Intel runners. Other Linux and macOS architectures aren't release-qualified in this version.

## Prepare an Ubuntu 24.04 host

Flow's default native sandbox uses Bubblewrap and supporting system tools on Linux. Install the
complete dependency set and enable unprivileged user namespaces before you run the credential-free
workflow:

```sh
sudo apt-get update
sudo apt-get install --yes bubblewrap ca-certificates curl ripgrep socat util-linux
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

The namespace setting changes the host security posture. Apply it only to a reviewed development or
CI host. Use a stronger container, microVM, or managed sandbox boundary for hostile workloads.
Flow fails closed when the required sandbox is unavailable. It doesn't run the command without
isolation.

## Download and verify the GitHub release

Create a private temporary directory and download the three release assets:

```sh
release_dir="$(mktemp -d)"
gh release download v0.1.0-alpha.3 \
  --repo synaptiai/flow-harness \
  --dir "$release_dir" \
  --pattern 'synapti-flow-harness-0.1.0-alpha.3.tgz' \
  --pattern 'package-release-evidence.json' \
  --pattern 'flow-harness-0.1.0-alpha.3.intoto.jsonl'
```

Verify the immutable release and each downloaded asset:

```sh
gh release verify v0.1.0-alpha.3 \
  --repo synaptiai/flow-harness
gh release verify-asset v0.1.0-alpha.3 \
  "$release_dir/synapti-flow-harness-0.1.0-alpha.3.tgz" \
  --repo synaptiai/flow-harness
gh release verify-asset v0.1.0-alpha.3 \
  "$release_dir/package-release-evidence.json" \
  --repo synaptiai/flow-harness
gh release verify-asset v0.1.0-alpha.3 \
  "$release_dir/flow-harness-0.1.0-alpha.3.intoto.jsonl" \
  --repo synaptiai/flow-harness
```

Verify the archive's build provenance and require the reviewed release workflow:

```sh
gh attestation verify \
  "$release_dir/synapti-flow-harness-0.1.0-alpha.3.tgz" \
  --bundle "$release_dir/flow-harness-0.1.0-alpha.3.intoto.jsonl" \
  --repo synaptiai/flow-harness \
  --signer-workflow synaptiai/flow-harness/.github/workflows/preview-release.yml
```

All commands must succeed. The release verification binds the immutable tag and downloaded assets.
The artifact attestation binds the archive to the source revision and workflow that built it.
Neither check proves that the software is safe for your workload.

npm fetches Flow's dependencies from the registry during installation. The release archive
contains the reviewed shrinkwrap, and the release workflow tests a clean resolution on both
release-qualified hosts. The archive verification doesn't authenticate a later registry response.

## Install the verified archive

Install the file that you verified. Keep install scripts disabled because Flow doesn't require a
package lifecycle script:

```sh
npm install --global --ignore-scripts \
  "$release_dir/synapti-flow-harness-0.1.0-alpha.3.tgz"
flow --help
```

The launcher stops before it loads the complete command if Node.js or the operating system is
unsupported.

After the `preview` npm tag is available, you can use this shorter installation command:

```sh
npm install --global --ignore-scripts @synapti/flow-harness@preview
```

The `preview` tag is separate from `latest`. Before you install from npm, confirm that the tag
selects the reviewed version:

```sh
npm view @synapti/flow-harness@preview version
```

The expected output for this release is `0.1.0-alpha.3`.

## Complete a credential-free run

Create an empty project directory, then complete the package-owned guided workflow:

```sh
mkdir flow-preview-project
cd flow-preview-project
flow quickstart .
```

The command creates `.flow/config.yaml` without replacing an existing Flow project. It runs the
installed credential-free workflow through the production command sandbox and returns the run
identity, project-relative evidence path, and explicit `inspect` and `web` follow-up commands. It
doesn't need a model provider, Docker Engine, Bun, or the Prime runtime, and it never opens a
browser automatically.

Use the returned run identity to inspect durable evidence. The default identity is
`quickstart-foundation`:

```sh
flow inspect quickstart-foundation
```

Check the current project and native sandbox without changing either one:

```sh
flow doctor
```

The diagnostic must report `"ok": true` before you rely on the selected path. Optional provider,
coding, browser, and failure-recovery guidance is in [Getting started](../getting-started.md). The
complete diagnostic contract is in [Diagnose the Flow environment](diagnose-environment.md).

## Remove or replace the preview

Remove the global package when you finish evaluating it:

```sh
npm uninstall --global @synapti/flow-harness
```

Prerelease versions don't have a compatibility promise. Before you install a newer preview, read
its release notes and back up any project state that you need to retain. Flow doesn't provide an
automatic migration between prerelease storage formats.

## Resolve installation problems

Use these checks before you report a problem:

- If `flow` isn't found on Linux or macOS, run `npm prefix --global`, append `/bin` to the returned
  path, and confirm that directory is in `PATH`. For other npm layouts, follow the npm installation
  documentation for global executables.

- If Flow rejects Node.js, run `node --version`. Version 26.7.0 is the minimum.

- If command execution fails on Ubuntu 24.04, read the
  [Ubuntu sandbox prerequisite](../getting-started.md#ubuntu-2404-sandbox-prerequisite).

- If release verification fails, don't install the archive. Download the assets again into a new
  empty directory. Report a persistent mismatch through the [support channels](../../SUPPORT.md).

For maturity and platform limits, read [Project status](../project-status.md). For contributor
builds from source, read [Contributing](../../CONTRIBUTING.md).
