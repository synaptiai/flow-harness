# Testing and evaluation

## Quality gate

Run the complete local gate with:

```sh
npm run check
```

It verifies formatting, lint rules, strict TypeScript contracts, all default tests, a clean production build, and compiled-process tests. The build removes the previous `dist/` tree first so deleted modules cannot survive into a release artifact. Packaging is checked separately with `npm run pack:check` so cache or registry settings do not affect the main code-quality result.

## Test layers

| Layer | Purpose | External effects |
| --- | --- | --- |
| Domain unit | Workflow/goal compilation, policy classification/operation digests, pure criterion evaluation, and decision/receipt replay invariants | None |
| Application unit | Scheduler ordering, recovery compatibility, completed-node skipping, failure propagation, and executor authority | Test-only in-memory ports |
| Infrastructure integration | Atomic hash-anchored edits, same-host edit-lock recovery, exact-byte versions, protected paths, real JSONL persistence, process ownership, torn-tail repair, and real child processes | Temporary directories and local processes |
| CLI integration | Validate, run, resume, persist, and inspect through production composition | Temporary run ledgers and local processes |
| Compiled-process integration | Direct-entry signal handling, process-group termination, cross-process run claiming, and real sandbox boundaries | Built CLI, temporary run ledgers, local process trees, native sandbox primitives, and loopback networking |
| Pi adapter contract | Exact model/tool request translation, versioned reads, edit receipts, policy-broker routing, setup races, timeout settlement, and committed/uncertain error classification | Temporary workspace and test-only runner at the SDK seam |
| Pi SDK integration | Real `ModelRuntime` and `createAgentSession` composition, `flow_read`/`flow_edit` tool turns, and streaming | Deterministic in-process provider; no network or credentials |
| Live Pi | Provider authentication, streaming, cancellation, and model compatibility | Opt-in network and provider cost |

Test doubles are permitted only in tests at explicit ports. Production modules contain no mock executor, fake provider, fallback success, or sample result.

## Runtime smoke test

After `npm run build`:

```sh
node dist/cli/main.js --help
node dist/cli/main.js validate examples/verify-foundation.workflow.yaml
node dist/cli/main.js run examples/verify-foundation.workflow.yaml --run-id smoke
node dist/cli/main.js inspect smoke
```

The example uses the real argv-only command executor through the production sandbox, accepts a declared goal from terminal typecheck evidence, and requires no model credentials. `npm run test:runtime` additionally spawns the compiled entrypoint, delivers `SIGINT`, proves its POSIX command process group terminates, verifies the forced-exit guard for leaked provider handles, races separate processes for one run identifier, and attacks the real filesystem, environment, run-store, and loopback-network boundary. The package supports Linux and macOS; Windows command nodes fail before spawn because descendant containment is not yet implemented.

Runtime sandbox tests require the host capabilities listed in the README. A sandbox dependency warning is a test failure, not a skip. Running Flow's sandbox suite from inside another restrictive sandbox can prevent SRT from creating its internal Unix socket or namespace; run the suite directly on the host or in a CI runner configured for nested containment. This operational accommodation must not weaken the production profile.

## Live Pi test policy

Live tests are opt-in and excluded from `npm test`. Run them with both `FLOW_LIVE_PI_PROVIDER` and `FLOW_LIVE_PI_MODEL`; the live command fails rather than skips when either is absent. They incur no hidden fallback and fail clearly when provider configuration or credentials are invalid. Unit and integration tests never consume provider credentials.

## Product evaluation

Flow should be compared with the legacy plugin on held-out repository tasks using equivalent model settings. A benchmark records verified task success, false completion, cost, context volume, tool failures, duration, human intervention, policy violations, and crash/replay behavior.

Deterministic held-out checks are preferred. An LLM judge may supplement evidence but cannot override a failing command or missing artifact. Claims that the standalone harness beats the plugin require recorded benchmark results rather than architectural inference.
