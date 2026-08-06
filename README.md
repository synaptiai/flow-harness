# Flow

Flow is an open-source, provider-neutral harness for long-running software work. The current implementation compiles workflow files and optional versioned goals into executable graphs, routes model filesystem reads through a Flow-owned policy broker, contains command process trees in a fail-closed OS sandbox, and persists authoritative execution, policy, sandbox, and criterion evidence outside model transcripts. Goal-bearing runs succeed only when deterministic command verifiers accept every declared criterion.

Flow is a standalone product. It does not depend on Claude Code and does not preserve compatibility with the earlier Flow plugin.

## Target product thesis

Modern coding models are capable, but a model is not a workflow engine, authorization boundary, evidence store, or recovery system. Flow's target architecture separates those responsibilities:

- Models solve bounded tasks inside workflow nodes.
- A deterministic scheduler controls graph transitions.
- A policy broker controls the initial read-only model tools and will expand to consequential operations.
- An append-only event ledger records authoritative run state.
- A mutation-free domain evaluator decides whether deterministic evidence accepts each criterion.
- Provider-specific behavior remains behind an execution adapter.

Pi is the initial agent runtime because its SDK offers a small, embeddable agent loop, multi-provider model support, session events, cancellation, tool selection, and custom resource loading. Flow owns everything that decides what may run, what happens next, and what constitutes completion.

## Design principles

1. The compiled workflow graph, not model prose, controls execution.
2. Authoritative state lives outside the model transcript.
3. Context and tools are scoped per node and loaded on demand.
4. Deterministic verification overrides self-reported success.
5. Approval is bound to an exact operation, not ambient permission.
6. Provider and runtime types never enter Flow's public or persisted contracts.
7. Non-idempotent operations are never retried while their effects are uncertain.
8. Every loop has explicit iteration, cost, token, duration, and stagnation bounds.

## Documentation

- [Architecture](docs/architecture.md)
- [Capability sourcing](docs/capability-sourcing.md)
- [Workflow specification](docs/workflow-spec.md)
- [Testing and evaluation](docs/testing-and-evaluation.md)
- [Delivery roadmap](docs/roadmap.md)

## Project status

The executable harness supports strict workflow and goal validation, sequential dependency-ordered execution, durable JSONL transitions, sandboxed command verification, criterion-level completion, run inspection, an embedded Pi executor boundary, and a fail-closed policy broker for model-requested `read` and `ls` operations. It does not yet include approvals, write/execute/network model tools, resume, probabilistic evaluators, graph loops, or a VM-grade boundary for the host-side agent runtime.

## Try the vertical slice

Flow requires Node.js 22.19 or newer on Linux or macOS. Linux command execution also requires bubblewrap, socat, ripgrep, user namespaces, network namespaces, and seccomp support. macOS uses the built-in Seatbelt facility. Flow rejects command nodes before process creation on Windows or whenever the sandbox reports an error or degraded-security warning.

```sh
npm install
npm run check
npm run build
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
```

The example uses the production command executor, declares a goal whose criterion is bound to the terminal typecheck verifier, and requires no model credentials. Each command runs with workspace write access, no network, a private temporary directory, an environment allowlist, and write protection for the actual run store, `.flow`, `.git`, environment files, and key files. Sandbox backend, exact version, profile, and policy digest are retained with command evidence.

Agent nodes use provider credentials configured through Pi and currently receive only explicitly declared Flow-owned `read` and `ls` tools. Every filesystem operation those tools perform is canonically resolved and authorized by the Flow policy broker before file contents or directory entries are accessed. Ordered, attributable policy decisions are retained with agent evidence. Pi's ambient tools, extensions, skills, and executable-downloading search helpers are disabled.

Pi itself has no built-in security boundary, and SRT is a beta native sandbox rather than a microVM. This release is appropriate for trusted local repositories and contained verification commands; use a reviewed container, microVM, Gondolin, or managed sandbox for hostile workloads.

## License

Apache License 2.0. See [LICENSE](LICENSE).
