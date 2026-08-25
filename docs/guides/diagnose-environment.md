# Diagnose the Flow environment

Use `flow doctor` to check whether the current host, project, and selected execution path are ready.
The command performs a bounded, read-only preflight. It doesn't start a workflow, contact a model
provider, create a container, change project files, or publish durable Flow state.

Run this command after installation, after a configuration change, or before you report an
environment problem.

Flow `0.1.0-alpha.3` and the current source tree contain this command. Follow the
[versioned installation guide](install-preview.md) for the current package boundary.

## Before you begin

Install Flow `0.1.0-alpha.3` through the [versioned installation guide](install-preview.md). If you
want to check a workflow, make the workflow and its selected capability packages available to the
current project. If you want to check Prime, prepare the Prime runtime first by following
[Prime runtime operations](../operations/prime-runtime.md). Contributors can instead use the
source-build procedure in [Contributing](../../CONTRIBUTING.md).

`flow doctor` prints a versioned JSON report. The report contains fixed categories and remediation
text. It doesn't include credentials, private paths, raw provider responses, or nested private
causes.

## Check the current project

Check the host, effective configuration, project discovery, project filesystem access, and the
configured sandbox:

```sh
flow doctor
```

The command checks only the effective sandbox profile. The default `native` profile performs one
bounded no-op through the production sandbox. If a trusted operator selected the `container`
profile, Flow verifies the prepared container runtime instead.

## Check a workflow

Pass one local workflow path, installed workflow reference, or activation reference:

```sh
flow doctor examples/verify-installation.workflow.yaml
```

Flow admits the workflow through the normal configuration, capability, and policy boundaries. It
then checks these selected requirements:

- The current host supports the workflow. Agent `exec` requires Linux.
- Every exact model is available in the local provider catalog.
- Every selected provider has local authentication configuration.

The provider check disables model network access. It doesn't read a credential value or send a
model request. A workflow that doesn't use an agent or model verifier doesn't require a provider
check.

You can use the same command with an installed workflow or activation reference:

```sh
flow doctor workflow:example/review@1.0.0
flow doctor activation:reviewed-harness
```

Use references that exist in your project. Flow applies the same strict admission rules that it
uses before execution.

## Check the Prime profile

On a prepared Linux x64 host, select the Prime diagnostic explicitly:

```sh
flow doctor --profile prime-agent
```

This command verifies the effective project, configured sandbox, and prepared Prime runtime
evidence. The Prime check can inspect the Docker daemon, image identity, runtime executables,
cgroup, and protected host observation. It doesn't build, pull, create, start, stop, or remove a
container.

You can't combine a workflow argument with `--profile prime-agent`. Check each selected path with a
separate command.

## Interpret the report

The report has this public shape:

```json
{
  "version": 1,
  "ok": true,
  "target": "project",
  "checks": [
    {
      "category": "runtime.host",
      "status": "pass",
      "message": "The Flow host runtime is supported."
    }
  ]
}
```

Use the fields as follows:

| Field | Meaning |
| --- | --- |
| `version` | Version of the public diagnostic report schema. |
| `ok` | `true` when no check has a `fail` status. |
| `target` | Selected path: `project`, `workflow`, or `prime-agent`. |
| `category` | Stable area that Flow checked. |
| `status` | `pass`, `fail`, or `skip`. |
| `message` | Fixed, value-free result. |
| `remediation` | Fixed next action for a failed check. |

Checks appear in dependency order. A `skip` means an earlier failure prevented a meaningful later
check. Fix the first failed dependency before you investigate skipped checks.

Each probe has a 10-second deadline. A probe that exceeds the deadline produces a fixed failed
check. Flow also bounds command output and retained diagnostic data.

## Use exit statuses

`flow doctor` uses these exit statuses:

| Exit status | Meaning |
| --- | --- |
| `0` | Every selected check passed or was not required. |
| `1` | At least one selected requirement failed or timed out. |
| `2` | The command syntax is invalid. |

In automation, parse the JSON report for detail and use the exit status as the blocking result.
Don't match the explanatory message text to select authority or recovery behavior.

## Resolve failed categories

Use the category and remediation from the report:

| Category | What Flow checks | Next document |
| --- | --- | --- |
| `runtime.host` | Supported operating system and Node.js version | [Install the Flow preview](install-preview.md) |
| `project.configuration` | Strict effective project and operator configuration | [Configuration](../configuration.md) |
| `project.discovery` | Nearest initialized Flow project | [Getting started](../getting-started.md) |
| `project.filesystem` | Read and write access to the project and `.flow` directory | [Recovery and interruption safety](../recovery.md) |
| `sandbox.native` | Production native sandbox prerequisites and one no-op execution | [Getting started](../getting-started.md#ubuntu-2404-sandbox-prerequisite) |
| `sandbox.container` | Prepared container runtime selected by operator policy | [Prime runtime operations](../operations/prime-runtime.md) |
| `workflow.admission` | Workflow, capability snapshot, and policy admission | [Workflow specification](../workflow-spec.md) |
| `workflow.host` | Host support for selected workflow features | [Project status](../project-status.md#platform-support) |
| `provider.configuration` | Exact local model registration and provider authentication presence | [Run and control workflows](run-and-control.md) |
| `prime.runtime` | Current prepared Prime runtime and protected host evidence | [Prime runtime operations](../operations/prime-runtime.md) |

If the fixed category doesn't provide enough information, reproduce the failure with the narrowest
selected target and report the JSON result through the [support channels](../../SUPPORT.md). Don't
publish credentials, private paths, provider responses, Docker inspection bodies, or project data.

## Understand the safety boundary

`flow doctor` is a diagnostic, not an authorization or execution shortcut. A passing report doesn't
reserve the environment or guarantee that it remains unchanged. Flow repeats its authoritative
admission, currentness, sandbox, and policy checks when it starts real work.

A failing report doesn't relax policy or select a fallback. Fix the named requirement. Don't make
the root filesystem writable, broaden capabilities, weaken sandbox rules, or bypass package and
workflow admission to make a check pass.
