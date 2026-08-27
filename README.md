# Flow

Flow is a provider-neutral coding-agent harness. It executes deterministic workflow graphs, records
durable evidence, and confines command execution through fail-closed sandboxes.

> **Alpha preview:** Flow is under active development. Its contracts may change. Install the
> published npm prerelease from the `preview` channel, or verify and install its immutable GitHub
> release. Don't use Flow as a security boundary for hostile or multi-tenant workloads.

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

Flow is a public alpha preview. The executable format is `flow.synapti.ai/v1alpha1`. Alpha.4 is the
first checkpoint governed by a bounded, tested compatibility policy for selected historical
artifacts. It doesn't claim stable support or automatic migration.

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
- Operator-selected prompt-only local ACP v1 execution and paired exact-agent qualification with
  fresh isolated processes, private result verification, and provider-neutral evidence.
- Optional exact Lean statement verification on a reproducible Linux x64 appliance. The profile
  requires human statement approval, SafeVerify replay, Nanoda checking, and confirmed cleanup.

### Capability distribution and evaluation

- Inert skill, verifier, tool, workflow, policy, and presentation packages.
- Exact HTTPS and publisher-authenticated OCI bundle acquisition.
- Signed metadata and TUF repository review, activation, replacement, and bounded watching.
- Reproducible Flow, Pi, OMP, and Prime evaluation profiles with reviewed root,
  child-specialist, and supplemental-memory candidates, including bounded model-suggested memory
  and evidence-backed relationships.
- Exact phase-aware model routing with per-request durable evidence and held-out qualification
  before activation.
- A sealed one-call local delegation experiment with paired task classes, durable child evidence,
  exact resource accounting, and no activation path.
- A balanced three-mode experiment for complete history, verified artifact references, and bounded
  summaries. It cannot activate production compaction.

Linux and macOS support ordinary workflow execution. Agent `exec`, the container command profile,
and Prime Agent have narrower platform requirements.

Read [Project status](docs/project-status.md) for the current feature and platform matrix. Read the
[Delivery roadmap](docs/roadmap.md) for completed gates and planned work.

## Quick start

The `0.1.0-alpha.4` checkpoint provides the guided command. It creates a minimal Flow project and
completes one credential-free workflow through the production command sandbox.

### Prerequisites

- Node.js 26.7 or newer
- npm with global package support
- x64 Linux or macOS

Install the published preview and confirm that your shell can call Flow:

```sh
npm install --global --ignore-scripts @synapti/flow-harness@preview
flow --help
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
one real provider-backed read, hash-bound edit or replacement, and deterministic verification. Follow
[Install the Flow preview](docs/guides/install-preview.md) for exact-version pinning, one-off npm
invocation, provenance verification, upgrades, removal, and `PATH` recovery.

## Security

Flow fails before command spawn when the selected sandbox cannot prove its required isolation.
Command tasks receive an explicit environment, a private temporary directory, no task network, and
bounded filesystem authority.

The host-side Pi runtime still runs with the invoking user's operating-system permissions. It
receives only the Flow-owned tools declared by the workflow. The built-in file tools are `read`,
`ls`, `create`, `mkdir`, and `edit`. Agent `exec` requires verified Linux
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
| [Install the Flow preview](docs/guides/install-preview.md) | Published installation, invocation, exact pinning, provenance verification, removal, and release-specific limits |
| [Getting started](docs/getting-started.md) | Installed command verification and the first credential-free run |
| [Complete the coding quick start](docs/guides/coding-quickstart.md) | Provider setup, one bounded edit, cost interpretation, evidence, cancellation, cleanup, and recovery |
| [Diagnose the Flow environment](docs/guides/diagnose-environment.md) | Read-only host, project, workflow, provider, sandbox, and Prime preflight |
| [Project status](docs/project-status.md) | Maturity, platform support, and planned boundaries |
| [Compatibility policy](docs/compatibility.md) | Supported surfaces, the packaged historical corpus, prerelease changes, migration, and rollback |
| [Library API assessment](docs/library-api-assessment.md) | Why the package remains CLI-only and what evidence a future programmatic API needs |
| [Run and control workflows](docs/guides/run-and-control.md) | Work profiles, detached runs, presentation hosts, approvals, budgets, cancellation, and recovery entry points |
| [Maintain a durable goal workspace](docs/guides/goal-workspaces.md) | Revisioned long-horizon context, evidence references, compare-and-set updates, run selection, and recovery |
| [Use read-only semantic code queries](docs/guides/semantic-code.md) | Exact language-server selection, bounded queries, containment, evidence, and failure handling |
| [Retain and inspect command artifacts](docs/guides/retained-artifacts.md) | Exact oversized command output, bounded agent reads, inspection, retention, and pruning |
| [Inspect and recover portable model sessions](docs/guides/model-sessions.md) | Private context records, public integrity metadata, fresh recovery, limits, and failure handling |
| [Keep long model sessions within provider capacity](docs/guides/rolling-context.md) | Opt-in exact request measurement, rolling checkpoints, inspection, limits, and recovery |
| [Evaluate reference-first context compaction](docs/guides/context-compaction.md) | Held-out three-mode plans, protected constraints, metrics, verdicts, and recovery |
| [Manage supplemental-memory relationships](docs/guides/supplemental-memory-relationships.md) | Evidence-backed memory relationships, atomic rebinding, review, activation, rollback, limits, and recovery |
| [Use capability packages](docs/guides/capability-packages.md) | Skills, verifiers, tools, workflows, policies, presentations, bundles, and repositories |
| [Prime runtime operations](docs/operations/prime-runtime.md) | Dedicated Linux x64 Prime and container-profile preparation |
| [Workflow specification](docs/workflow-spec.md) | Normative executable and persisted contracts |
| [Architecture](docs/architecture.md) | System diagram, component ownership, trust boundaries, failure modes, and non-goals |
| [Recovery and interruption safety](docs/recovery.md) | Exact restart, uncertainty, and remediation rules |
| [Reproducible harness evaluation](docs/evaluation.md) | Comparative plans, private verification, candidates, activation, and export |
| [Qualify two local ACP agents](docs/guides/qualify-acp-agents.md) | Paired production-agent identity, private result verification, accounting, verdicts, and recovery |
| [Evaluate bounded one-shot delegation](docs/guides/evaluate-bounded-delegation.md) | Sealed candidate authority, paired task classes, child evidence, verdicts, recovery, and non-goals |
| [Verify an exact Lean statement](docs/guides/lean-proof-verification.md) | Proof inputs, human statement approval, checker evidence, qualification, and non-goals |
| [Lean proof runtime operations](docs/operations/lean-proof-runtime.md) | Reproducible Linux x64 preparation, containment, identity, recovery, and replacement |
| [Testing and evaluation](docs/testing-and-evaluation.md) | Contributor gates, test layers, runtime proofs, and live-provider policy |

## Community

- Read [Contributing](CONTRIBUTING.md) before preparing a change.
- Use [Support](SUPPORT.md) for usage and development questions.
- Follow the [Code of conduct](CODE_OF_CONDUCT.md).
- Use the [Security policy](SECURITY.md) for private vulnerability reporting.

## License

Apache License 2.0. See [LICENSE](LICENSE) and
[third-party notices](THIRD_PARTY_NOTICES.md).
