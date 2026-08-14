# Decision Journal: Issue #78 — Run declared commands through a higher-isolation container profile

**Issue**: #78 | **Branch**: `codex/issue-78-container-sandbox` | **Started**: 2026-08-13

---

## Context

Flow's production command executor uses a fixed Anthropic Sandbox Runtime profile. That native
boundary limits filesystem and network authority, but it shares the host kernel and same-user
process identity. The roadmap requires a higher-isolation deployment profile before hostile
executable extensions can be considered.

Issue #76 added a pinned OCI runtime, immutable identity, exact policy inspection, durable intent,
crash recovery, bounded diagnostics, and confirmed cleanup. Issue #78 asks whether those guarantees
can serve declared command execution. It must not add workflow-selected runtime authority.

## Specification

_Captured by the specification-capture skill on 2026-08-13. Source: extracted from Issue #78 and
the existing Flow configuration, sandbox-port, OCI, evidence, and recovery contracts._

### Non-goals

- Does not claim VM-grade, kernel-independent, or multi-tenant isolation.
- Does not let workflows or project configuration choose the backend, image, runtime path, mounts,
  privileges, network, or credentials.
- Does not add shell command strings or executable capability packages.
- Does not put provider credentials or inference clients inside the command container.
- Does not add macOS or Windows container execution.

- Does not add a managed control plane, Kubernetes, GPU support, or automatic image updates.
- Does not weaken SRT, policy approval, effect journaling, replay, or cleanup semantics.

### Failure modes

- **Timeouts** — one command deadline includes container preparation, creation, start, execution,
  and process termination. A timeout starts an independent bounded cleanup attempt. Confirmed
  absence is required for side-effect-free settlement. An attempt that exceeds the cleanup bound
  records uncertain side effects. Timeout never becomes success or authorizes an unbounded wait.

- **Partial failures** — Flow retains the primary failure after intent or a container may exist.
  It settles each owned cleanup stage and aggregates terminal cleanup uncertainty. It never deletes
  an object that did not pass exact intent reconciliation.

- **Invalid input** — unknown operator profiles and project-level sandbox selectors reject.
  Malformed runtime evidence and workflow attempts to add sandbox authority also reject. Each
  failure occurs at its existing validation boundary. There is no fallback to a weaker profile.

- **Missing context** — the container profile requires its supported Linux runtime and prepared
  image. It also requires a protected workspace and lifecycle store. Missing context fails before
  workflow work starts. The native profile is the default only when no selector was supplied.

- **Dependency outage** — an unavailable or unresponsive engine fails through fixed, value-free
  stages. Flow does not restart the engine or retry identity/policy failures.

- **Resource exhaustion** — input, output, diagnostic, response, process, memory, CPU, filesystem,
  and cleanup work remain bounded. Limit failure triggers owned settlement and does not spill
  private engine values into public evidence.

### Interface contracts

- Trusted operator configuration gains one closed sandbox-profile selector with `native` as the
  built-in default and `container` as the higher-isolation value. Project configuration and
  workflow source have no corresponding field.

- Effective configuration stores the selected profile in its immutable value and source projection.
  Its policy digest lets detached workers and recovery observe the same operator decision.

- `CommandSandbox.prepare(request)` remains the only application-facing execution boundary. The
  request keeps exact executable, arguments, working directory, protected paths, runtime support,
  environment, and cancellation. It gains no image, engine, mount, privilege, or credential knobs.

- `PreparedCommand` keeps immutable generic evidence, a containment class, and an idempotent
  release contract. It keeps the compatible launch descriptor and may add a provider-neutral
  managed operation. Consumers use the managed form when it is present. Docker control output
  cannot become task evidence. Release resolves only after it proves that the owned container is
  absent.

- `SandboxEvidence` remains the durable provider-neutral identity surface. Backend, exact backend
  version, profile, and policy digest are sufficient for replay.

- The container policy digest covers the complete submitted Docker configuration. It binds the
  attested policy digest, workspace snapshot, filesystem controls, and resource controls. The
  process ceiling uses the container cgroup and omits `RLIMIT_NPROC`. Linux accounts that rlimit
  across unrelated processes with the host operator UID. Those processes can be outside the command
  PID namespace. Public evidence excludes private engine paths, configuration text, and response
  text.

- Offline inspect and export read stored events only. They do not construct or query a sandbox.

## User, operator, and system flows

### Operator selects the container profile

1. The operator selects the higher-isolation profile through trusted local configuration.

2. Flow validates the selection before workflow admission.

3. Flow proves that the fixed engine, image, runtime, policy, and resource controls are current.

4. A workflow command runs through the selected profile without changing workflow syntax.

5. Inspection reports the fixed sandbox identity and settlement evidence.

### Workflow command runs

1. The scheduler admits an already compiled executable and argument vector.

2. The sandbox maps only the admitted workspace into the container and denies task networking.
   A command-only seccomp projection removes socket operations from the admitted Prime profile.
   This denies local TCP and Unix-socket binding inside Docker's isolated loopback namespace.
   The sandbox masks protected children and discovered sensitive entries. It makes existing Git
   metadata read-only without another host bind. A bounded readable-content snapshot excludes
   masked secret content and rejects a broad workspace that contains the project root.

3. Flow re-observes the workspace snapshot and rechecks authority immediately before start.

4. The command runs without a shell and returns bounded stdout, stderr, exit, and sandbox evidence.

5. Flow stops, removes, and proves absence of the container before command success is durable.

### Cancellation, failure, or host restart

1. Cancellation or timeout terminates the command and its containing sandbox.

2. Cleanup settles by an exact reconciled full ID, never by an unverified name.

3. Cleanup failure prevents success and records uncertain side effects.

4. After a host restart, recovery replays durable intent, revalidates identity, and either proves
   absence or settles the exact owned container.

### Offline inspection

1. The operator inspects or exports a stored run.

2. Flow reads durable evidence without contacting or initializing the container engine.

## Approaches considered

| Approach | Simplicity | Isolation | Project/CI fit | Effort | Risk | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| Keep SRT only | Highest | Native OS sandbox | Already proven | None | Leaves the roadmap gap open | Rejected |
| Flow-owned Linux container profile | Medium | Separate filesystem, process, mount, and network namespaces; shared kernel | Reuses pinned OCI identity and Linux x64 gates from #76 | Large | Shared-kernel residual; stacked dependency on #77 | **Selected** |
| Gondolin microVM profile | Medium | Linux microVM with host-mediated VFS and network | Current package requires Node 23.6+ while Flow supports Node 22.19; ARM64 is the strongest-tested path | Large | Runtime/toolchain and Linux x64 gate mismatch | Deferred |
| NVIDIA OpenShell profile | Low locally | Container, Kubernetes, Podman, or MicroVM with gateway policy | Requires a gateway and compute driver; deployment contract is broader than a local command adapter | Very large | Young and rapidly evolving external control plane | Deferred |

Primary sources:

- Gondolin README, SDK, and security model: <https://github.com/earendil-works/gondolin>.

- NVIDIA OpenShell architecture: <https://docs.nvidia.com/openshell/about/how-it-works>.

- Anthropic Sandbox Runtime: <https://github.com/anthropic-experimental/sandbox-runtime>.

- Docker Engine API 1.51: <https://docs.docker.com/reference/api/engine/version/v1.51/>.

- Moby 28.3.3 attach client:
  <https://github.com/moby/moby/blob/v28.3.3/client/container_attach.go>.

- Moby 28.3.3 wait client:
  <https://github.com/moby/moby/blob/v28.3.3/client/container_wait.go>.

## Decision

Implement a fixed Linux container command profile behind Flow's existing `CommandSandbox` port.
Reuse the OCI admission and lifecycle principles proven by Issue #76, but keep command execution,
evidence, and configuration contracts provider-neutral. The existing SRT profile remains the
default. A trusted operator may select the container profile. Workflow source may not select or
parameterize it.

This is an incremental containment milestone. It does not claim VM-grade isolation and does not
authorize executable capability packages. Gondolin and OpenShell remain candidates for a later VM
or managed profile after their runtime requirements align with Flow's supported environments.

## Component responsibilities and dependency direction

- **Domain** owns bounded, immutable sandbox evidence and replay validation. It does not import OCI,
  Docker, SRT, configuration, or filesystem types.

- **Application** owns the backend-neutral command-sandbox request and settlement contract.

- **Configuration** owns the trusted operator selection. Workflow schemas do not receive a sandbox
  selector.

- **Container infrastructure** owns OCI admission, exact intent, creation, start, output transport,
  cancellation, cleanup, and recovery.

- **Composition roots** select SRT or the container adapter and inject one `CommandSandbox`.

- **Offline inspection** consumes stored evidence only and cannot construct the container adapter.

The dependency direction stays `CLI/configuration -> application port <- infrastructure`. The
workflow domain never imports a container implementation.

## Failure modes

| Failure mode | Expected behavior |
| --- | --- |
| Unsupported platform or missing engine | Reject during trusted profile preparation before workflow work starts |
| Invalid operator configuration | Reject with a closed configuration error; do not fall back to SRT |
| Runtime, image, executable, policy, socket, or resource drift | Reject before creation or start; preserve nested private cause only |
| Workspace path, mount, or protected-path mismatch | Reject before the command process starts |
| Container creation response is lost | Reconcile exact intent, fence one exact retry, and retain only a verified full ID for cleanup |
| Container start or output attachment fails | Settle the exact full ID; never report command success |
| Container wait, output decoding, or attachment release fails | Publish only the fixed control stage; keep Docker text out of task evidence and settle the exact full ID |
| Timeout or cancellation | Preserve exact cancellation, terminate the command and container, and prove absence |
| Cleanup partially fails | Retry only the bounded settlement policy; report uncertain side effects if absence is not proved |
| Host restarts after intent publication | Recover from durable intent without trusting a name-only match |
| Output, diagnostic, or event limit is exceeded | Fail with a fixed bounded error and continue owned cleanup |
| Memory or process pressure | Enforce fixed container limits and fail closed if their effective inspection differs |
| Offline inspect/export | Read stored evidence and perform no engine calls |

## Non-goals

- Does not claim VM-grade, kernel-independent, or multi-tenant isolation.
- Does not let workflows choose the backend, image, runtime path, mounts, privileges, network, or
  credentials.
- Does not add shell command strings or executable capability packages.
- Does not put provider credentials or inference clients inside the command container.
- Does not add macOS or Windows container execution.

- Does not add a managed control plane, Kubernetes, GPU support, or automatic image updates.
- Does not weaken SRT, policy approval, effect journaling, replay, or cleanup semantics.

## Consequences

- Issue #77 has landed. Issue #78 must retarget its stack to that `main` revision before merge.

- Linux runtime verification becomes mandatory for the new profile. Local macOS tests use injected
  boundaries and cannot substitute for the native containment gate.

- Configuration and evidence must remain versioned and backward compatible. Recovery and offline
  inspection outlive the process that selected the backend.

- The container profile adds setup and image-management cost. SRT remains the lightweight default.

## Durable command-container ownership

Command-container recovery uses a private infrastructure lease store. Flow writes and synchronizes
one intent record before Docker create. The record contains the generated owner nonce, container
name, exact submitted policy projection, admitted runtime identity, and the Linux process owner.
Flow updates the record with the inspected full container ID before it returns a launcher. It
removes the record only after it proves container absence.

The process owner contains the Linux boot ID, process ID, and process start identity. A recovery
scan skips a record while that exact process is alive. It treats a different boot ID, absent process,
or different process start identity as an orphan. A recovering process must atomically claim the
orphan record before it inspects or removes a container. This prevents workers from settling each
other's active containers. It also prevents process ID reuse from impersonating a lease owner.

Concurrent prepares share only an active recovery scan. Each later prepare starts a fresh scan
after that scan settles. A process that dies after an earlier prepare cannot leave an unobserved
durable orphan.

The live engine separately owns every failed local settlement. It registers that owner before the
first cleanup attempt for both preparation failures and returned leases. A later prepare settles
all such owners before it resolves another descriptor or creates a container. This closes the case
where durable orphan recovery correctly skips the same still-live process. Settlement resumes from
the last proved phase and removes no name-only object.

## Structured container command execution

The container profile does not run `docker start --attach` as a child process. It uses the pinned
Docker API 1.51 sequence directly:

1. Attach to standard output and standard error with stdin and logs disabled.
2. Start the verified full container ID.
3. Wait for `condition=not-running` under the command deadline signal.
4. Decode the non-TTY multiplex frames into separate bounded task streams.
5. Release the attachment and settle the full-ID container.

The ordinary 10-second Docker query timer bounds setup and inspection calls. It does not bound the
long-running wait. The command deadline remains the one total execution limit. Attach, start, wait,
stream, and attachment-release errors use closed value-free stages. Only a validated wait status in
the range 0 through 255 becomes the task exit code.

Attach failure occurs before start and has no command side effects. Later control failure retains
bounded task evidence and reports uncertain side effects. Confirmed absence proves termination. It
does not reverse earlier workspace mutation.

The store uses owner-only real directories and files. It synchronizes record content before atomic
publication and synchronizes the containing directory after publication, replacement, claim, and
removal. Recovery never removes by name. It promotes a name lookup to cleanup authority only after
the complete inspected Docker policy matches the durable intent and yields one valid full ID.

Alternatives were rejected as follows:

- Reusing the Prime evaluation lease would couple ordinary command execution to trial-only identity
  and adapter state.

- Deriving every lease path from workflow and agent-command journals would give strong ownership.
  It would require a broad protocol change before the container boundary can be safe.

- A single global command-container slot would simplify recovery. It would also serialize
  independent workflow commands and workers.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Operator-only selection | Configuration/security | `npx vitest run test/unit/config/resolver.test.ts -t "sandbox profile"` | Operator accepts `container`; unknown values and every project selector reject | Container availability |
| Native default compatibility | Contract/configuration | `npx vitest run test/unit/config/resolver.test.ts test/unit/infrastructure/runtime/production-node-executor.test.ts` | Omission resolves to native; existing SRT composition is unchanged | Native sandbox becomes VM-grade |
| Exact executable, argv, and cwd | Behavioral | `npx vitest run test/unit/infrastructure/oci/local-container-command-sandbox.test.ts` | Each value reaches the container process unchanged and shell syntax stays inert | Interactive or shell command strings |
| Workspace and protected-state containment | Runtime/security | `npx vitest run test/unit/infrastructure/oci/local-container-command-sandbox.test.ts test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts`<br>`npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-sandbox.runtime.test.ts` | Admitted workspace mutation succeeds; sensitive entries and Flow state are masked; Git reads succeed but writes fail; peer workspaces, verifier data, and credentials deny | Atomic host snapshot or host-kernel isolation |
| Network denial | Runtime/security | `npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-sandbox.runtime.test.ts -t "network"` | Internet, host loopback, undeclared host Unix-socket, local TCP bind, and local Unix-socket bind attempts fail | Managed egress allowlists |
| Durable complete identity | Domain/contract | `npx vitest run test/unit/infrastructure/runtime/production-container-command-sandbox.test.ts test/unit/infrastructure/oci/container-command-workspace-snapshot.test.ts test/unit/infrastructure/oci/container-command-intent.test.ts test/unit/infrastructure/oci/local-container-command-sandbox.test.ts test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts test/unit/run/reducer.test.ts` | Frozen evidence binds the attested runtime identity, bounded workspace snapshot, and exact submitted command configuration, then round-trips through replay | Private engine values in evidence |
| Adjacent drift rejection | Error/security | `npx vitest run test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts test/unit/infrastructure/process/local-external-harness-runtime.test.ts -t "immediately before"` | Command and external-harness consumers invoke prepared sandbox authority before process start; the container hook rechecks workspace, runtime, and Docker policy | Automatic engine restart or retry |
| Existing command outcome compatibility | Integration | `npx vitest run test/unit/infrastructure/oci/docker-command-api.test.ts test/unit/infrastructure/process/command-node-executor.test.ts test/integration/process/command-node-executor.test.ts` | Success, nonzero exit, bounded task streams, fixed Docker control failures, timeout, cancellation, inspection, and replay shapes stay compatible | New workflow output semantics |
| Timeout/cancellation settlement | Behavioral/runtime | `npx vitest run test/unit/infrastructure/oci/docker-command-api.test.ts test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts test/unit/infrastructure/process/command-node-executor.test.ts test/unit/run/agent-command-reducer.test.ts`<br>`npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-sandbox.runtime.test.ts` | Exact cancellation owns the Docker wait; descendants terminate; confirmed absence permits clean settlement, while bounded unresolved preparation records uncertainty | Unbounded cleanup waits |
| Crash recovery and foreign-object safety | Recovery/runtime | `npx vitest run test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts test/unit/infrastructure/oci/local-container-command-intent-store.test.ts`<br>`npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-recovery.runtime.test.ts` | Later scans, lost responses, and restarts reconcile owned full IDs; foreign or unverifiable objects remain untouched | Name-only deletion |
| Cleanup uncertainty | Error/recovery | `npx vitest run test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts test/unit/infrastructure/process/command-node-executor.test.ts` | Primary and terminal cleanup errors remain ordered; preparation and lease failures retain same-process settlement; success and later create are impossible without confirmed absence | Infinite cleanup retries |
| Fixed resource controls | Runtime/security | `npx vitest run test/unit/infrastructure/oci/local-docker-container-command-engine.test.ts`<br>`npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-sandbox.runtime.test.ts` | Submitted and inspected CPU, memory, cgroup process, filesystem, and output limits match exactly; no host-global `nproc` rlimit is present | GPU or operator-tunable limits |
| Offline inspection | Integration | `npx vitest run test/integration/cli/evaluation-offline-loading.test.ts test/integration/cli/evaluation-offline-prime.test.ts` | Stored evaluation evidence inspects and exports without production OCI or external runtime packages | Live currentness proof while offline |
| Public contract | Docs/scaffold | `npm run docs:ste && npx vitest run test/scaffold/community-files.test.ts` | README, security, architecture, workflow, testing, and roadmap prose match authority and nonclaims | VM-grade claim |
| Real Linux x64 boundary | Runtime | `npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-sandbox.runtime.test.ts test/runtime/container-command-recovery.runtime.test.ts` | Credential-free real engine success, denial, cancellation, cleanup, recovery, and drift pass | macOS or Windows containers |
| Complete regression | Release | `npm run check && npm run test:runtime && npm run test:coverage && npm run pack:check && npm audit --omit=dev --audit-level=low` | Static, behavioral, runtime, packaging, docs, and production dependency gates all pass | Hosted infrastructure availability or optional development-tool reachability |
| Holdout and evidence completeness | Adversarial | `git diff --check && npm run docs:ste` plus independent finding-ledger review | Zero current P1/P2/P3 findings and one evidence bundle row per criterion | Proof beyond explicitly listed environments and cases |

## Planned RED → GREEN → REFACTOR sequence

1. **Configuration authority** — add failing operator/project/default/digest tests, then introduce the
   closed profile in effective configuration and composition.

2. **Container contract** — add failing policy, identity, argv, working-directory, and diagnostic
   tests. Then implement the backend-neutral adapter around the admitted OCI boundary.

3. **Lifecycle and recovery** — add RED cases for create, start, cancellation, cleanup, crash, and
   foreign objects. Then wire durable intent and bounded settlement.

4. **Real containment** — add credential-free Linux RED gates for workspace, protected state,
   network, descendants, resources, and currentness before enabling production selection.

5. **Offline and public contract** — prove that stored inspection does not load the engine. Update
   STE documentation and run the complete release and holdout gates.

## Current verification evidence

- The mapped repair selector passes seven files and 449 tests. It proves structured Docker
  execution, fixed public stages, private-cause retention, task-output separation, exact
  cancellation, and same-process cleanup ownership. Existing command outcomes remain compatible.

- The complete portable suite passes 215 files and 2,893 tests. One platform-gated file and four
  tests skip. The same suite first failed only where the desktop sandbox denied temporary Unix
  sockets. The identical unrestricted run passed, which separates that host restriction from the
  product result.

- The runtime configuration passes 8 files and 39 tests. Nine files and 33 tests skip on this
  Darwin host. The five container-command runtime tests are among the Linux-only skips.

- Coverage passes with 82.37% statements, 76.15% branches, 88.92% functions, and 82.49% lines.

- Repository formatting, lint, type checking, the production build, changed-document STE, compiled
  smoke, and `git diff --check` pass. The restricted desktop smoke attempt exhausted its deadline
  inside nested sandbox preparation. The identical host-capable command passed.

- The clean package verifier builds, packs, installs, and runs the CLI from
  `synaptiai-flow-harness-0.0.0.tgz`. The installed effective policy digest is
  `5dfe0fbdfa1a86627e8762bfc071594c1bccbd6a467fc3f3ea12ebddf9b053b4`.

- The production dependency audit reports zero vulnerabilities.

- The refreshed repository graph contains 8,192 nodes, 18,795 edges, and 343 communities.

- Hosted Linux x64 exposed exit 255. A controlled reproduction used the pinned Node image and fixed
  command profile. The command succeeded alone.
  It then returned exit 255 while an unrelated container held over 64 same-UID processes and
  reported `resource temporarily unavailable`. This proves that `RLIMIT_NPROC=64`
  counted processes outside the command PID namespace. The command profile now uses its inspected
  cgroup `PidsLimit=64` and omits the host-global rlimit.

- Hosted CI run [31698882778](https://github.com/synaptiai/flow-harness/actions/runs/31698882778)
  passed the earlier acceptance baseline on pinned Linux x64. Its runtime tests proved real command
  success, denial, resource controls, timeout, cancellation, cleanup, recovery, and drift. The
  production dependency audit also passed. The current structured-execution repair requires a new
  hosted run after push.

Darwin cannot prove the current Linux x64 Docker criteria, so local runtime files remain skipped
there. The earlier hosted result is a baseline, not proof of the current repair. The new hosted run
must supply that evidence. It does not promise macOS or Windows container support, VM-grade
isolation, or managed-runtime behavior.
