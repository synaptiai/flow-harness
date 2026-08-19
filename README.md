# Flow

Flow is a provider-neutral coding-agent harness. It executes deterministic workflow graphs, records
durable evidence, and confines command execution through fail-closed sandboxes.

> **Pre-alpha source preview:** Flow is under active development. Its contracts may change, and
> `@synaptiai/flow-harness` is not published to npm. Build it from a reviewed source checkout. Do
> not use it as a security boundary for hostile or multi-tenant workloads.

Flow is a standalone product. It does not depend on Claude Code or preserve compatibility with the
earlier Flow plugin. Pi supplies the default model-facing agent loop. Flow owns scheduling, policy,
containment, evidence, recovery, and completion.

## Why Flow

A coding model is not a workflow engine, authorization boundary, evidence store, or recovery
system. Flow separates those responsibilities.

### Execution

- Models solve bounded tasks inside workflow nodes.
- A deterministic scheduler controls graph transitions.
- A policy broker controls model-requested operations.
- Native sandboxes confine command filesystem and network access.

### Evidence and control

- An append-only ledger records authoritative run state and evidence.
- A local supervisor owns detached discovery and control without owning graph transitions.
- Durable budgets stop new work at replayable boundaries.
- Mutation-free evaluation decides whether evidence accepts each criterion.
- Provider-specific behavior remains behind execution adapters.

The compiled graph decides what runs next. Model prose cannot override missing or rejected evidence.

## Project status

Flow is a public pre-alpha source preview. The executable format is
`flow.synapti.ai/v1alpha1`. There is no compatibility or migration promise before the first stable
release.

Current capability groups include:

### Workflow execution

- Deterministic graphs, branches, joins, loops, child workflows, and bounded optimization.
- Typed results, durable evidence, exact replay, and proof-gated recovery.
- Command, agent-command, and evidence approvals.
- Run budgets and provider-neutral policy enforcement.
- Attached and detached execution with local terminal, browser, and ACP control.

### Capability distribution and evaluation

- Inert skill, verifier, tool, workflow, policy, and presentation packages.
- Exact HTTPS and publisher-authenticated OCI bundle acquisition.
- Signed metadata and TUF repository review, activation, replacement, and bounded watching.
- Reproducible Flow, Pi, OMP, and Prime evaluation profiles with reviewed adaptive candidates.

Linux and macOS support ordinary workflow execution. Agent `exec`, the container command profile,
and Prime Agent have narrower platform requirements.

Read [Project status](docs/project-status.md) for the current feature and platform matrix. Read the
[Delivery roadmap](docs/roadmap.md) for completed gates and planned work.

## Quick start

This path builds the source preview and completes one credential-free run.

### Prerequisites

- Git
- Node.js 26.7 or newer
- npm with lockfile support
- Linux or macOS

Clone and build the exact dependency graph:

```sh
git clone https://github.com/synaptiai/flow-harness.git
cd flow-harness
npm ci --ignore-scripts
npm run build
```

Initialize the checkout as a Flow project:

```sh
node dist/cli/main.js init .
node dist/cli/main.js config show
```

Validate and run the credential-free foundation workflow:

```sh
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
```

The verifier runs through the production command sandbox. The run succeeds only when deterministic
evidence accepts the declared goal criterion.

Flow stores authoritative events in `.flow/runs/first-run/events.jsonl`.

Continue with [Getting started](docs/getting-started.md) for explanations, troubleshooting, and
reader-specific next steps.

## Security

Flow fails before command spawn when the selected sandbox cannot prove its required isolation.
Command tasks receive an explicit environment, a private temporary directory, no task network, and
bounded filesystem authority.

The host-side Pi runtime still runs with the invoking user's operating-system permissions. It
receives only the Flow-owned tools declared by the workflow. Agent `exec` requires verified Linux
PID-namespace descendant containment.

Detached supervisor controls coordinate trusted processes for one operating-system user. They are
not a sandbox against that same user or root.

SRT and the container profile are not VM-grade hostile-workload boundaries. Use a reviewed
container, microVM, or managed sandbox for hostile workloads.

Read [SECURITY.md](SECURITY.md) before unattended or high-impact use. Report suspected
vulnerabilities through a private GitHub security advisory, not a public issue.

## Documentation

The [documentation hub](docs/README.md) routes each reader task to one canonical document.

| Start with | When you need |
| --- | --- |
| [Getting started](docs/getting-started.md) | Source setup and the first credential-free run |
| [Project status](docs/project-status.md) | Maturity, platform support, and planned boundaries |
| [Run and control workflows](docs/guides/run-and-control.md) | Detached runs, presentation hosts, approvals, budgets, cancellation, and recovery entry points |
| [Use capability packages](docs/guides/capability-packages.md) | Skills, verifiers, tools, workflows, policies, presentations, bundles, and repositories |
| [Prime runtime operations](docs/operations/prime-runtime.md) | Dedicated Linux x64 Prime and container-profile preparation |
| [Workflow specification](docs/workflow-spec.md) | Normative executable and persisted contracts |
| [Architecture](docs/architecture.md) | System diagram, component ownership, trust boundaries, failure modes, and non-goals |
| [Recovery and interruption safety](docs/recovery.md) | Exact restart, uncertainty, and remediation rules |
| [Reproducible harness evaluation](docs/evaluation.md) | Comparative plans, private verification, candidates, activation, and export |
| [Testing and evaluation](docs/testing-and-evaluation.md) | Contributor gates, test layers, runtime proofs, and live-provider policy |

## Community

- Read [Contributing](CONTRIBUTING.md) before preparing a change.
- Use [Support](SUPPORT.md) for usage and development questions.
- Follow the [Code of conduct](CODE_OF_CONDUCT.md).
- Use the [Security policy](SECURITY.md) for private vulnerability reporting.

## License

Apache License 2.0. See [LICENSE](LICENSE) and
[third-party notices](THIRD_PARTY_NOTICES.md).
