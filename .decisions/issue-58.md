# Decision Journal: Issue #58 — Let agent nodes use reusable versioned command tools

**Issue**: #58 | **Branch**: `codex/issue-58-versioned-command-tools` | **Started**: 2026-08-08
**Base dependency**: PR #57, commit `73af47a32c433a88133f2072985f4a91071f8142`

---

## Context and mapped flows

Flow can already expose a closed set of built-in workspace tools to a Pi-backed agent and can run
the built-in `flow_exec` tool through Flow-owned policy, live approval, sandboxing, journaling,
cancellation, timeout, output, and budget controls. Gate 6 still lacks reusable versioned tool
contributions. The missing capability is not another executor: it is a strict way to bind an inert,
immutable package definition to that existing execution boundary.

### User: author and select a command tool

1. The user authors a project-local `ToolPackage` manifest containing metadata, one model-visible
   tool contract, and one fixed argv template.
2. The user validates or inspects the package without executing it or revealing unrelated file
   content.
3. A workflow selects the exact package name and version on a specific agent node.
4. Only that selected tool is presented to the model. An agent with no package selection retains
   its existing tool surface exactly.
5. A model call supplies bounded typed inputs; Flow renders those inputs into literal argv and runs
   the request through the same command authority path as `flow_exec`.

### Operator: inspect trust and authority before admission

1. The operator lists package identity, version, provenance, trust, permissions, and content digest
   without importing or executing package code.
2. Admission resolves every exact selection from an immutable capability snapshot.
3. A selected package requesting authority outside the v1 command driver is rejected before a
   model or child process starts.
4. Approval evidence identifies the actual argv and the originating package/input identity.

### System: execute, detach, recover, and replay

1. Admission snapshots exact manifest bytes for every selected tool package in the workflow tree.
2. Attached runs, queued jobs, child runs, workers, and recovery all consume those same bytes; they
   never rediscover the live project package as a fallback.
3. The Pi adapter creates a model tool definition only from the selected immutable manifest.
4. A call is normalized to an `AgentCommandRequest`, annotated with its package source, authorized,
   optionally approved, executed, and journaled by Flow's existing command recorder.
5. Replay independently reconstructs the declared input-to-argv mapping and rejects a package call
   that was unselected, changed, early, reused, contradictory, or inconsistent with its digest.

## Research and challenged assumptions

- Pi extensions can register tools and lifecycle hooks, but they are trusted in-process code with
  host authority. Pi packages install normal dependencies and may load extensions, so they are an
  ergonomics layer rather than a containment or replay boundary. Flow should reuse Pi's typed tool
  interface, not its extension loader. See <https://pi.dev/docs/latest/extensions>,
  <https://pi.dev/docs/latest/packages>, and <https://pi.dev/docs/latest/security>.
- The installed Pi `0.84.0` integration already uses the desired narrow seam:
  `createAgentSession`, `noTools: "all"`, an exact custom-tool list, an in-memory session, zero
  retries, and a locked empty resource loader. Dynamic packaged definitions can enter at that seam
  without granting Pi package authority.
- OMP demonstrates useful capability-registry, tool-introspection, and approval-tier concepts, but
  its marketplace precedence, symlinked installs, extension hooks, and result middleware do not
  provide immutable authority. In particular, middleware able to translate tool failure into
  success is incompatible with Flow's evidence model. Evidence was inspected at commit
  <https://github.com/can1357/oh-my-pi/tree/896bf5f33e0b67bdd0cf951c82739a28e75d0823>.
- Prime Agent's typed host bridge and separated worker lifecycle are useful patterns for a future
  executable extension driver. Its Python skills share an editable kernel environment and host
  permissions, however, so importing that runtime now would make source identity and containment
  weaker than Flow's command path. See the
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e00ea30638584d87b3afea7285a9d7296c/packages/coding-agent/docs/architecture.md>
  and <https://github.com/PrimeIntellect-ai/prime-agent/blob/a18809e00ea30638584d87b3afea7285a9d7296c/packages/coding-agent/docs/skills.md>.
- Starting with remote installation would establish distribution mechanics but would not deliver a
  usable tool. Starting with executable JavaScript/Python would deliver flexibility before Flow has
  a process ABI capable of containing it. A declarative command driver is the smallest vertical
  slice that is both useful and governed.
- OMP benchmark claims are not sufficient as an adoption gate without held-out tasks, fixed seeds,
  repeated runs, raw trajectories, and confidence intervals. Flow will benchmark useful OMP tools
  only after their behavior is represented through this provider-neutral ABI.

## Specification

_Captured by specification-capture on 2026-08-08. Source: Issue #58 and the approved Gate 6
architecture direction._

### Non-goals

- Does not execute package-supplied JavaScript, TypeScript, Python, Wasm, native code, shell text,
  hooks, providers, middleware, graph mutations, workflow nodes, evaluators, or result translators.
- Does not install, update, sign, publish, or resolve packages from registries, Git, URLs, or other
  network sources.
- Does not add environment variables, credentials, working-directory overrides, stdin, PTYs,
  background processes, interactive sessions, network authority, or weaker containment.
- Does not allow packages to intercept built-in tools, approval decisions, policy outcomes, model
  calls, executor outcomes, or durable events.
- Does not make package selection implicit, accept mutable version ranges, or expose all discovered
  packages to every agent.
- Does not claim that tool output is correct, trustworthy, deterministic, or prompt-injection-safe.
- Does not remove `flow_exec`, change the behavior of nodes that select no packages, or invalidate
  historical direct-command events.

### Failure modes

- **Invalid manifest** — Unknown fields, unsupported API/kind/driver versions, malformed exact
  SemVer, duplicate identities, invalid provider-facing names, reserved names, excessive values,
  unsupported input shapes, or unsafe templates fail before execution.
- **Missing or ambiguous selection** — A missing exact `(name, version)` tuple, duplicate selected
  identity, duplicate model tool name, built-in name collision, or wrong package kind fails the
  complete workflow admission.
- **Source race** — Symlinks, non-regular files, identity replacement, or byte changes between
  discovery and snapshot fail closed. Runtime never repairs a drifted snapshot from live files.
- **Malformed call** — Unknown/missing inputs, wrong scalar types, excessive strings, non-finite or
  non-integer numbers, and rendered argv outside existing command bounds fail before policy.
- **Forged provenance** — A source digest, input digest, rendered argv, or package identity that does
  not reconstruct from the durable snapshot fails replay independently of application claims.
- **Approval contradiction** — Missing, expired, denied, cancelled, reused, or operation-mismatched
  approval retains existing fail-closed semantics. A package cannot weaken an explicit `exec`
  approval requirement.
- **Execution failure** — Spawn errors, non-zero exits, timeout, cancellation, output truncation,
  sandbox refusal, policy denial, or budget exhaustion retain existing typed command outcomes.
- **Partial failure** — Package discovery/snapshot/binding rejects the complete requested set. A
  run never starts with only some selected tools.
- **Dependency outage** — Package admission has no provider or network dependency. Provider failure
  before a call produces no invented package outcome; command-runtime failure remains journaled.
- **Resource exhaustion** — Per-field, manifest, package-count, snapshot, command-count, argv,
  timeout, output, execution-time, and budget limits fail with bounded errors.

### Interface contracts

Project-local manifest:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: ToolPackage
metadata:
  name: git-status
  version: 1.0.0
  description: Show a bounded machine-readable workspace status.
  license: Apache-2.0
  compatibility: Requires Git in the execution environment.
spec:
  tool:
    name: project_git_status
    description: Return the current project status.
    inputs: []
  driver:
    kind: command
    version: v1
    profile: git-status-v1
    executable: /usr/bin/git
    args: [--no-optional-locks, -c, core.fsmonitor=false, -c, core.untrackedCache=false, status, --short, --untracked-files=normal, --ignore-submodules=all]
    timeoutMs: 10000
  permissions: [process.execute]
```

Workflow selection:

```yaml
agent:
  tools: [read, ls]
  toolPackages:
    - { name: git-status, version: 1.0.0 }
  toolApproval:
    exec: { mode: required, grantTtlMs: 300000 }
```

The first manifest version supports one tool and required scalar inputs only: bounded string,
integer, boolean, or a bounded string enum. Input definitions are ordered and names are unique.
Every declared input must be used at least once by an exact whole-argument `{input:<name>}`
placeholder; interpolation inside a larger string is rejected. Literal arguments remain literal.
String and enum values are passed exactly, integers use canonical base-10 text, and booleans use
`true` or `false`. There is no shell expansion.

Package identity is `(kind=tool-package, name, exact version, digest)`. The digest covers the exact
validated definition and source-byte identity. The capability snapshot stores portable provenance,
trust=`project-explicit`, requested permissions, parsed definition, exact manifest bytes/hash, and
the recomputable package digest. The selected set is explicit per agent node and canonically
ordered for durable requirements.

The adapter turns a selected definition into a Pi `ToolDefinition`, but the domain contract is
provider-neutral. A call creates the existing normalized `AgentCommandRequest` plus optional source:

```ts
{
  kind: "tool-package",
  name: "git-status",
  version: "1.0.0",
  digest: "<sha256>",
  toolName: "project_git_status",
  input: {},
  inputDigest: "<sha256>"
}
```

Driver `v1` selects one closed Flow-owned profile. The initial registry contains the non-evaluating
`posix-printf-v1` data profile and exact hardened `git-status-v1`; they bind `/usr/bin/printf` and
`/usr/bin/git`, so a workspace-controlled `PATH` cannot replace the executable. Project packages
cannot register profiles or executable identities. Manifest admission applies the live agent-command
byte, argv, and timeout envelope. This closes the review-discovered path where an interpreter plus a
model input could recreate raw execution and where a package could validate but never produce a
valid call.

Direct `flow_exec` requests omit `source`; their historical digest calculation is unchanged. When
source is present, the operation digest covers source and rendered command. Selection grants only
the authority to request the declared command tool; Flow still derives `process.execute`, evaluates
policy, obtains live approval when configured, applies sandboxing, and records the result. The
existing per-node command-call cap includes direct and packaged calls together.

Metadata commands are `flow tools list`, `flow tools inspect <name> --version <exact>`, and
`flow tools validate`. They parse and snapshot inert files but never invoke a driver.

## Coupling analysis

```text
project TOOL.yaml -> no-follow catalog -> immutable capability snapshot -> run_started / queued job
                                           |                         |
workflow exact selection -> compiler ------+-> node requirements ----+-> reducer/replay
                                           |
                                           +-> selected tool binder -> Pi ToolDefinition
                                                                      |
model scalar input -> deterministic argv renderer -> AgentCommandRecorder
                                                   | policy / approval / sandbox
                                                   +-> durable prepared/outcome events
```

- Domain capability code owns schemas, canonical input/argv rendering, package identity, digest,
  bounds, snapshot validation, and exact lookup. It imports no filesystem, Pi, executor, or provider.
- Filesystem infrastructure owns no-follow discovery and exact-byte snapshot construction. It does
  not execute the package or interpret model calls.
- Workflow domain owns exact package references and selected tool-name uniqueness. It does not
  discover live files.
- The Pi adapter owns only translation from the provider-neutral tool definition to Pi's custom-tool
  shape. It receives no package hooks and cannot bypass the Flow recorder.
- The existing command recorder remains the sole process authority and event publisher. Source
  metadata extends the request but does not create a second execution protocol.
- Run replay owns an independent reconstruction check between workflow requirement, immutable
  snapshot, package input, argv, policy/approval evidence, and command outcome.
- Supervisor and detached transports carry the tagged snapshot unchanged and do not interpret tool
  package definitions.

## Approaches considered

| Approach | Simplicity | Flexibility | Safety/replay | Effort | Disposition |
| --- | --- | --- | --- | --- | --- |
| Load Pi/OMP extensions in-process | High author convenience | Very high | Low: arbitrary host authority, mutable hooks, provider coupling | Medium | Rejected |
| Import Prime-style Python skills | Medium for Python authors | High | Low until Flow has a locked kernel/process ABI and dependency identity | High | Deferred as a future contained driver |
| Build remote registry/CAS first | Low user value now | High distribution potential | Medium: identity helps, but acquisition adds a new trust boundary before execution works | High | Deferred until local ABI stabilizes |
| Strict local declarative command tools | High | Deliberately bounded | High: inert manifests, deterministic rendering, existing command governance | Medium | **Selected** |

The selected design sacrifices arbitrary code and optional rich schemas in v1. In return, every
model-visible capability has an exact static authority envelope, and replay can derive rather than
trust the command that should have been executed.

## Decision

Implement strict project-local `ToolPackage` manifests whose only initial driver is a fixed,
argv-only command template with required scalar inputs. Extend the existing immutable capability
snapshot and workflow requirement transport with exact tool-package identities. Bind only selected
packages into Pi custom tools, then execute their rendered requests through the existing
`AgentCommandRecorder`. Persist package and input provenance in the command request and verify the
whole relationship during replay. Keep direct built-in tools compatible. Defer executable package
code, remote acquisition, and non-command contributions.

## Acceptance verification map

| Criteria covered | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Strict manifest, identity, digest, inspection | Contract/adversarial | `npx vitest run test/unit/capability/tool-packages.test.ts test/unit/capability/local-tool-packages.test.ts` | Exact valid snapshots pass; invalid, duplicate, unsafe, oversized, symlinked, drifted, reserved, and unsupported definitions reject without execution | Remote acquisition or signatures |
| Exact workflow selection and unchanged defaults | Contract | `npx vitest run test/unit/workflow/tool-package-compiler.test.ts test/unit/capability/workflow-tool-packages.test.ts` | Exact selections bind; unselected tools are absent; no-selection compilation stays compatible; collisions reject | Automatic package discovery on agents |
| Deterministic scalar input to literal argv | Domain/property | `npx vitest run test/unit/capability/tool-package-renderer.test.ts` | Valid scalar values render canonically; malformed, unknown, missing, excessive, unused, interpolated, and shell-like values cannot change argv structure | Shell, stdin, env, cwd, arrays, or nested input |
| Existing policy/approval/sandbox/journal/budget path | Application/adversarial | `npx vitest run test/unit/infrastructure/pi/workspace-tool-packages.test.ts test/integration/pi/pi-agent-executor.test.ts` | A real Pi call plus focused adapter tests use the same recorder, required approval, and every direct-command control and cap | Correctness of external executables |
| Durable requirements and replay reconciliation | Domain/adversarial | `npx vitest run test/unit/run/tool-package-reducer.test.ts` | Unselected, changed, early, reused, contradictory, forged-source/input/argv/digest, and outcome mismatches reject | Historical migration beyond the current v1 contract |
| Attached/detached/child/recovery transport | Integration | `npx vitest run test/integration/cli/tool-packages.test.ts test/integration/supervisor/worker.test.ts -t "tool package"` | Exact immutable bytes cross every execution mode with no live-source fallback | Remote workers or host-reboot guarantees not already provided by Flow |
| Metadata CLI and public credential-free example | Integration/docs | `npx vitest run test/integration/cli/tool-packages.test.ts test/scaffold/community-files.test.ts` | List/inspect/validate do not execute; example validates without model credentials | A credential-free live model call |
| Complete regression and package quality | Release | `npm run check && npm run test:coverage && npm run pack:check && npm audit --audit-level=high` | Format, lint, types, unit/integration/runtime tests, build, coverage, packed CLI, and dependency audit pass | Hosted CI availability |

## Planned RED -> GREEN -> REFACTOR sequence

1. **Package contract RED/GREEN** — Prove strict parsing, canonical definition/source/package
   digests, exact-byte snapshots, no-follow/race refusal, duplicate/version/bound errors, immutable
   lookup, and metadata-only inspection.
2. **Renderer RED/GREEN** — Prove required scalar validation and deterministic whole-argument argv
   substitution independently of Pi or process execution.
3. **Workflow RED/GREEN** — Add exact per-agent package selection, compilation/loop remapping,
   collision checks, capability binding, and unchanged no-selection behavior.
4. **Tool binding RED/GREEN** — Create provider-neutral selected definitions and Pi adapters that
   pass rendered package calls into the existing recorder with the combined command cap.
5. **Run contract RED/GREEN** — Persist requirements/source identity and independently reconcile
   package selection, snapshot, rendered argv, command/approval lifecycle, and recovery replay.
6. **Composition RED/GREEN** — Prove CLI metadata operations plus attached, queued, child, worker,
   and recovery transport without live rediscovery.
7. **REFACTOR/VERIFY** — Extract shared catalog mechanics only where both existing package kinds and
   tool packages prove the abstraction; update public docs/examples; run coverage, clean install,
   runtime, audit, mutation probes, adversarial review, and holdout verification. Refresh graph
   artifacts only when the repository defines a tracked graph-output contract.

## Implementation tasks

1. [x] Build and verify the strict local command-tool package catalog and immutable snapshot.
2. [x] Render bounded scalar calls to literal argv without shell semantics.
3. [x] Compile and bind exact per-agent package selections.
4. [x] Execute selected tools through Flow's existing command governance path.
5. [x] Persist requirements and reconcile package calls independently during replay.
6. [x] Complete CLI, attached/detached/child/recovery integration.
7. [x] Update public examples, README, architecture, workflow, security, recovery, testing,
   capability, and roadmap documentation; run full and adversarial verification.

## Verification evidence

Verified in a clean local clone on 2026-08-08:

- `npm run check`: formatting and linting passed across 189 files; type checking and build passed;
  1,445 tests passed across 113 files; 21 runtime tests passed across three files.
- `npm run test:coverage`: 84.25% statements, 78.29% branches, 93.36% functions, and 84.30%
  lines across the complete 1,445-test suite.
- `npm audit --audit-level=high`: zero vulnerabilities.
- `npm run pack:check`: the packed `synaptiai-flow-harness-0.0.0.tgz` installed into a clean
  consumer project and its CLI initialized and resolved configuration successfully.
- Compiled CLI smoke: the public `git-status@1.0.0` example passed `tools validate`, `tools list`,
  exact-version `tools inspect`, and workflow validation; list and inspect exposed
  `trust=project-explicit` and `provenance=.flow/tools/git-status`.
- Independent security, holdout, and test challenge reviews converged at zero P1/P2/P3 findings
  after all findings were fixed and re-reviewed.

No graph artifact was refreshed: the repository defines no tracked graph-output contract, and the
local untracked `graphify-out/` directory is user-owned and remained untouched.
