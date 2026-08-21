# Getting started

This guide runs one credential-free workflow with the installed Flow preview.

## Before you begin

Flow is a public alpha preview. Install and verify the exact package by following
[Install the Flow preview](guides/install-preview.md) before you use this guide.

Requirements:

- Node.js 26.7 or newer
- npm with global package support
- x64 Linux or macOS for a release-qualified host

### Ubuntu 24.04 sandbox prerequisite

Flow uses Sandbox Runtime for native command isolation. On Ubuntu 24.04, install its system
dependencies and enable unprivileged user namespaces before the first run:

```sh
sudo apt-get update
sudo apt-get install --yes bubblewrap ca-certificates curl ripgrep socat util-linux
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

The release workflow verifies both requirements. The namespace setting changes the host security
posture. Apply it only to a reviewed development or CI host. Use a stronger container, microVM, or
managed sandbox boundary for hostile workloads. Flow fails closed when the sandbox is unavailable.

The first run does not need model credentials, Docker, Bun, or the Prime runtime.

Do not use this preview as a security boundary for hostile or multi-tenant workloads. Read the
[security policy](../SECURITY.md) before unattended use.

## Initialize a project

Create an empty directory, initialize it, and inspect the effective configuration:

```sh
mkdir flow-preview-project
cd flow-preview-project
flow init .
flow config show
```

Flow writes project configuration to `.flow/config.yaml`. It discovers the nearest Flow project
from child directories.

The effective configuration combines project settings with trusted operator ceilings. Read
[Configuration](configuration.md) before changing capacity, sandbox, or policy settings.

## Validate and run a workflow

Use the credential-free example inside the installed package:

```sh
flow_example="$(npm root --global)/@synaptiai/flow-harness/examples/verify-installation.workflow.yaml"
flow validate "$flow_example"
flow run "$flow_example" \
  --run-id first-run
flow inspect first-run
```

The verifier runs through the production command sandbox. The run succeeds only when deterministic
evidence accepts the declared goal criterion.

Flow stores authoritative events here:

```text
.flow/runs/first-run/events.jsonl
```

The inspection output includes graph state, criterion decisions, bounded command output, hashes,
sandbox identity, and the effective policy digest.

## Choose your next path

- Read [Run and control workflows](guides/run-and-control.md) for detached work, approvals, budgets,
  presentation hosts, and recovery entry points.
- Read the [Workflow specification](workflow-spec.md) before authoring executable graphs.
- Read [Use capability packages](guides/capability-packages.md) for skills, verifiers, tools,
  workflows, policies, presentations, and exact bundles.
- Read [Reproducible harness evaluation](evaluation.md) before comparing agent harnesses or
  generating adaptive candidates.
- Read [Prime runtime operations](operations/prime-runtime.md) only for the Linux x64 Prime or
  container profile.
- Read [Contributing](../CONTRIBUTING.md) to build Flow from source or change the project.

## Common problems

### The Node.js version is rejected

Run `node --version`. Flow requires Node.js 26.7 or newer. The package manifest is authoritative.

### The command sandbox is unavailable

Flow fails before process creation when the selected sandbox cannot prove its required isolation.
Read [Project status](project-status.md) for platform limits and [Configuration](configuration.md)
for profile selection.

### A provider-backed example requests credentials

The first-run example is credential-free. Agent and model-verifier examples use the provider and
model declared by their workflow.

### You need the environment diagnostic

The immutable `0.1.0-alpha.1` package doesn't contain `flow doctor`. The command is implemented in
the current source tree and will enter a later preview only after release qualification. Read
[Diagnose the Flow environment](guides/diagnose-environment.md) for the current source-build
contract.

### You need the complete release gate

The contributor release gate has additional browser, sandbox, Docker, Prime, and second-user
requirements. Follow [Testing and evaluation](testing-and-evaluation.md), not this guide.
