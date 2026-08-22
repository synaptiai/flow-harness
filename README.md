# Flow

Flow is a provider-neutral coding-agent harness. It executes deterministic workflow graphs, records
durable evidence, and confines command execution through fail-closed sandboxes.

> **Alpha preview:** Flow is under active development. Its contracts may change. Install the
> versioned prerelease from its immutable GitHub release, and don't use it as a security boundary
> for hostile or multi-tenant workloads.

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
- Private, provider-neutral model-session records preserve bounded completed context for safe fresh
  recovery without controlling workflow state.
- Mutation-free evaluation decides whether evidence accepts each criterion.
- Provider-specific behavior remains behind execution adapters.

The compiled graph decides what runs next. Model prose cannot override missing or rejected evidence.

## Project status

Flow is a public alpha preview. The executable format is
`flow.synapti.ai/v1alpha1`. There is no compatibility or migration promise before the first stable
release.

Current capability groups include:

### Workflow execution

- Deterministic graphs, branches, joins, loops, child workflows, and bounded optimization.
- Typed results, durable evidence, exact replay, and proof-gated recovery.
- Command, agent-command, and evidence approvals.
- Run budgets and provider-neutral policy enforcement.
- An operator-maintained, revisioned goal workspace that can be frozen into attached, detached,
  resumed, and child runs without gaining workflow authority.
- Bounded read-only semantic code queries through an exact operator-selected language server.
- Attached and detached execution with local terminal, browser, and ACP control.

### Capability distribution and evaluation

- Inert skill, verifier, tool, workflow, policy, and presentation packages.
- Exact HTTPS and publisher-authenticated OCI bundle acquisition.
- Signed metadata and TUF repository review, activation, replacement, and bounded watching.
- Reproducible Flow, Pi, OMP, and Prime evaluation profiles with reviewed root,
  child-specialist, and supplemental-memory candidates, including bounded model-suggested memory.

Linux and macOS support ordinary workflow execution. Agent `exec`, the container command profile,
and Prime Agent have narrower platform requirements.

Read [Project status](docs/project-status.md) for the current feature and platform matrix. Read the
[Delivery roadmap](docs/roadmap.md) for completed gates and planned work.

## Quick start

The guided command is available in the current source tree. It creates a minimal Flow project and
completes one credential-free workflow through the production command sandbox.

### Prerequisites

- Node.js 26.7 or newer
- npm with global package support
- x64 Linux or macOS

Build and link the current source:

```sh
npm ci
npm run build
npm link
```

Create a directory and complete the first run:

```sh
mkdir flow-preview-project
cd flow-preview-project
flow quickstart .
```

The result contains the run status, the project-relative evidence path, and tokenized `inspect` and
`web` follow-up commands. Flow does not open a browser.

Read [Getting started](docs/getting-started.md) for provider selection, output details, and failure
recovery. Use the [coding quick start](docs/guides/coding-quickstart.md) when you are ready to prove
one real provider-backed read, hash-bound edit, and deterministic verification. The immutable
`0.1.0-alpha.1` archive predates `flow quickstart`. Follow
[Install the Flow preview](docs/guides/install-preview.md) for that release's verified manual path.

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
| [Install the Flow preview](docs/guides/install-preview.md) | Verified package download, installation, removal, and release-specific limits |
| [Getting started](docs/getting-started.md) | Source setup and the first credential-free run |
| [Complete the coding quick start](docs/guides/coding-quickstart.md) | Provider setup, one bounded edit, cost interpretation, evidence, cancellation, cleanup, and recovery |
| [Diagnose the Flow environment](docs/guides/diagnose-environment.md) | Read-only host, project, workflow, provider, sandbox, and Prime preflight |
| [Project status](docs/project-status.md) | Maturity, platform support, and planned boundaries |
| [Run and control workflows](docs/guides/run-and-control.md) | Work profiles, detached runs, presentation hosts, approvals, budgets, cancellation, and recovery entry points |
| [Maintain a durable goal workspace](docs/guides/goal-workspaces.md) | Revisioned long-horizon context, evidence references, compare-and-set updates, run selection, and recovery |
| [Use read-only semantic code queries](docs/guides/semantic-code.md) | Exact language-server selection, bounded queries, containment, evidence, and failure handling |
| [Retain and inspect command artifacts](docs/guides/retained-artifacts.md) | Exact oversized command output, bounded agent reads, inspection, retention, and pruning |
| [Inspect and recover portable model sessions](docs/guides/model-sessions.md) | Private context records, public integrity metadata, fresh recovery, limits, and failure handling |
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
