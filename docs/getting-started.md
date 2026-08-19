# Getting started

This guide builds the Flow source preview and runs one credential-free workflow.

## Before you begin

Flow is a public pre-alpha source preview. The npm package is not published. Build it from a
reviewed checkout.

Requirements:

- Git
- Node.js 26.7 or newer
- npm with lockfile support
- Linux or macOS

### Ubuntu 24.04 sandbox prerequisite

Flow uses Sandbox Runtime for native command isolation. On Ubuntu 24.04, its bubblewrap backend
requires unprivileged user namespaces. The release workflow verifies this host setting:

```sh
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

This setting changes the host security posture. Apply it only to a reviewed development or CI host.
Use a stronger container, microVM, or managed sandbox boundary for hostile workloads.

The first run does not need model credentials, Docker, Bun, or the Prime runtime.

Do not use this preview as a security boundary for hostile or multi-tenant workloads. Read the
[security policy](../SECURITY.md) before unattended use.

## Build the source preview

Clone the repository and install the exact lockfile:

```sh
git clone https://github.com/synaptiai/flow-harness.git
cd flow-harness
npm ci --ignore-scripts
npm run build
```

`npm ci --ignore-scripts` installs the committed dependency graph. Use `npm install` only when you
intend to change dependencies.

The built command is `node dist/cli/main.js`. The examples below use that path because the package
is not published.

## Initialize a project

Initialize the checkout and inspect the effective configuration:

```sh
node dist/cli/main.js init .
node dist/cli/main.js config show
```

Flow writes project configuration to `.flow/config.yaml`. It discovers the nearest Flow project
from child directories.

The effective configuration combines project settings with trusted operator ceilings. Read
[Configuration](configuration.md) before changing capacity, sandbox, or policy settings.

## Validate and run a workflow

Use the credential-free foundation example:

```sh
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
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
- Read [Contributing](../CONTRIBUTING.md) before changing Flow itself.

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

### You need the complete release gate

The contributor release gate has additional browser, sandbox, Docker, Prime, and second-user
requirements. Follow [Testing and evaluation](testing-and-evaluation.md), not this guide.
