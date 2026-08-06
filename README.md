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
- [Delivery roadmap](docs/roadmap.md)

## Project status

The repository is being bootstrapped around the first executable vertical slice: workflow validation, dependency-ordered execution, durable transitions, and an embedded Pi executor boundary.

## License

Apache License 2.0. See [LICENSE](LICENSE).
