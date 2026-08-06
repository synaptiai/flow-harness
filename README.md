# Flow

Flow is an open-source, provider-neutral harness for long-running software work. The current implementation compiles workflow files and optional versioned goals into executable graphs, routes model filesystem reads through a Flow-owned policy broker, and persists authoritative execution, policy, and criterion evidence outside model transcripts. Goal-bearing runs succeed only when deterministic command verifiers accept every declared criterion.

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

The executable harness supports strict workflow and goal validation, sequential dependency-ordered execution, durable JSONL transitions, command verification, criterion-level completion, run inspection, an embedded Pi executor boundary, and a fail-closed policy broker for model-requested `read` and `ls` operations. It does not yet include approvals, write/execute/network model tools, OS-level sandboxing, resume, probabilistic evaluators, or graph loops.

## Try the vertical slice

Flow requires Node.js 22.19 or newer on Linux or macOS. Command nodes are intentionally rejected before process creation on Windows until Flow has reliable descendant-process containment there.

```sh
npm install
npm run check
npm run build
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
```

The example uses the production command executor, declares a goal whose criterion is bound to the terminal typecheck verifier, and requires no model credentials. Agent nodes use provider credentials configured through Pi and currently receive only explicitly declared Flow-owned `read` and `ls` tools. Every filesystem operation those tools perform is canonically resolved and authorized by the Flow policy broker before file contents or directory entries are accessed. Ordered, attributable policy decisions are retained with agent evidence. Pi's ambient tools, extensions, skills, and executable-downloading search helpers are disabled.

Pi has no built-in sandbox. This release is intended for local, trusted workspaces; use an operator-provided container or stronger boundary for untrusted work.

## License

Apache License 2.0. See [LICENSE](LICENSE).
