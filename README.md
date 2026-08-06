# Flow

Flow is an open-source, provider-neutral harness for long-running software work. It compiles goals into enforceable workflow graphs, gives each agent only the context and capabilities its node requires, and accepts completion only when external evidence proves it.

Flow is a standalone product. It does not depend on Claude Code and does not preserve compatibility with the earlier Flow plugin.

## Product thesis

Modern coding models are capable, but a model is not a workflow engine, authorization boundary, evidence store, or recovery system. Flow separates those responsibilities:

- Models solve bounded tasks inside workflow nodes.
- A deterministic scheduler controls graph transitions.
- A policy broker controls tools and consequential operations.
- An append-only event ledger records authoritative run state.
- Independent evaluators decide whether acceptance criteria pass.
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

The first executable vertical slice supports strict workflow validation, sequential dependency-ordered execution, durable JSONL transitions, command verification, run inspection, and an embedded Pi executor boundary.

## Try the vertical slice

Flow requires Node.js 22.19 or newer.

```sh
npm install
npm run check
npm run build
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id first-run
node dist/cli/main.js inspect first-run
```

The example uses the production command executor and requires no model credentials. Agent nodes use provider credentials configured through Pi and currently receive only explicitly declared read-only tools.

Pi has no built-in sandbox. This release is intended for local, trusted workspaces; use an operator-provided container or stronger boundary for untrusted work.

## License

Apache License 2.0. See [LICENSE](LICENSE).
