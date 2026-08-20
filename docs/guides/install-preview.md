# Install the Flow preview

This guide installs the public Flow preview and verifies the release before you execute it. Use
this path when you want to evaluate Flow without building the repository.

Flow `0.1.0-alpha.1` is a prerelease. Its workflow and storage contracts can change before the
first stable version. Don't use it as a security boundary for hostile or multi-tenant workloads.
Read the [security policy](../../SECURITY.md) before unattended use.

## Before you begin

Install these prerequisites:

- Node.js 26.7.0 or newer.
- npm with global package support.
- GitHub CLI 2.49.0 or newer if you want to verify provenance.
- An x64 Linux or macOS host for a release-qualified installation.

The release workflow verifies the same archive on GitHub-hosted Ubuntu 24.04 x64 and macOS 15
Intel runners. Other Linux and macOS architectures aren't release-qualified in this version.

## Download and verify the GitHub release

Create a private temporary directory and download the three release assets:

```sh
release_dir="$(mktemp -d)"
gh release download v0.1.0-alpha.1 \
  --repo synaptiai/flow-harness \
  --dir "$release_dir" \
  --pattern 'synaptiai-flow-harness-0.1.0-alpha.1.tgz' \
  --pattern 'package-release.json' \
  --pattern 'flow-harness-0.1.0-alpha.1.intoto.jsonl'
```

Verify that the archive belongs to the immutable GitHub release:

```sh
gh release verify-asset v0.1.0-alpha.1 \
  "$release_dir/synaptiai-flow-harness-0.1.0-alpha.1.tgz" \
  --repo synaptiai/flow-harness
```

Verify the archive's build provenance and require the reviewed release workflow:

```sh
gh attestation verify \
  "$release_dir/synaptiai-flow-harness-0.1.0-alpha.1.tgz" \
  --repo synaptiai/flow-harness \
  --signer-workflow synaptiai/flow-harness/.github/workflows/preview-release.yml
```

Both commands must succeed. The release verification binds the immutable tag and assets. The
artifact attestation binds the archive to the source revision and workflow that built it. Neither
check proves that the software is safe for your workload.

## Install the verified archive

Install the file that you verified. Keep install scripts disabled because Flow doesn't require a
package lifecycle script:

```sh
npm install --global --ignore-scripts \
  "$release_dir/synaptiai-flow-harness-0.1.0-alpha.1.tgz"
flow --help
```

The launcher stops before it loads the complete command if Node.js or the operating system is
unsupported.

After the `preview` npm tag is available, you can use this shorter installation command:

```sh
npm install --global --ignore-scripts @synaptiai/flow-harness@preview
```

The `preview` tag is separate from `latest`. Before you install from npm, confirm that the tag
selects the reviewed version:

```sh
npm view @synaptiai/flow-harness@preview version
```

The expected output for this release is `0.1.0-alpha.1`.

## Complete a credential-free run

Create an empty project directory and initialize it:

```sh
mkdir flow-preview-project
cd flow-preview-project
flow init .
flow config show
```

Locate the example inside the installed package, then validate and run it:

```sh
flow_package_root="$(npm root --global)/@synaptiai/flow-harness"
flow validate "$flow_package_root/examples/verify-installation.workflow.yaml"
flow run "$flow_package_root/examples/verify-installation.workflow.yaml" \
  --run-id first-run
flow inspect first-run
```

The workflow runs two deterministic Node.js commands. It doesn't need a model provider, Docker,
Bun, or the Prime runtime.

## Remove or replace the preview

Remove the global package when you finish evaluating it:

```sh
npm uninstall --global @synaptiai/flow-harness
```

Prerelease versions don't have a compatibility promise. Before you install a newer preview, read
its release notes and back up any project state that you need to retain. Flow doesn't provide an
automatic migration between prerelease storage formats.

## Resolve installation problems

Use these checks before you report a problem:

- If `flow` isn't found, inspect the global executable directory with `npm bin --global` or your
  npm installation documentation, and add that directory to `PATH`.

- If Flow rejects Node.js, run `node --version`. Version 26.7.0 is the minimum.

- If command execution fails on Ubuntu 24.04, read the
  [Ubuntu sandbox prerequisite](../getting-started.md#ubuntu-2404-sandbox-prerequisite).

- If release verification fails, don't install the archive. Download the assets again into a new
  empty directory. Report a persistent mismatch through the [support channels](../../SUPPORT.md).

For maturity and platform limits, read [Project status](../project-status.md). For contributor
builds from source, read [Contributing](../../CONTRIBUTING.md).
