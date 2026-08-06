# Decision journal: issue 1

## Outcome

Deliver the first executable Flow workflow slice: validate, run, and inspect a deterministic graph whose state is external to the model transcript.

## Acceptance mapping

| Acceptance outcome | Implementation proof |
| --- | --- |
| Reproducible clone and quality gate | Exact dependency lockfile plus `npm run check` and package smoke test |
| Invalid graphs fail before effects | Pure compiler tests and CLI integration test with a recording executor |
| Dependency order is authoritative | Scheduler tests record execution order from compiled edges |
| Failure blocks dependent work | Scheduler test proves downstream executor is never called |
| Model cannot select transitions | Executor result contract contains no next-node field; scheduler contract test |
| Durable, replayable state | JSONL store integration tests plus reducer replay equivalence |
| Provider-neutral model execution | Pi implementation behind the Flow-owned `AgentExecutor` port |
| CLI validate, run, and inspect | Compiled CLI smoke tests over the checked-in example workflow |
| Quality gates pass | Format, lint, type check, unit/integration tests, coverage, build, pack check |

## Decisions

1. Use a single Node.js 22.19+ TypeScript ESM package until runtime boundaries justify packages.
2. Use `apiVersion: flow.synapti.ai/v1alpha1`; the legacy plugin workflow format was advisory and is not compatible.
3. Permit only explicit argument arrays for command nodes. Flow never accepts a shell command string.
4. Make the compiled graph and event reducer pure domain code with no Pi or filesystem imports.
5. Persist Flow events as append-only JSONL. Pi sessions and transcripts are diagnostic, not authoritative.
6. Execute ready nodes sequentially in declaration order for the first slice. Parallel scheduling is out of scope.
7. Use Pi's `createAgentSession()` behind an adapter. Do not build on the unfinished `AgentHarness` paths in Pi 0.84.0.
8. Disable Pi project discovery in the adapter and expose only the exact read-only tool allowlist declared by an agent node.
9. Treat the initial implementation as trusted-workspace mode. A policy hook is not an operating-system sandbox.
10. Accept an agent node only when Pi reports terminal stop reason `stop`; resolved error, aborted, and incomplete sessions are failures.
11. Bind every run to the API version and SHA-256 digest of its compiled workflow, and atomically reserve each run identifier to one store instance.
12. Propagate process signals through the scheduler and active executor, then persist the terminal failure before the CLI exits.

## Review hardening

- Added Flow-owned agent timeouts and terminal stop-reason validation.
- Added atomic cross-process run claiming, committed-line replay, torn-tail repair, and directory syncing.
- Added real process-group cancellation and failing-command CLI integration coverage.
- Added non-topological fan-in scheduling, compiler failure, command cancellation, and exact stream-hash tests.
- Added scheduler-owned cancellation, Pi setup-boundary abort checks, and timeout settlement before terminal return.
- Bounded non-cooperative Pi cleanup and kept the agent deadline referenced until failure is durable.
- Added compiled-process tests for direct signal handling and cross-process run claiming.
- Added a deterministic provider test through Pi's real `ModelRuntime` and `createAgentSession` path.
- Made the live Pi gate fail closed without explicit configuration and pinned CI actions to immutable revisions.
- Upgraded packaging verification from a file-list preview to installation and CLI execution from the produced tarball.

## External actions

| Action | Classification | Reason |
| --- | --- | --- |
| Create public `synaptiai/flow-harness` repository | User-authorized external mutation | Explicitly requested in the task |
| Push verified `main` foundation | User-authorized external mutation | Required to establish the repository |
| Create and assign issue 1 with `enhancement` label | User-approved external mutation | Approved issue preview; no duplicates existed |
| Create `codex/issue-1-executable-graph` branch | Local reversible action | Isolate implementation from `main` |

## Deferred

- Parallel fork/join execution, loops, daemon/TUI, subagents, and distributed scheduling.
- Automatic retry of ambiguous external effects.
- Built-in container or microVM isolation.
- OMP tool ports and Prime-style supervision.
- Automatic resume of in-flight agent or command attempts.
