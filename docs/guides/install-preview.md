# Install the Flow preview

This guide installs and calls the public Flow preview without building the repository. Use the npm
path for the current prerelease channel. Use the immutable GitHub release path when you must verify
the exact archive and its build provenance before execution.

Flow `0.1.0-alpha.4` is a prerelease. Its workflow and storage contracts can change before the
first stable version. Don't use it as a security boundary for hostile or multi-tenant workloads.
Read the [security policy](../../SECURITY.md) before unattended use.

## Before you begin

Install these prerequisites:

- Node.js 26.7.0 or newer.
- npm with global package support.
- GitHub CLI 2.93.0 or newer for the optional release-integrity and provenance procedure.
- An x64 Linux or macOS host for a release-qualified installation.
- Bubblewrap, CA certificates, curl, ripgrep, socat, util-linux, and unprivileged user namespaces on Ubuntu 24.04.

The release workflow verifies the same archive on GitHub-hosted Ubuntu 24.04 x64 and macOS 15
Intel runners. Other Linux and macOS architectures aren't release-qualified in this version.

## Install from npm

Confirm the version selected by the prerelease channel:

```sh
npm view @synapti/flow-harness@preview version
```

The expected output for this release is `0.1.0-alpha.4`. Install that channel globally and disable
package lifecycle scripts because Flow doesn't require one:

```sh
npm install --global --ignore-scripts @synapti/flow-harness@preview
flow --help
flow compatibility check
```

The installation adds the `flow` executable to npm's global executable directory. The help output
must begin with `Flow — Provider-neutral coding-agent harness` and list `flow quickstart`.
The compatibility command must return a JSON report whose `overall` value is `compatible`. The
launcher stops before it loads the complete command if Node.js or the operating system is
unsupported.

The `preview` tag is the canonical prerelease channel, and it moves to each approved prerelease.
Because alpha.3 was the package's first public npm version, npm also exposes alpha.3 through
`latest` even though publication used `--tag preview`. Alpha.4 advances only `preview`.
Unqualified installs therefore remain on alpha.3. Always name `@preview` when you want the current
prerelease channel.

Pin the exact version when repeatability matters:

```sh
npm install --global --ignore-scripts @synapti/flow-harness@0.1.0-alpha.4
```

Future prereleases must advance only `preview`. The first stable release must move `latest` to the
stable version.

## Call Flow without a global installation

Use npm's temporary executable path when you only want to inspect the current command surface:

```sh
npm exec --yes --package=@synapti/flow-harness@preview -- flow --help
npm exec --yes --package=@synapti/flow-harness@preview -- flow compatibility check
```

The first `--` ends npm's options. `flow --help` is the harness command. This form downloads the
selected package into npm's cache but doesn't add `flow` to your global executable directory.
Repeat the complete `npm exec` prefix for every later command. The remaining guides assume the
global installation because a run normally needs several `flow` commands.

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
gh release download v0.1.0-alpha.4 \
  --repo synaptiai/flow-harness \
  --dir "$release_dir" \
  --pattern 'synapti-flow-harness-0.1.0-alpha.4.tgz' \
  --pattern 'package-release-evidence.json' \
  --pattern 'flow-harness-0.1.0-alpha.4.intoto.jsonl'
```

Verify the immutable release and each downloaded asset:

```sh
gh release verify v0.1.0-alpha.4 \
  --repo synaptiai/flow-harness
gh release verify-asset v0.1.0-alpha.4 \
  "$release_dir/synapti-flow-harness-0.1.0-alpha.4.tgz" \
  --repo synaptiai/flow-harness
gh release verify-asset v0.1.0-alpha.4 \
  "$release_dir/package-release-evidence.json" \
  --repo synaptiai/flow-harness
gh release verify-asset v0.1.0-alpha.4 \
  "$release_dir/flow-harness-0.1.0-alpha.4.intoto.jsonl" \
  --repo synaptiai/flow-harness
```

Verify the archive's build provenance and require the reviewed release workflow:

```sh
gh attestation verify \
  "$release_dir/synapti-flow-harness-0.1.0-alpha.4.tgz" \
  --bundle "$release_dir/flow-harness-0.1.0-alpha.4.intoto.jsonl" \
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
  "$release_dir/synapti-flow-harness-0.1.0-alpha.4.tgz"
flow --help
```

The installed archive exposes the same `flow` executable as the registry package. If you already
installed the registry package globally, this command replaces that installation with the verified
archive bytes.

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
