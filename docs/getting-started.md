# Getting started

This guide completes one credential-free run with the current Flow source. It also explains the
optional provider path and each safe recovery action.

## Before you begin

Install these prerequisites:

- Node.js 26.7 or newer.
- npm with global package support.
- An x64 Linux or macOS host.

The default path does not need model credentials, Docker, Bun, or the Prime runtime.

Flow is a public alpha preview. Do not use it as a security boundary for hostile or multi-tenant
workloads. Read the [security policy](../SECURITY.md) before unattended use.

The immutable `0.1.0-alpha.1` release predates `flow quickstart`. Follow
[Install the Flow preview](guides/install-preview.md) when you evaluate that release.

### Ubuntu 24.04 sandbox prerequisite

Flow uses Sandbox Runtime for native command isolation. Install its host dependencies:

```sh
sudo apt-get update
sudo apt-get install --yes bubblewrap ca-certificates curl ripgrep socat util-linux
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

The namespace setting changes the host security posture. Apply it only to a reviewed development
or CI host. Use a container, microVM, or managed sandbox for hostile workloads. Flow stops before
command creation when the sandbox is unavailable.

## Build the current source

From the repository root, install the exact dependencies, build the package, and link its CLI:

```sh
npm ci
npm run build
npm link
flow --help
```

The build must succeed. The help output must include `flow quickstart`.

## Complete the credential-free quick start

Create a directory and start the package-owned verification workflow:

```sh
mkdir flow-preview-project
cd flow-preview-project
flow quickstart .
```

The command uses this grammar:

```text
flow quickstart [directory] [--coding] [--provider <provider> --model <model>] [--run-id <id>]
```

The target directory must exist. Flow refuses an existing `.flow/config.yaml`. It does not replace
other files in the directory.

The default path performs these actions:

1. Loads the installed `examples/verify-installation.workflow.yaml` file.
2. Publishes the minimal `.flow/config.yaml` file without replacement.
3. Resolves the published project and its effective policy.
4. Runs the workflow through the production command sandbox.
5. Returns one bounded JSON result after the run reaches a terminal state.

A successful result has this shape:

```json
{
  "version": 1,
  "mode": "foundation",
  "project": { "publication": "created" },
  "run": {
    "id": "quickstart-foundation",
    "status": "succeeded",
    "evidence": ".flow/runs/quickstart-foundation/events.jsonl"
  },
  "commands": {
    "inspect": ["flow", "inspect", "quickstart-foundation"],
    "browser": ["flow", "web", "quickstart-foundation", "--actor", "operator:quickstart"]
  }
}
```

The result contains no command output, model output, credential, provider response, absolute path,
or nested failure cause.

## Inspect the accepted run

Inspect the durable run state:

```sh
flow inspect quickstart-foundation
```

Flow stores the authoritative events at
`.flow/runs/quickstart-foundation/events.jsonl`. Inspection includes graph state, criterion
decisions, bounded command evidence, hashes, sandbox identity, and the effective policy digest.

**Optional:** Start the local browser presentation after you inspect the terminal result:

```sh
flow web quickstart-foundation --actor operator:quickstart
```

`flow quickstart` never starts a browser. The `web` command repeats its own run, actor, listener,
and session checks before it serves the public projection.

## Check one provider and model

Use the provider path only after you configure the exact model that you want to test:

```sh
flow quickstart . \
  --provider anthropic \
  --model claude-sonnet-4-6
```

Flow requires `--provider` and `--model` together. It checks the exact local model and credential
configuration before the first model request. The provider workflow uses one zero-tool agent node,
a 512-token model ceiling, a USD 0.10 reported-cost ceiling, and a 60-second execution limit.

The provider check does not contact the model service. The later workflow execution makes the
selected request through the ordinary agent boundary.

## Complete one bounded coding change

Use explicit `--coding` mode when you want the selected model to read and edit one reviewed
fixture. This path requires an existing empty directory and supports the `anthropic` and `openai`
preview provider identifiers. It does not change the credential-free or zero-tool provider paths.

Read [Complete the coding quick start](guides/coding-quickstart.md) for credential setup, model
selection, cost interpretation, the exact tool and budget boundary, evidence review, cancellation,
cleanup, and recovery.

## Resolve quick-start failures

Use the public error code to choose the next action.

| Code or result | Meaning | Action |
| --- | --- | --- |
| `project_exists` | The target already contains Flow project configuration. | Use `flow run` in the existing project, or choose another directory. |
| `provider_unavailable` | The selected local provider or model configuration failed validation. | Correct the selected model or credential, then use a new empty project. |
| `publication_uncertain` | Flow cannot prove whether project publication settled. | Inspect `.flow/config.yaml`. Do not retry until you know whether it exists. |
| `publication_failed` | Project publication failed before Flow could prove a visible project. | Correct directory access or target safety, then retry in an empty directory. |
| `execution_failed` | Execution failed before Flow returned a durable terminal run. | Inspect `.flow/runs` for evidence before you retry. |
| `cancelled_after_publication` | Cancellation occurred after project publication. | Inspect the project and run directory before you retry. |
| A terminal `failed` or `cancelled` run | Flow accepted and recorded the run, but it did not succeed. | Use the returned `inspect` or `web` command to review its public evidence. |

Invalid, repeated, incomplete, and unknown options fail before project mutation. Cancellation
before publication leaves no project configuration. Cancellation after publication follows the
published project and run settlement rules.

## Choose your next path

- Read [Run and control workflows](guides/run-and-control.md) for detached work, approvals,
  budgets, cancellation, and recovery.
- Read [Complete the coding quick start](guides/coding-quickstart.md) before the first
  provider-backed edit.
- Read the [Workflow specification](workflow-spec.md) before you author executable graphs.
- Read [Use capability packages](guides/capability-packages.md) for signed and local capabilities.
- Read [Reproducible harness evaluation](evaluation.md) before you compare agent harnesses.
- Read [Prime runtime operations](operations/prime-runtime.md) for the Linux x64 Prime profile.
- Read [Contributing](../CONTRIBUTING.md) before you change Flow.
