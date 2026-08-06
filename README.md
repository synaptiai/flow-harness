# Flow

Flow is a provider-neutral coding-agent harness with deterministic workflow graphs, durable
evidence, and fail-closed sandboxed command execution.

> **Pre-alpha source preview:** Flow is under active development, its contracts may change, and
> `@synaptiai/flow-harness` is not published to npm. Build and run it from a reviewed source
> checkout. Do not use it as a security boundary for hostile or multi-tenant workloads.

Flow is a standalone product. It does not depend on Claude Code and does not preserve
compatibility with the earlier Flow plugin. Pi supplies the initial model-facing agent loop;
Flow owns scheduling, policy, containment, evidence, and completion.

## What works today

| Capability | Status |
| --- | --- |
| Strict workflow and goal compilation | Implemented |
| Sequential dependency-ordered execution | Implemented |
| Durable JSONL run ledger and inspection | Implemented |
| Deterministic criterion verification | Implemented |
| Bounded Pi agent nodes with Flow-owned `read` and `ls` tools | Implemented |
| Fail-closed sandboxed command process trees | Implemented on Linux and macOS |
| Approvals, resume, graph loops, and broader model tools | Planned |
| VM-grade isolation of the host-side agent runtime | Planned |

The executable format is `flow.synapti.ai/v1alpha1`. There is no compatibility or migration
promise before the first stable release.

## Run the source preview

### Prerequisites

- Git
- Node.js 22.19 or newer
- npm with lockfile support
- Linux or macOS

On Ubuntu or Debian, install the native sandbox dependencies:

```sh
sudo apt-get update
sudo apt-get install --yes bubblewrap socat ripgrep
```

Linux also requires unprivileged user namespaces, network namespaces, and seccomp support. macOS
uses the built-in Seatbelt facility. Windows command nodes fail before process creation because
descendant containment is not implemented there.

### Build and verify

```sh
git clone https://github.com/synaptiai/flow-harness.git
cd flow-harness
npm ci --ignore-scripts
npm run check
npm run build
```

`npm ci --ignore-scripts` installs only the exact lockfile. Use `npm install` only when
intentionally changing dependencies.

### Execute the example

```sh
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
```

The example needs no model credentials. Its terminal verifier runs inside the production command
sandbox and the final command exits successfully only when the declared goal criterion is
accepted. Authoritative events are written to:

```text
.flow/runs/first-run/events.jsonl
```

The inspected result identifies graph state, criterion decisions, bounded command output and
hashes, plus the sandbox backend, exact version, profile, and semantic policy digest.

## Security boundary

Each command and descendant receives workspace write access, a private temporary directory, an
explicit environment allowlist, and no network. The actual run store, `.flow`, `.git`, environment
files, and key files are write-protected. If the sandbox is unavailable or reports degraded
isolation, Flow does not spawn the command.

Agent nodes are different: the host-side Pi runtime runs with the invoking user's operating-system
permissions and currently receives only explicitly declared Flow-owned `read` and `ls` tools.
Their filesystem operations are canonically resolved and authorized by the Flow policy broker.
Pi's ambient tools, extensions, skills, templates, context discovery, and executable-downloading
helpers are disabled.

SRT is a beta native sandbox rather than a microVM. Use a reviewed container, microVM, Gondolin,
OpenShell, or managed sandbox for hostile workloads. Read the [security policy](SECURITY.md) before
running unattended work.

## Product thesis

A coding model is not a workflow engine, authorization boundary, evidence store, or recovery
system. Flow separates those responsibilities:

- Models solve bounded tasks inside workflow nodes.
- A deterministic scheduler controls graph transitions.
- A policy broker controls model-requested operations.
- A sandbox contains command process trees.
- An append-only event ledger records authoritative run state.
- Mutation-free evaluation decides whether deterministic evidence accepts each criterion.
- Provider-specific behavior remains behind execution adapters.

The compiled graph—not model prose—decides what runs next. A confident completion narrative cannot
override missing or failing evidence.

## Documentation

- [Architecture](docs/architecture.md)
- [Capability sourcing](docs/capability-sourcing.md)
- [Workflow specification](docs/workflow-spec.md)
- [Testing and evaluation](docs/testing-and-evaluation.md)
- [Delivery roadmap](docs/roadmap.md)

## Community

- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
