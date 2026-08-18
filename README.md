# Flow

Flow is a provider-neutral coding-agent harness with deterministic workflow graphs, durable
evidence, and fail-closed sandboxed command execution.

> **Pre-alpha source preview:** Flow is under active development, its contracts may change, and
> `@synaptiai/flow-harness` is not published to npm. Build and run it from a reviewed source
> checkout. Do not use it as a security boundary for hostile or multi-tenant workloads.

Flow is a standalone product. It does not depend on Claude Code. It does not preserve
compatibility with the earlier Flow plugin. Pi supplies the default model-facing agent loop.
Flow owns scheduling, policy, containment, evidence, and completion. Flow can also evaluate OMP
through an optional external profile.

## What works today

| Capability | Status |
| --- | --- |
| Strict workflow and goal compilation | Implemented |
| Deterministic dependency-ordered execution with bounded static DAG forks | Implemented; omitted concurrency remains sequential |
| Durable exact-output conditions, guarded branches, omission propagation, and explicit joins | Implemented with bounded selected-branch concurrency |
| Replay-safe bounded loops over local command/agent/verifier DAGs | Implemented through finite acyclic expansion, exact stop evidence, and hard failure at the declared bound |
| Typed result publication from durable evidence | Implemented with strict bounded JSON, closed schemas, canonical values, hashes, and replay verification |
| Isolated child workflow runs with typed results | Implemented with deterministic child identities, separate ledgers, bounded run trees, private project-sibling workspaces, legacy relocation before recovery, cancellation, and parent resource accounting |
| Bounded accept-best optimization loops | Implemented with typed numeric metrics and invariants, finite candidate expansion, isolated candidate deltas, stale-parent refusal, write-ahead promotion/rollback, stagnation, and typed restart reconciliation |
| Durable JSONL run ledger and inspection | Implemented |
| Safe-boundary recovery with exclusive local ownership | Implemented |
| Durable exact command approval with approve/deny CLI | Implemented |
| Durable per-call agent `exec` approval with approve/deny CLI | Implemented for attached and detached live Pi sessions through exact, expiring, single-use grants |
| Durable evidence-bound graph approval nodes with approve/deny CLI | Implemented |
| Durable provider-neutral resource accounting and run budgets | Implemented for starts, model tokens, reported cost, active execution time, and retained executor-output artifacts |
| Strict project/operator configuration with inspectable monotonic limits | Implemented |
| Bounded detached supervisor, durable FIFO queue, authenticated workers, cancellation, and event replay | Implemented on Linux and macOS |
| First-class typed verifier nodes | Implemented for sandboxed command and evidence-isolated zero-tool Pi model drivers |
| Bounded Pi agent nodes with Flow-owned `read`, `ls`, hash-anchored `edit`, and sandboxed argv-only `exec` tools | Implemented; `exec` currently requires Linux PID-namespace containment |
| Portable Agent Skills packages with progressive disclosure | Implemented for strict local or exact installed packages, including publisher-authenticated OCI sources, explicit workflow selection, immutable run snapshots, and digest-bound read evidence |
| Versioned verifier packages | Implemented for strict local or exact installed command/model manifests, including publisher-authenticated OCI sources, exact workflow selection, immutable run snapshots, and digest-bound verdict evidence |
| Versioned command tool packages | Implemented for strict local or exact installed declarative manifests, including publisher-authenticated OCI sources, exact per-agent selection, deterministic argv rendering, and the existing policy/approval/sandbox/journal boundary |
| Versioned workflow packages | Implemented for strict local or exact installed inert source manifests, including publisher-authenticated OCI sources, exact packaged roots and children, closed snapshot-only compilation, and durable replay identity |
| Versioned policy packages | Implemented for strict local or exact installed inert narrowing manifests, including operator-required and project-additional exact selection, deterministic composition, pre-mutation workflow admission, and durable replay identity |
| Remote capability bundle distribution and update discovery | Implemented with deterministic inert `.flowpkg` files, explicit public HTTPS plus SHA-256 installation, exact publisher-authenticated OCI installation, opt-in signed freshness/revocation metadata, and standards-based TUF repository checks with explicit local root trust, delegated targets, consistent snapshots, inert review candidates, reviewed offline activation or atomic same-surface replacement, and frozen execution/recovery |
| Reproducible harness evaluation | Implemented for paired Flow, native Pi, native OMP, and Prime Agent profiles. Flow records exact identities, fresh workspaces, private checks, evidence, and constrained reports. |
| Evidence-bound prompt candidates | Flow implements zero-tool model generation from tuning-only evidence, strict prompt overlays, paired evaluation, reviewed activation, durable run snapshots, and rollback |
| Proof-safe fresh recovery of interrupted agent attempts | Implemented as explicit opt-in for read-only attempts and edit attempts proven not applied |
| Fail-closed sandboxed command isolation | Flow implements filesystem and network isolation on Linux and macOS. Linux alone provides strict agent-command descendant lifecycle containment |
| Higher-isolation container command profile | Implemented behind operator-only selection; the pinned Linux x64 engine runtime gate passes |
| Inert A2UI-profile presentation packages | Implemented for exact local or installed manifests that arrange a closed host-owned terminal or browser widget catalog without supplying data, actions, code, or bindings |
| Local browser presentation host | Implemented as a one-session IPv4 loopback host with a fragment-bootstrapped capability, fixed first-party assets, authenticated full-document streaming, and current-action steering |
| Local ACP v1 editor bridge | Implemented over strict bounded stdio with durable session discovery, restart replay, public-safe updates, and exact Flow approval and cancellation controls |
| Automatic package activation, executable or remote UI extensions, and model network tools | Planned |
| VM-grade isolation of the host-side agent runtime | Planned |

The executable format is `flow.synapti.ai/v1alpha1`. There is no compatibility or migration
promise before the first stable release.

## Run the source preview

### Prerequisites

- Git
- Node.js 26.7 or newer
- npm with lockfile support
- Linux or macOS

The native OMP evaluation profile has additional requirements:

- Linux with the verified SRT PID namespace.
- The official Bun 1.3.14 standard Linux executable for x64 or arm64.
- `@oh-my-pi/pi-coding-agent` 17.2.12.
- `@oh-my-pi/pi-ai` 17.2.12.

Normal Flow runs and offline evaluation inspection do not load these optional OMP packages.
Flow verifies the complete Bun executable against its built-in release attestations. You can use
`FLOW_BUN_EXECUTABLE` to select another host path. The selected file must still match an attested
official release.

The Prime Agent evaluation profile has additional requirements:

- Linux x64 with Docker Engine and cgroup v2.
- Docker API 1.51 with the systemd cgroup driver.
- A local Docker socket at `/var/run/docker.sock`.
- Docker uses that exact Unix endpoint without socket activation.
- A non-piped host core pattern.
- IPv6 loopback support in the private container network namespace.

The Prime runtime identity has these additional requirements:

- Docker uses its canonical daemon PID record.
- The `flow-prime-runc` runtime uses one canonical `runc` executable path and no arguments.
- Docker supervises its own `containerd` child.
- Docker publishes its managed `containerd` PID record under `/run/docker/containerd`.
- Docker image storage resolves through sysfs to one whole block device for `io.max`.
- Enough host capacity for the fixed Prime resource policy.

Configure the Docker daemon with the dedicated `flow-prime-runc` runtime name and the verified
`runc` path. Docker reserves its built-in `runc` name. The Linux x64 acceptance profile uses
`/usr/bin/runc` from the exact `containerd.io` 1.7.27-1 package. It verifies `runc` 1.2.5 commit
`v1.2.5-0-g59923ef` and does not resolve `runc` through `PATH`. A different path, version, or commit
is outside the verified version one profile.

```json
{
  "default-runtime": "flow-prime-runc",
  "runtimes": {
    "flow-prime-runc": {
      "path": "/usr/bin/runc",
      "runtimeArgs": []
    }
  }
}
```

The default daemon configuration must not set `containerd`, `containerd-namespace`,
`containerd-plugins-namespace`, `hosts`, `exec-root`, or `pidfile`. Flow rejects custom
configuration-file paths and related command options.

Use this profile only on a dedicated, reprovisionable Prime runner. Do not use this setup on a
shared development host or on a host that serves Kubernetes or other `containerd` clients. The
commands below stop the separate service and replace the Docker service start command.

For systemd, disable Docker socket activation and the separate `containerd` service. Remove its
stale socket before Docker starts. Docker then starts the managed child that Flow admits.

```sh
sudo systemctl stop docker.service docker.socket containerd.service
sudo systemctl disable docker.socket
sudo systemctl mask containerd.service
sudo rm --force -- /run/containerd/containerd.sock
sudo sysctl --write kernel.core_pattern=core
sudo install --directory /etc/systemd/system/docker.service.d
printf '[Unit]\nRequires=\n[Service]\nExecStart=\nExecStart=/usr/bin/dockerd --host=unix:///var/run/docker.sock\n' | sudo tee /etc/systemd/system/docker.service.d/flow-prime.conf
sudo systemctl daemon-reload
sudo systemctl start docker.service
sudo chmod 0711 /run/docker /run/docker/containerd
```

To roll back this setup, recreate the runner from its trusted base image. Version one does not
support in-place restoration because Flow does not record the prior Docker and systemd states.

Verify that Docker owns the managed containerd process:

```sh
docker_pid="$(cat /run/docker.pid)"
containerd_pid="$(cat /run/docker/containerd/containerd.pid)"
test "$(ps --no-headers --pid "$containerd_pid" --format ppid | xargs)" = "$docker_pid"
```

Publish the protected runtime observation that non-root Flow uses. The file binds the two live
processes to their canonical executable paths and hashes.

```sh
containerd_executable="$(sudo readlink --canonicalize "/proc/${containerd_pid}/exe")"
dockerd_executable="$(sudo readlink --canonicalize "/proc/${docker_pid}/exe")"
containerd_sha256="$(sudo sha256sum "/proc/${containerd_pid}/exe" | cut --delimiter=' ' --fields=1)"
dockerd_sha256="$(sudo sha256sum "/proc/${docker_pid}/exe" | cut --delimiter=' ' --fields=1)"
jq --null-input \
  --argjson dockerPid "$docker_pid" \
  --argjson containerdPid "$containerd_pid" \
  --arg dockerdPath "$dockerd_executable" \
  --arg dockerdSha256 "$dockerd_sha256" \
  --arg containerdPath "$containerd_executable" \
  --arg containerdSha256 "$containerd_sha256" \
  '{version:1,dockerPid:$dockerPid,containerdPid:$containerdPid,dockerd:{path:$dockerdPath,sha256:$dockerdSha256},containerd:{path:$containerdPath,sha256:$containerdSha256}}' \
  > /tmp/flow-prime-runtime-v1.json
sudo install --owner=root --group=root --mode=0444 \
  /tmp/flow-prime-runtime-v1.json /run/flow-prime-runtime-v1.json
```

Prepare the fixed image and local runtime evidence before plan validation:

```sh
node dist/cli/main.js runtime prepare prime-agent
```

Preparation builds the image twice and compares both identities. It stores local host evidence
under the configured project `.flow` directory. A fixed-stage preflight rejects an incompatible
host before build one. Preparation repeats the authoritative inspection after build two. Evaluation
does not build or pull an image.

### Select the container command profile

The native command profile is the built-in default. A trusted operator can select the
higher-isolation container profile after Prime runtime preparation. Add this field to the operator
file in `${XDG_CONFIG_HOME}/flow/config.yaml`, or `${HOME}/.config/flow/config.yaml` when
`XDG_CONFIG_HOME` is absent:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowOperatorConfig
sandbox:
  profile: container
```

Do not add this field to `.flow/config.yaml`. Project configuration cannot select or widen sandbox
authority. Run `flow config show` after the change. The effective policy digest changes when the
profile changes. An active supervisor must reach idle and shut down before it can bind the new
digest.

The `flow-container-v1` profile starts one Docker container per command. It uses the prepared Prime
image, Docker API 1.51, the `flow-prime-runc` runtime, and the current non-root host user identity.
Flow preserves the exact executable and argument vector without a shell. The selected workspace is
the only read-write bind. Explicit runtime support paths are read-only binds.

Flow attaches to the container output before start, starts the verified full container ID, and
waits through Docker API 1.51. The one command deadline owns the wait. Flow decodes Docker's
multiplexed stream and records only bounded task standard output and standard error. Docker attach,
start, wait, stream, and attachment-release failures use fixed public stages. Docker control text
does not become task output or an exit code.

A control failure after possible start retains bounded task output and reports uncertain command
side effects. Confirmed container absence does not undo earlier workspace writes.

Nested protected paths are masked inside the workspace. Flow always protects project `.flow`
state from the trusted project root. A protected path at or above the workspace rejects before
Docker mutation. A workspace that would contain the configured project root also rejects. A
runtime support bind that overlaps protected state also rejects.

Before preparation, bounded and cancellation-aware discovery finds existing sensitive workspace
entries. Flow masks environment files, private-key files, project `.flow` state, and private Flow
workspace collections. Existing Git metadata stays readable through the workspace bind, but an
explicit inspected read-only path prevents container writes. A linked or special `.git` entry is
masked instead. This discovery is not an atomic host filesystem snapshot and does not defend
against concurrent changes by the trusted host user or root.

Flow records a bounded workspace content snapshot before Docker creation. The snapshot accepts at
most 100,000 entries and 10 GiB of regular-file content. It binds readable file bytes and modes,
directories, symlink targets, and masked-path exclusion identities. It does not hash masked secret
content. Flow re-observes the same snapshot immediately before launch and rejects drift.

The root filesystem is read-only. Task networking and IPC are disabled. Flow drops all
capabilities. A command-only seccomp projection denies socket creation and socket-specific
syscalls. The command inherits no network socket. It cannot bind local TCP or Unix sockets inside
the isolated loopback namespace.

Fixed cgroup process, memory, CPU, file, descriptor, temporary-storage, and core limits also apply.
The process ceiling uses the container cgroup. Flow does not set `RLIMIT_NPROC` for command
containers because Linux accounts that limit across every process with the host operator UID,
including processes outside the container.

Flow writes an owner-only record below `.flow/container-command-intents` before Docker create. It
adds the inspected full container ID before command launch. Completion, timeout, cancellation, and
restart recovery remove only the verified full-ID container and require confirmed absence before
Flow removes the record. An unresolved or foreign container blocks later container commands. Flow
does not delete a container by name alone.

The live process also owns a retryable settlement for each failed preparation or returned lease.
It settles that work before another create. Durable orphan recovery correctly skips the still-live
process owner.

The complete submitted Docker configuration determines the public sandbox policy digest. This
digest binds the attested engine, image, runtime, executable, and fixed profile through the static
policy label. It also binds the workspace snapshot digest, exact process, workspace bind, masks,
read-only paths, environment, and resource controls. Public evidence contains the digest, not the
private Docker configuration or host paths.

This profile adds separate filesystem, mount, PID, IPC, cgroup, and network namespaces. The
container profile still uses the shared Linux kernel and Docker daemon. It is not a VM-grade or
multi-tenant boundary. Use a microVM or managed sandbox when the workload is hostile to the host
kernel or Docker daemon.

On Ubuntu or Debian, install the native sandbox dependencies:

```sh
sudo apt-get update
sudo apt-get install --yes bubblewrap socat ripgrep
```

Linux also requires unprivileged user namespaces, network namespaces, and seccomp support. macOS
uses the built-in Seatbelt facility for filesystem/network isolation and process groups for command
node cleanup. `flow_exec` fails before process creation on macOS because Seatbelt does not provide a
PID namespace or equivalent lifecycle boundary. Windows command nodes fail before process creation.

Ubuntu 24.04 and newer restrict capability-bearing unprivileged user namespaces by default. On a
dedicated development or ephemeral CI host, enable the capability required by SRT for the current
boot:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

This changes host-wide user-namespace hardening. On a shared host, keep the restriction and use a
reviewed AppArmor profile that grants `userns` only to the required sandbox binaries instead. See
SRT's [platform-specific dependency guidance](https://github.com/anthropic-experimental/sandbox-runtime#platform-specific-dependencies).

### Build and verify

```sh
git clone https://github.com/synaptiai/flow-harness.git
cd flow-harness
npm ci --ignore-scripts
sudo useradd --create-home --groups docker flow-prime-peer
export FLOW_PRIME_TEST_SECOND_USER=flow-prime-peer
npm run ci:local
```

`npm ci --ignore-scripts` installs only the exact lockfile. Use `npm install` only when
intentionally changing dependencies.

The release gate builds and verifies the Prime image before it runs native tests. It also requires
the named second user to prove daemon-wide admission across Docker-authorized users.

### Execute the example

Initialize the checkout as a Flow project and inspect the effective operator/project policy:

```sh
node dist/cli/main.js init .
node dist/cli/main.js config show
```

The project file is `.flow/config.yaml`. Flow discovers the nearest project from subdirectories and
uses it as the default run-store root. See [Configuration](docs/configuration.md) for capacity
limits, operator ceilings, and policy-change behavior.

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

### Compare harness profiles

The `flow eval validate` command admits a plan without model credentials or filesystem mutation. In
the source preview, run it through the built entry point:

```sh
node dist/cli/main.js eval validate examples/evaluation/harness-comparison.evaluation.yaml
```

Running it uses the declared provider credentials, copies the fixture into a fresh workspace for
each paired trial, keeps the deterministic verifier private from both profiles, and stores evidence
below `.flow/evaluations/harness-comparison/`:

```sh
node dist/cli/main.js eval run examples/evaluation/harness-comparison.evaluation.yaml
node dist/cli/main.js eval inspect harness-comparison
node dist/cli/main.js eval export harness-comparison --output harness-comparison.json
```

The baseline and candidate must use the same provider, model, thinking level, budgets, network
policy, zero-retry policy, fixtures, verifier identity, and seeds. Missing trials remain in the
denominator and unavailable telemetry remains unavailable rather than becoming zero. See
[Reproducible harness evaluation](docs/evaluation.md) for the plan contract, trust boundary,
resume behavior, metrics, and comparison rules.

The native Pi example compares one Flow workflow with the built-in Pi runtime:

```sh
node dist/cli/main.js eval validate examples/evaluation/native-pi-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-pi-comparison.evaluation.yaml
node dist/cli/main.js eval inspect native-pi-comparison
```

The native Pi driver runs in a separate SRT process on Linux. Flow requires the verified PID
namespace. Flow keeps provider credentials in the host
broker. Pi can use only workspace-confined `read` and `edit` tools in this profile.

The native OMP example compares the native Pi and native OMP agent loops:

```sh
node dist/cli/main.js eval validate examples/evaluation/native-omp-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-omp-comparison.evaluation.yaml
node dist/cli/main.js eval inspect native-omp-comparison
```

Flow starts OMP in a separate Bun process under the same Linux SRT boundary. The child has no
provider credentials or task network. OMP can use only workspace-confined `read` and `edit` tools.
This example does not claim that either harness is better.

The Prime Agent example compares one Flow workflow with the fixed persistent IPython profile:

```sh
node dist/cli/main.js eval validate examples/evaluation/native-prime-agent-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-prime-agent-comparison.evaluation.yaml
node dist/cli/main.js eval inspect native-prime-agent-comparison
```

Prime Agent runs in one fixed OCI image on Linux x64. Python has no provider credential or external
network route. The host broker makes each model request. Flow removes the container before it
accepts a terminal result.

### Evaluate an adaptive prompt candidate

After a complete evaluation containing at least one `tuning` task, export the bounded refiner input:

```sh
node dist/cli/main.js eval tuning-evidence harness-comparison \
  --output tuning-evidence.json
```

The canonical packet contains only tuning task ids, terminal classifications, bounded harness and
verification outcomes, available metrics, profile workflow identities, and source-ledger identity.
Harness reasons retain at most 512 UTF-8 bytes and carry an explicit `reasonTruncated` flag.
Packet admission also requires Flow-scheduler-compatible one-to-one seed/repetition mappings,
contiguous repetitions, complete profile pairs, and a feasible declared total task count.
Regression and holdout task ids, records, outcomes, metrics, reasons, verifier material, run ids,
and schedule positions are omitted completely.

Flow can use the exact baseline and evidence packet to generate one prompt candidate:

```sh
node dist/cli/main.js candidate generate baseline.workflow.yaml tuning-evidence.json \
  --output better.prompt-candidate.yaml \
  --id clearer-implementation-prompt --version 1.0.0 \
  --allow-nodes implement --provider provider-name --model model-name \
  --thinking medium
```

The command sends only the selected root-agent prompts and tuning packets to one model turn. The
model gets no tools, skills, packages, or workspace access. Flow checks the sources again after the
model call. Flow then validates the candidate and publishes one new file. The command does not
replace an existing file. It does not run an evaluation or activate the candidate.

The generated candidate records the provider, model, thinking level, limits, request digest,
response digest, selected targets, and reported usage. These values support an audit. They do not
prove that the candidate is better.

A `PromptCandidate` manifest binds an exact baseline workflow, one through sixteen exact evidence
packets, and one through sixteen prompt replacements on existing root agent nodes:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: PromptCandidate
metadata: { id: clearer-implementation-prompt, version: 1.0.0 }
scope: { kind: workflow, workflowId: evaluated-profile }
baseline:
  workflow: baseline.workflow.yaml
  sourceSha256: <64-lowercase-hex>
  workflowDigest: <64-lowercase-hex>
evidence:
  - path: tuning-evidence.json
    sourceSha256: <64-lowercase-hex>
    evidenceDigest: <64-lowercase-hex>
    planDigest: <64-lowercase-hex>
changes:
  prompts:
    - nodeId: implement
      expectedSha256: <64-lowercase-hex>
      value: Read TASK.md, implement it carefully, and verify the result.
```

Validation is credential-free, changes no source file, and prints hashes and target node ids rather
than prompt bodies:

```sh
node dist/cli/main.js candidate validate better.prompt-candidate.yaml
```

To evaluate the projection, select it in the candidate profile while keeping
`adapter: flow-workflow-v1`. The candidate's exact embedded baseline must match the declared
comparison baseline profile:

```yaml
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
  - { id: candidate, adapter: flow-workflow-v1, candidate: better.prompt-candidate.yaml }
```

Flow verifies stable no-follow reads and each declared digest. It also verifies the current prompt
hash and baseline evidence coverage. Flow changes only the declared prompt fields. It then uses the
standard compiler and evaluation adapter.

An `AgentSkillCandidate` uses the same `candidate validate` and paired evaluation commands, but it
projects one exact selected Agent Skill package instead of changing the workflow:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: AgentSkillCandidate
metadata: { id: better-review, version: 1.0.0 }
scope:
  kind: workflow-agent-skill
  workflowId: evaluated-profile
  skillName: review
baseline:
  workflow:
    path: baseline.workflow.yaml
    sourceSha256: <64-lowercase-hex>
    workflowDigest: <64-lowercase-hex>
  skill:
    path: .flow/skills/review
    packageDigest: <64-lowercase-hex>
evidence:
  - path: tuning-evidence.json
    sourceSha256: <64-lowercase-hex>
    evidenceDigest: <64-lowercase-hex>
    planDigest: <64-lowercase-hex>
changes:
  resources:
    - path: reference.md
      expectedSha256: <64-lowercase-hex>
      value: Review correctness, security, and evidence.
```

Flow can generate that resource-only candidate from an exact selected skill and resource allowlist:

```sh
node dist/cli/main.js candidate generate baseline.workflow.yaml tuning-evidence.json \
  --output better-review.agent-skill-candidate.yaml \
  --id better-review --version 1.0.0 \
  --skill review --allow-resources reference.md \
  --provider provider-name --model model-name --thinking medium
```

The model sees the exact workflow identity, public package identity, tuning-only evidence, and only
the selected current UTF-8 resource bytes. It gets no tools, skills, packages, workspace access, or
unselected package files. The allowlist cannot contain `SKILL.md` or a file below the top-level
`scripts/` directory. It returns replacements only for the allowlist. Flow then validates the
ordinary Agent Skill candidate and publishes one new file without replacement.

The workflow must select exactly that one skill. Flow admits the workflow, baseline package, and
tuning evidence in one stable transaction. The baseline profile receives the original immutable
skill snapshot. The candidate profile receives a projected snapshot with only the declared existing
UTF-8 resources replaced. Both profiles use the same compiled workflow, controls, tasks, and
verifier. Package metadata, requested tools, trust, provenance, and file set cannot change.

The public candidate identity contains hashes and portable provenance, not resource contents or
absolute paths. Inspection remains available after the live candidate and skill files are removed.
Generation does not change `SKILL.md`, change a `scripts/` file, add files, evaluate, activate,
install, or publish a package. A favorable evaluation grants no package or execution authority until
an operator applies its exact reviewed activation proposal. Agent Skill package installation and
publication remain separate.

Flow can also synthesize one new inert Agent Skill package for a baseline workflow that selects no
skills. The operator supplies a strict, content-free blueprint that fixes the package authority,
one root agent target, and every output path:

```sh
node dist/cli/main.js candidate generate baseline.workflow.yaml tuning-evidence.json \
  --output generated-review-helper \
  --id generated-review-helper --version 1.0.0 \
  --blueprint review-helper.blueprint.json \
  --provider provider-name --model model-name --thinking medium
```

The command publishes a new review directory without replacing an existing path:

```text
generated-review-helper/
├── CANDIDATE.json
└── skill/
    └── review-helper/
        ├── SKILL.md
        ├── references/...
        └── assets/...
```

The blueprint declares 1–16 exact portable paths. `SKILL.md` is required. Optional files are inert
UTF-8 references or textual assets. Scripts, executable files, binary content, links, special files,
and model-selected paths reject.

The model receives tuning-only evidence and returns file contents
for the declared path set in one zero-tool turn. Flow renders package authority from the blueprint.
The model cannot choose the skill name, description, tools, target, evidence, provider, model, or
limits.

The baseline workflow must select no skills. Projection changes one root agent with the `read` tool
from `skills: []` to the exact generated skill. Paired evaluation runs the original workflow with no
package and the projected workflow with the exact generated package. Generation remains inert: it
does not evaluate, activate, install, sign, or publish the package.

`candidate validate` accepts the review directory. Validation depends on the still-present sibling
baseline, evidence, and blueprint files named by `CANDIDATE.json`. After explicit activation, new
runs use the durable projected workflow and package bytes. They do not read the candidate directory,
generation sources, network, registry, or credentials.

Activation requires a complete superior evaluation. An existing prompt, Agent Skill resource, or
Agent Skill package candidate can still use the legacy activation path. That path keeps its current
bytes, digest, output, and rollback behavior.

To retain more than one reviewed improvement, compose the ordinary candidate against the current
complete harness state first:

```sh
node dist/cli/main.js candidate compose better.prompt-candidate.yaml
```

The command publishes one immutable effective candidate below `.flow/effective-harness/artifacts/`.
It does not change the active head. Evaluate that staged candidate, then request an activation
preview:

```sh
node dist/cli/main.js candidate activate \
  .flow/effective-harness/artifacts/<artifact-sha256>.json \
  --evaluation candidate-evaluation --actor operator:test --dry-run
```

Review the candidate identity, evaluation proof, current selection, and proposal digest. Apply only
that digest:

```sh
node dist/cli/main.js candidate activate \
  .flow/effective-harness/artifacts/<artifact-sha256>.json \
  --evaluation candidate-evaluation --actor operator:test \
  --expected-digest <proposal-sha256>
node dist/cli/main.js activation inspect evaluated-profile
node dist/cli/main.js run activation:evaluated-profile --run-id active-candidate-run
```

Composition accepts prompt, Agent Skill resource, and Agent Skill package candidates. It projects
only the declared surface onto the current complete state. A prompt change keeps selected packages.
An Agent Skill resource change keeps prior prompt changes. A generated package change keeps every
unrelated reviewed field. Graphs, models, tools, approvals, budgets, verifiers, retries, sandbox
settings, evaluators, and unrelated packages cannot change.

The ordinary candidate remains bound to its own admitted filesystem baseline. Composition verifies
that candidate and its declared delta first. It then applies only that delta to the current complete
state. This permits a prompt candidate created before a reviewed package change, or a skill
candidate created before a reviewed prompt change, to retain both improvements. The exact target
prompt, package, or empty skill selection must still match the candidate's original before-state.
A stale second change to the same surface is rejected instead of overwriting the active review.

Each effective candidate contains the complete before and after states plus one content-free surface
delta. Activation publishes immutable dependencies before one atomic head change. Each run stores
the selected workflow, package closure, head proof, and runtime proof in its durable capability
snapshot. Attached runs, detached workers, child runs, resume, and replay use those frozen bytes.
They do not reopen the effective-state store. A later activation or rollback does not change an
existing run.

Rollback selects any retained complete state for future runs. Use `activation inspect` to read a
state digest, preview the exact transition, and apply that proposal. Rollback does not delete stored
states, artifacts, or history. It does not restore an old policy. Current policy admission runs
after state selection:

```sh
node dist/cli/main.js activation rollback evaluated-profile \
  --to state:<state-sha256> --actor operator:test --dry-run
node dist/cli/main.js activation rollback evaluated-profile \
  --to state:<state-sha256> --actor operator:test \
  --expected-digest <proposal-sha256>
```

Before a workflow has an effective head, the existing legacy rollback selectors remain available:

```sh
node dist/cli/main.js activation rollback evaluated-profile \
  --to baseline --actor operator:test --dry-run
node dist/cli/main.js activation rollback evaluated-profile \
  --to baseline --actor operator:test --expected-digest <proposal-sha256>
node dist/cli/main.js activation rollback evaluated-profile \
  --to agent-skill:better-review@1.0.0 --actor operator:test --dry-run
node dist/cli/main.js activation rollback evaluated-profile \
  --to agent-skill-package:generated-review-helper@1.0.0 \
  --actor operator:test --dry-run
```

Model-authorized evaluation and activation remain unavailable.

### Use a portable Agent Skill

Flow discovers local [Agent Skills](https://agentskills.io/specification) below the project-owned
`.flow/skills` directory. The repository includes a review package outside that active directory so
installing it remains an explicit local choice:

```sh
mkdir -p .flow/skills
cp -R examples/agent-skills/review .flow/skills/
node dist/cli/main.js skills validate
node dist/cli/main.js skills list
node dist/cli/main.js skills inspect review
node dist/cli/main.js validate examples/portable-agent-skill.workflow.yaml
```

The published workflow selects `skills: [review]` and grants only the Flow `read` tool. Running it
also requires a configured Pi provider and model credentials:

```sh
node dist/cli/main.js run examples/portable-agent-skill.workflow.yaml --run-id skill-demo
node dist/cli/main.js inspect skill-demo
```

Discovery loads bounded manifest metadata. At run submission Flow snapshots the exact selected
package bytes and records the snapshot in `run_started`; queued, child, and resumed execution use
those bytes even if `.flow/skills` later changes. The model receives metadata and `skill://`
resource addresses at startup, then uses `flow_read` to load instructions or resources on demand.
`allowed-tools` in a package is an auditable request, not authorization: only the workflow's
`agent.tools` list and Flow policy can grant an operation. Package files are data and are never
executed automatically.

### Use a versioned verifier package

Flow discovers strict inert `VerifierPackage` manifests below the project-owned `.flow/verifiers`
directory. Install the credential-free example explicitly, inspect its public identity, and bind
the exact version from a workflow:

```sh
mkdir -p .flow/verifiers
cp -R examples/verifier-packages/release-tests .flow/verifiers/
node dist/cli/main.js verifiers validate
node dist/cli/main.js verifiers list
node dist/cli/main.js verifiers inspect release-tests
node dist/cli/main.js validate examples/versioned-verifier-package.workflow.yaml
node dist/cli/main.js run examples/versioned-verifier-package.workflow.yaml --run-id package-demo
node dist/cli/main.js inspect package-demo
```

The workflow selects `release-tests@1.0.0`. Flow snapshots the exact manifest before admission,
resolves it through the existing sandboxed command-verifier driver, and records name, version, and
package digest on the typed verdict. Listing and inspection execute nothing and do not reveal a
model package's private rubric. Queued workers, child runs, and recovery use the same durable
snapshot even if the live manifest changes.

Command packages own an argv-only command declaration. Model packages own only a bounded rubric;
the workflow still owns evidence order, provider/model selection, thinking level, and timeout.
Packages cannot add tools, credentials, network access, graph transitions, policy, hooks, or
executable extension code. Arbitrary evaluator runtimes remain unsupported.

### Use a versioned command tool package

Flow discovers strict inert `ToolPackage` manifests below the project-owned `.flow/tools`
directory. Install the example explicitly, validate every discovered manifest, and inspect its
exact version and authority without executing it:

```sh
mkdir -p .flow/tools
cp -R examples/tool-packages/git-status .flow/tools/
node dist/cli/main.js tools validate
node dist/cli/main.js tools list
node dist/cli/main.js tools inspect git-status --version 1.0.0
node dist/cli/main.js validate examples/versioned-command-tool.workflow.yaml
```

Those commands require no model credentials and never invoke the package driver. The workflow
selects `git-status@1.0.0` only for its `inspect` agent. A live run requires a configured provider;
if the model calls `project_git_status`, agent-command execution additionally requires Flow's
Linux PID-namespace containment:

```sh
node dist/cli/main.js run examples/versioned-command-tool.workflow.yaml --run-id tool-demo
node dist/cli/main.js inspect tool-demo
```

The v1 package contributes one model-visible tool, required bounded scalar inputs, one closed
Flow-owned command profile, and literal argv with exact whole-argument input placeholders. The
public example uses the exact hardened `git-status-v1` profile; `posix-printf-v1` is the initial
typed data-output profile. They bind `/usr/bin/git` and `/usr/bin/printf` respectively, preventing
workspace-controlled `PATH` substitution. Project manifests cannot register profiles or executable identities.
There is no shell,
package code, hook, environment, credential, working-directory override, stdin, PTY, background
process, or network grant. Flow snapshots exact manifest bytes before admission, presents only
packages explicitly selected by that agent, renders typed inputs deterministically, and sends the
result through the same `process.execute` policy, optional live approval, sandbox, write-ahead
command journal, cancellation, output, budget, and replay path as `flow_exec`. Queued workers,
child runs, and recovery consume the immutable snapshot rather than reloading `.flow/tools`.

### Use a versioned workflow package

Flow discovers strict inert `WorkflowPackage` manifests below the project-owned
`.flow/workflows` directory. Install the credential-free example explicitly, then validate its
metadata and the parent workflow that selects its exact version:

```sh
mkdir -p .flow/workflows
cp -R examples/workflow-packages/release-check .flow/workflows/
node dist/cli/main.js workflows validate
node dist/cli/main.js workflows list
node dist/cli/main.js workflows inspect release-check --version 1.0.0
node dist/cli/main.js validate examples/versioned-workflow-package.workflow.yaml
node dist/cli/main.js run examples/versioned-workflow-package.workflow.yaml \
  --run-id workflow-child-demo
```

The parent uses `child.package: { name: release-check, version: 1.0.0 }`; Flow compiles the
package's embedded ordinary workflow through the same recursive compiler, child isolation, budget,
typed-result, evidence, and recovery rules as an embedded child. A package may also be the root:

```sh
node dist/cli/main.js validate workflow:release-check@1.0.0
node dist/cli/main.js run workflow:release-check@1.0.0 --run-id workflow-root-demo
# For an interrupted, nonterminal run:
node dist/cli/main.js resume workflow:release-check@1.0.0 --run-id interrupted-root-demo
```

The locator requires an exact SemVer; ranges, tags, and implicit latest selection are rejected.
Admission captures the packaged root plus every transitively selected workflow package, then
performs the authoritative compile with a closed resolver over those immutable bytes. Detached
workers and resume use the durable snapshot even if `.flow/workflows` or an installed bundle is
changed or removed. Package cycles, multiple versions of one name, missing exact versions, source
races, and snapshot mismatches fail closed.

`WorkflowPackage` contains only bounded workflow source. It cannot register code, hooks, drivers,
providers, credentials, policy, sandbox permissions, or dynamic graph factories. It has exactly
the authority of the ordinary workflow nodes an operator explicitly selects. Template inputs,
version solving, and executable extensions remain unsupported.

### Select an inert presentation package

Flow accepts a strict profile of the production A2UI v0.9.1 release for terminal and browser
presentation.
Messages use the standard `version: v0.9` wire discriminator. A local package is one
`.flow/presentations/<name>/PRESENTATION.yaml` file. It may arrange the six fixed Flow run widgets,
group them, and select compact or comfortable spacing. It cannot supply run data, text, actions,
data bindings, functions, themes, assets, code, or dynamic children.

```sh
node dist/cli/main.js presentations validate .flow/presentations/concise/PRESENTATION.yaml
node dist/cli/main.js presentations list
node dist/cli/main.js presentations inspect concise --version 1.0.0
node dist/cli/main.js tui run-id --actor operator \
  --presentation concise@1.0.0
node dist/cli/main.js web run-id --actor operator \
  --presentation concise@1.0.0
```

Selection uses an exact name and SemVer before Flow starts the supervisor, takes terminal control,
or creates the browser listener. It is session-local presentation state: run history, capability
snapshots, approvals, policy, and replay identity do not change. Without `--presentation`, each
host uses the default Flow document and layout. Installed `.flowpkg` bundles may contribute the
same inert manifest under `presentations/<name>/PRESENTATION.yaml`.

The public Flow catalog is
[`docs/specs/flow-a2ui-run-presentation-v1.catalog.json`](docs/specs/flow-a2ui-run-presentation-v1.catalog.json).
This profile deliberately excludes optional general A2UI features. ACP is not the package ABI.
The local ACP bridge transports Flow-owned presentation updates across an editor session. It does
not let the editor change the selected package or supply presentation content.

### Apply a versioned policy package

Flow discovers strict inert `PolicyPackage` manifests below the project-owned `.flow/policies`
directory. Install and inspect the example before selecting it:

```sh
mkdir -p .flow/policies
cp -R examples/policy-packages/restricted-review .flow/policies/
node dist/cli/main.js policies validate
node dist/cli/main.js policies list
node dist/cli/main.js policies inspect restricted-review --version 1.0.0
```

Copy the inspected package `digest` into trusted configuration. A project can add constraints in
`.flow/config.yaml`:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowProjectConfig
policies:
  additional:
    - name: restricted-review
      version: 1.0.0
      digest: <64-lowercase-hex-from-inspect>
```

A trusted operator can require the same exact reference with `policies.required` in
`${XDG_CONFIG_HOME}/flow/config.yaml`. Project configuration can add another package, but it cannot
remove or replace an operator requirement. References are exact, sorted, and unique. Flow rejects a
missing version, changed digest, duplicate name, incompatible sandbox profile, or contradictory
combination before it creates run or supervisor state.

```sh
node dist/cli/main.js config show
node dist/cli/main.js validate examples/versioned-policy-package.workflow.yaml
```

Policy packages contain only a closed set of model, tool-name, tool-permission, command-approval,
sandbox-profile, and workflow-budget constraints. Allowed sets intersect, numeric ceilings take
the minimum, and approval requirements combine with logical OR. Adding a package can only narrow.
Packages cannot register a provider, tool, permission, sandbox, graph node, credential, hook,
evaluator, or executable code.

Mandatory command approval covers direct commands and command-capable agent tools. It rejects
command verifier nodes because those nodes do not have an approval contract.

Flow snapshots every selected manifest before admission and includes the canonical effective
policy digest in the supervisor identity. The same snapshot constrains attached, detached, child,
recovery, and replay paths. Resume rejects a current configuration that adds, removes, upgrades, or
substitutes a package relative to durable history. Catalog and network access are not needed after
admission. With no selected policy package, the prior config shape, policy digest, and workflow
behavior remain unchanged.

### Distribute exact capability bundles

Flow can pack the six existing inert package ABIs into one deterministic strict-JSON `.flowpkg`.
Bundle sources contain `BUNDLE.json` plus any of the conventional `skills/`, `verifiers/`, `tools/`,
`workflows/`, `policies/`, or `presentations/` trees:

```sh
node dist/cli/main.js packages pack examples/capability-bundle-source \
  --output /tmp/review-suite-1.0.0.flowpkg
```

The command refuses symlinks, special or unknown files, executable payloads, extra
verifier/tool/workflow files, unsafe paths, source races, and an existing output. It reports the exact byte count and
`sha256:<hex>` digest. Publish the unchanged file over public HTTPS and communicate its digest over
a channel the operator trusts. If packing reports `commit_uncertain`, inspect and verify the exact
requested output path; the final file is already visible and a blind retry will return
`output_exists`. Install requires both values explicitly:

```sh
node dist/cli/main.js packages install \
  https://packages.example.test/review-suite-1.0.0.flowpkg \
  --sha256 <64-lowercase-hex>
node dist/cli/main.js packages install-oci \
  registry.example.test/flow/review-suite@sha256:<64-lowercase-hex> \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-certificate-identity>
node dist/cli/main.js packages list
node dist/cli/main.js packages inspect review-suite --version 1.0.0
node dist/cli/main.js packages verify
node dist/cli/main.js packages remove review-suite --version 1.0.0
```

To establish the optional signed metadata authority, use only explicit local files:

```sh
node dist/cli/main.js packages metadata refresh capability-metadata.json \
  --sigstore-bundle capability-metadata.sigstore.json \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-metadata-certificate-identity>
node dist/cli/main.js packages metadata inspect
```

To check one signed public channel without changing active metadata, then review and explicitly
activate one exact candidate:

```sh
node dist/cli/main.js packages metadata check \
  https://metadata.example.test/flow/capability-metadata.json \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-metadata-certificate-identity>
node dist/cli/main.js packages metadata candidates list
node dist/cli/main.js packages metadata candidate inspect sha256:<64-lowercase-hex>
node dist/cli/main.js packages metadata activate sha256:<64-lowercase-hex> \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-metadata-certificate-identity>
node dist/cli/main.js packages metadata candidate remove sha256:<64-lowercase-hex>
```

For a token-gated repository, read the secret without exporting it or placing it in argv:

```sh
read -r -s registry_password
printf '%s\n' "$registry_password" | node dist/cli/main.js packages install-oci \
  registry.example.test/flow/private-suite@sha256:<64-lowercase-hex> \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-certificate-identity> \
  --username registry-user --password-stdin
unset registry_password
```

The two install commands and the explicit metadata check are the only package network operations.
The HTTPS install and metadata-channel forms accept canonical URLs without credentials, query,
fragment, or redirects. The OCI form accepts only a canonical HTTPS registry repository with
public pinned addresses and an exact manifest digest. It does not accept a tag, version range,
registry discovery result, package-provided reference, IP literal, port, query, or fragment.

The OCI artifact must contain one strict Flow bundle layer and one Sigstore v0.3 verification
layer in a fixed order. Flow checks the manifest, media types, descriptor sizes, and SHA-256 values
before it parses or verifies content. It verifies the exact bundle bytes against the supplied
certificate issuer and exact certificate identity. Verification uses the trusted Sigstore
public-good root that ships with this Flow release. It requires signed-time, certificate-log, and
transparency-log evidence. It does not contact a signature service or update trust data.

Registry DNS, credential input, pull-token work, manifest reads, redirects, and layer reads share
one deadline. Without the paired private options, Flow preserves the anonymous pull flow and never
reads stdin. With both options, Flow first validates the canonical HTTPS Bearer realm, exact
service, and exact `repository:<name>:pull` scope. It then reads one non-empty UTF-8 secret of at
most 16,384 bytes from stdin. One terminal LF is removed. NUL, CR, another LF, invalid UTF-8, empty
input, and byte 16,385 reject.

The selected registry controls the challenged authorization realm and service. Flow preserves
those values exactly and validates their transport and scope. It cannot prove that a separate
realm has the same operator as the registry. The operator must trust both services and should use
a registry-specific credential. The Bearer token is opaque. Flow cannot inspect its embedded
grants, so it confines the token to the original registry and exact digest reads.

Flow sends one RFC 7617 Basic value only to that exact token realm. It sends the returned bounded
Bearer token only to the original registry. A cross-host blob redirect receives neither value.
Flow requests no refresh token and rejects token-response extensions. It does not read Docker
configuration, invoke a credential helper, accept a password argument or environment credential,
or persist a login session.

Mutable secret buffers are cleared after the token request. The JavaScript and TLS stacks cannot
promise heap erasure of temporary string copies. All public failures use fixed stages. They omit
credential input, authorization values, registry bodies, paths, publisher values, and parser
causes.

Both forms reuse the existing package validators. Flow publishes an immutable blob below
`.flow/packages/sha256/` and atomically updates `.flow/packages.lock.json` last. A signed lock entry
records the exact OCI reference, manifest digest, publisher policy, and signature-bundle digest.
This data is audit evidence, not a later network instruction. It contains no username, token realm,
credential mode, password, Basic value, or Bearer token.

Orphan blobs are inactive. Local and installed name or tool collisions fail instead of applying
precedence.

An arbitrary HTTPS or OCI upgrade remains explicit and non-atomic. Pause new admissions, retain the
old bundle source and digest, install a new exact bundle version, remove the old exact version, and
run `packages verify` before resuming. Overlapping package or provider-facing tool names make
catalog discovery fail closed between those mutations.

A reviewed TUF repository candidate can instead replace one exact established version atomically.
The command below reopens the complete stored repository generation, repeats offline Sigstore
verification, and replaces one lock entry in one atomic generation:

```sh
node dist/cli/main.js packages repository candidate replace sha256:<candidate-digest> \
  --from-version 1.0.0 \
  --certificate-issuer https://token.actions.githubusercontent.com/ \
  --certificate-identity <exact-certificate-identity>
```

The established and candidate bundles must keep the same capability surface. This surface includes
the bundle name, publisher, package identities, requested tools, and provider-facing tool names.
The candidate version must have higher semantic-version precedence. Policy-bearing bundles do not
use this path. One current metadata state must authorize both exact versions during the switch.

Flow publishes the new immutable blob first. One lock rename then exposes the complete old or new
generation. A settled result is `replaced` with bounded cleanup evidence. An exact repeat returns
`already_current`. Existing runs and evaluations keep their frozen package snapshots. Only later
admission reads the new lock.

Replacement returns `cleanup: retained` and keeps the old immutable blob. This lets a reader that
captured the old lock finish safely. The retained blob is not active because the new lock does not
reference it.

Rollback remains a separate reviewed forward replacement or the paused manual procedure. Flow does
not automatically check, replace, roll back, or collect unrelated orphan blobs.

An existing `.flow/packages.mutation.lock` always blocks mutation, even if its recorded same-host
process has exited. After verifying that no package mutation is active, an operator may remove that
exact stale lock manually. A `commit_uncertain` error means the lock-file replacement or mutation
completed but durability or cleanup could not be confirmed: inspect `packages list`, run `packages
verify`, and reconcile the exact installed versions before retrying.

The HTTPS digest identifies bytes but does not authenticate a publisher. The signed OCI form also
proves that the admitted publisher signed those bytes. Neither proves that content is safe or
correct. Review the source, digest, publisher policy, and package content. Installation executes
nothing.

Signed capability metadata is an optional, explicit second authority layer. Refresh reads only the
two named local files, verifies the exact canonical metadata bytes with the same offline Sigstore
root, and atomically publishes `.flow/packages.metadata.json`. It performs no discovery or network
request. A positive integer version must increase monotonically. An equal version is idempotent
only for the same metadata bytes and signer policy. Lower versions, substituted bytes or authority,
expired metadata, revoked targets, and any target mismatch reject.

Before metadata is established, the existing exact digest and publisher rules apply. After it is
established, each new install and catalog admission also requires one current `active` target that
matches the complete target identity. That identity includes bundle name, exact version, digest,
bytes, source, and OCI publisher policy. Freshness uses the local system clock. An untrusted or
incorrect clock invalidates the freshness claim.

The optional channel check accepts only one explicit canonical public HTTPS URL and one exact
operator-supplied signer policy. It fetches one strict canonical signed envelope, verifies its
metadata offline, compares it only with active metadata, and stages an inert candidate below
`.flow/packages.metadata.candidates/sha256/`. It also replaces one bounded latest-check
observation. It does not change `.flow/packages.metadata.json` or
`.flow/packages.lock.json`. Exactly four distinct candidates may coexist. Checking the same
candidate again is idempotent.

Activation reopens and rehashes the candidate. It repeats signature and freshness verification
with new signer arguments and a fresh clock reading. The existing active-metadata store performs
monotonic publication. Candidate removal removes only inert candidate state. Neither operation
installs, removes, downloads, or executes a package.

Runs, workers, children, recovery, and replay never read candidate state. An external scheduler
may invoke `metadata check`. Flow does not poll or activate metadata. It does not install, roll
back, or resolve packages automatically.

For a standards-based repository, initialize one explicit local TUF root, check, review, and then
activate a first version or replace one established version:

```sh
node dist/cli/main.js packages repository init https://updates.example.test/ \
  --trusted-root ./root.json
node dist/cli/main.js packages repository check
node dist/cli/main.js packages repository candidates list
node dist/cli/main.js packages repository candidate inspect sha256:<candidate-digest>
node dist/cli/main.js packages repository candidate activate sha256:<candidate-digest> \
  --certificate-issuer <exact-https-issuer> --certificate-identity <exact>
node dist/cli/main.js packages repository candidate replace sha256:<candidate-digest> \
  --from-version <exact-current-version> \
  --certificate-issuer <exact-https-issuer> --certificate-identity <exact>
```

Repository activation and replacement are offline. Candidate removal changes only the inert
repository generation. The bounded check scheduler has no activation or replacement port.

An authenticated metadata state may contain no targets. That is an established deny-all state:
every new package installation and catalog admission rejects, while metadata inspection and
explicit package removal remain available. Those same remediation operations remain available when
metadata is expired or a target is revoked. Metadata never changes packages automatically. It does
not implement delegation or online trust-root refresh.

A later selected Skill or model rubric can influence a model. A selected command package retains
its documented sandboxed command authority. Listing, inspection, verification, workflow admission,
execution, detached work, child work, resume, and replay use installed bytes. Admission consults
only local metadata when that authority exists. An admitted run retains its immutable package
snapshot. Later metadata refresh does not mutate it. Execution and recovery never fetch a URL,
contact a registry or signature service, or consult live publisher data.

To exercise the first-class verifier contract without model credentials:

```sh
node dist/cli/main.js validate examples/typed-command-verifier.workflow.yaml
node dist/cli/main.js run examples/typed-command-verifier.workflow.yaml --run-id verifier-demo
node dist/cli/main.js inspect verifier-demo
```

The command driver wraps the existing sandboxed command evidence in a typed `accepted`, `rejected`,
or `inconclusive` verdict. A model driver instead evaluates only 1–16 declared direct-dependency
evidence fields in a separate Pi session with a dedicated system prompt, no tools or project
discovery, a 256 KiB aggregate input ceiling, a 16 KiB response ceiling, and one strict JSON
verdict object. Model verification is probabilistic and is not prompt-injection-proof; prefer the
command driver for release claims and hidden deterministic checks.

To publish provider-neutral typed data without model credentials:

```sh
node dist/cli/main.js validate examples/typed-result.workflow.yaml
node dist/cli/main.js run examples/typed-result.workflow.yaml --run-id result-demo
node dist/cli/main.js inspect result-demo
```

The `result` node reads one complete durable field from a direct dependency, validates it as strict
JSON against a closed bounded schema, and records its RFC 8785 canonical JSON plus source, schema,
and value hashes. It is a pure control transition: it invokes no executor and consumes no node-start,
token, cost, or active-time budget. Downstream conditions, approvals, model verifiers, and bounded
loop checks can read the canonical value as `result.value`. A typed result is data, not a goal
verdict; it cannot satisfy a goal criterion by itself.

To run a separately-ledgered child workflow against an isolated snapshot:

```sh
node dist/cli/main.js validate examples/isolated-child.workflow.yaml
node dist/cli/main.js run examples/isolated-child.workflow.yaml --run-id child-demo
node dist/cli/main.js inspect child-demo
```

The parent durably records a deterministic child run link.
It snapshots the exact working-tree content in an owner-only reflink-or-copy workspace outside the protected project `.flow` directory and run store.
It runs the embedded workflow with the normal compiler, scheduler, policy, sandbox, and ledger.
It then discards the workspace and imports its canonical typed result and resource totals.

The child ledger remains independently inspectable at the run id shown
under `nodes.delegate.childRun`. Every child declares all five run ceilings, including
`maxArtifactBytes`. A child ceiling is reserved against its immediate parent's remaining budget
before materialization; nested reservations and verified actual roll-ups propagate those bounds
through the ancestor chain. The compiled tree is limited to four child levels and 1,024 expanded
nodes. Child workflows cannot wait for human approval. Ordinary child nodes never apply or export
child changes. Compiler-generated optimization candidates are the narrow exception: their
successful workspace remains retained until the optimization check rejects and discards it or
durably promotes its verified delta. Cancellation before that check starts no promotion or later
candidate and retains the isolated workspace for diagnosis.

To exercise durable conditional routing without model credentials:

```sh
node dist/cli/main.js validate examples/conditional-branch.workflow.yaml
node dist/cli/main.js run examples/conditional-branch.workflow.yaml --run-id conditional-demo
node dist/cli/main.js inspect conditional-demo
```

The classifier's complete `command.stdout` selects one declared case by exact equality. Flow
records the decision, marks the other branch omitted, and reconciles both alternatives through an
explicit join before the final verifier. Truncated source evidence fails closed instead of routing.

To exercise a bounded static DAG fork without model credentials:

```sh
node dist/cli/main.js validate examples/concurrent-fork.workflow.yaml
node dist/cli/main.js run examples/concurrent-fork.workflow.yaml --run-id concurrent-demo
node dist/cli/main.js inspect concurrent-demo
```

The workflow opts in with `concurrency: { maxNodes: 2 }`; omission preserves the legacy maximum of
one. Flow admits ready executable nodes in declaration order, durably records every start before
invocation, waits for the complete wave to quiesce, and commits outcomes in declaration order even
when wall-clock completion reverses. A failure or cancellation starts no later wave, but every
already-admitted node is settled first. Conditions, joins, and both approval protocols are barriers and
never overlap an executable wave. This is bounded concurrency inside one run; the supervisor's
worker limit independently bounds detached runs.

To exercise a replay-safe bounded loop without model credentials:

```sh
node dist/cli/main.js validate examples/bounded-loop.workflow.yaml
node dist/cli/main.js run examples/bounded-loop.workflow.yaml --run-id loop-demo
node dist/cli/main.js inspect loop-demo
```

The example advances a small workspace state file, records `continue` after iteration one and
`stop` after iteration two, durably omits the unused third iteration, and verifies and removes the
state file. Loop bodies remain ordinary local DAGs, so approvals, budgets, effects, fresh recovery,
and bounded node concurrency apply to each iteration-qualified instance. Reaching the declared
bound without an exact match fails with `loop_limit_reached`; it never implies success.

To exercise bounded accept-best optimization without model credentials:

```sh
node dist/cli/main.js validate examples/bounded-optimization.workflow.yaml
node dist/cli/main.js run examples/bounded-optimization.workflow.yaml --run-id optimization-demo
node dist/cli/main.js inspect optimization-demo
```

The example establishes a typed baseline with score `10`, runs each candidate in a separate
reflink-or-copy workspace, and accepts only a strict invariant-preserving decrease. Candidate one
changes a demo file and reports score `8`; Flow captures the complete typed path delta, verifies the
parent still matches the candidate baseline, journals rollback bytes, and promotes it. Candidate
two reports the same score, so it cannot change the parent, increments stagnation, and stops the
finite graph. The final command verifies the promoted value and removes the demo file.

Candidate capture has independent default ceilings of 20,000 changed entries, 2 GiB of logical
before-plus-after file bytes, and 128 KiB of serialized delta evidence. An exact captured manifest
is reopened after interrupted event publication; a different or partial manifest fails closed.

Inspection exposes baseline and candidate metrics, expected and observed invariant values, delta
entries and digest, promotion identity and settlement, cleanup, best candidate, stopping reason,
and aggregate child resources. A crash after prepare resumes through typed reconciliation; Flow
never reapplies a known committed promotion. A stale parent, rolled-back promotion, or unprovable
affected path fails the check and starts no downstream node.

### Run in the background

Add `--detach` to `run` or `resume` when work must survive the submitting client:

```sh
node dist/cli/main.js run <workflow.yaml> --detach --run-id background-run \
  --command-id 019fd722-4144-7a72-9c86-6f9af022b2e8
node dist/cli/main.js supervisor status
node dist/cli/main.js events background-run --after 0 --follow
```

The local supervisor journals the exact submission identity and applies the effective capacity
policy before launch. With the defaults, one worker may be active and 32 additional jobs wait in a
durable FIFO queue. A submission returns `accepted` only after its worker authenticates, `queued`
with its stable queue ticket when it is waiting, or `rejected` with `queue_full` when the configured
queue is full. Accepted means the worker is ready; it does not mean the workflow has succeeded.
`events` replays authoritative ledger records in bounded pages and `--follow` continues until a
terminal event. To cancel active or queued work with attribution:

```sh
node dist/cli/main.js cancel background-run --actor local:daniel --reason "operator requested" \
  --command-id 019fd722-4144-7a72-9c86-6f9af022b2e9
node dist/cli/main.js supervisor shutdown
```

Cancellation uses a durable idempotent command record. Active cancellation terminates the node
process tree, preserves settled evidence, and records `cancelled`; queued cancellation creates no
run ledger, active claim, or worker. Shutdown is intentionally refused while active or queued work
exists. If the supervisor itself exits, workers continue and queued admission remains durable; a
replacement generation reconciles both before accepting new work. This is same-host execution, not
a remote or multi-host service.

`--command-id` is optional and must be a UUID. Flow generates one when omitted. Automation should
generate and persist the ID before its first detached submission or cancellation, then reuse the
same ID and exact input after an acknowledgement loss. Reusing an ID with different input is a
conflict. Submission acceptance, deterministic rejection, and uncertain launch are durable; an
uncertain submission is reconciled only from its authenticated worker, while an uncertain
cancellation is reconciled from the ledger rather than dispatched again.

### Follow and steer a run in a terminal

Use the first-party terminal host from an interactive terminal:

```sh
node dist/cli/main.js tui background-run --actor local:daniel
```

The view follows the authoritative event cursor and shows bounded public run state. Use `j` and
`k`, or the arrow keys, to select an action. Press Enter to submit the current approval, denial, or
cancellation action. Press `q` or Ctrl-C to leave the view. Leaving the view does not cancel the
run.

The host accepts only Flow's closed presentation document. It replaces terminal controls and
ambiguous Unicode formatting in untrusted values before rendering. Pi supplies terminal layout and
input primitives. It does not receive durable authority, raw capability bytes, private error
causes, provider credentials, filesystem paths, or arbitrary markup. Mouse input, Markdown,
hyperlinks, URL opening, clipboard controls, images, package renderers, and executable UI content
are not enabled.

The command requires interactive stdin and stdout. It rejects redirected or non-interactive use
before configuration, supervisor, storage, or terminal mutation. Use the unchanged JSON `inspect`,
`events`, `approve`, `deny`, and `cancel` commands for scripts, redirected output, or explicit
recovery.

### Follow and steer a run in a local browser

Use the fixed first-party browser host for a graphical view:

```sh
node dist/cli/main.js web background-run --actor local:daniel
```

Flow prints one `http://127.0.0.1:<ephemeral-port>/#<capability>` URL. Open that URL in the local
browser for the same operator account. The capability is 256 random bits.

The fixed client copies it to tab-scoped `sessionStorage`, removes it from the address bar, and sends
it only in authorization headers after startup. This storage supports reload and can follow browser
session restoration. A related browser context can receive an initial copy. The fixed client never
opens such a context. The client removes the value when terminal observation settles. It never
enters a cookie, `localStorage`, a request URL, or durable Flow state.

The listener accepts only explicit IPv4 loopback traffic, the exact host and browser request
context, and one observer. It sets a closed content policy, serves no external resource, uses no
cookie, and exposes no cross-origin API.

The client renders only the closed public presentation document with DOM node creation and text
insertion. It does not render package HTML, Markdown, URLs, JavaScript, assets, bindings, or raw run
events. A button sends the current document sequence and opaque action id through the same approval
or cancellation controller as the terminal host. Closing or reloading the page does not cancel the
run. Flow retains only the latest bounded complete document for one bounded reconnect interval.

This host is for one local operator. The session capability protects against other operating-system
users, ambient web origins, and accidental disclosure. It is not an isolation boundary against a
malicious process running as that same operator. Remote listening, TLS termination, reverse
proxies, shared users, executable UI extensions, and AG-UI remain unsupported. The local ACP
bridge can transport the same Flow-owned document and input messages to an editor. ACP does not
replace the browser API, A2UI package profile, supervisor protocol, or durable ledger.

### Observe and steer a run from an ACP v1 editor

Start the local stdio bridge from the selected Flow project:

```sh
node dist/cli/main.js acp --actor local:daniel
```

Standard input and output contain only ACP v1 newline-delimited JSON-RPC. The editor can create,
list, load, resume, close, and prompt Flow sessions. A new session reserves one UUID that is also
the Flow run id. Use `/flow-run <source>` once to select a project-relative workflow,
`workflow:<name>@<exact-version>`, or `activation:<workflow-id>`. An editor can instead send
`/flow-run` with one project-local `file:` resource link. Use `/flow-continue` to observe and steer
the bound run.

Flow sends standard ACP updates for its public run status, plan, messages, and approval tools. A
permission selection invokes the same current-action controller as the terminal and browser
hosts. ACP cancel and close use the existing durable supervisor cancellation command. Input EOF or
an editor disconnect closes only the bridge. It does not cancel an already durable run.

The bridge captures one effective policy at startup. Restart it to adopt a policy change. Closing
an empty ACP session creates no supervisor command. Closing a submitted session is idempotent and
blocks later prompts on that connection until the editor loads or resumes the durable session.
After submission, the adapter waits for the first ledger event without retrying workflow execution.

The bridge does not call editor filesystem or terminal methods. It rejects MCP servers, extra
directories, custom methods, unsupported protocol versions, absolute workflow paths, and paths
outside the canonical project. It exposes no network listener and supports one local operating-
system user. Remote, reverse-proxied, shared-user, ACP v2, A2A, AG-UI, and custom A2UI-over-ACP
hosting remain outside this contract. See [Local ACP v1 bridge](docs/acp.md) and
[Recovery and interruption safety](docs/recovery.md).

### Approve an exact command

The approval example stops before sandbox preparation or process spawn and exits with code 3:

```sh
node dist/cli/main.js run examples/approval-gated-command.workflow.yaml --run-id approval-demo
node dist/cli/main.js inspect approval-demo
```

Inspect the pending executable, ordered arguments, working directory, timeout, operation digest,
request id, and grant lifetime. Record a decision with an explicit local actor label:

```sh
node dist/cli/main.js approve approval-demo approval-2 --actor local:daniel
node dist/cli/main.js resume examples/approval-gated-command.workflow.yaml --run-id approval-demo
```

Approval records consent but does not execute. `resume` must compile the exact starting workflow and
use the same execution directory. The grant is single-use and defaults to five minutes; if it
expires before the node starts, Flow records expiry and returns to a new durable request. A pending
request itself does not time out or imply consent. To reject it instead:

```sh
node dist/cli/main.js deny approval-demo approval-2 --actor local:daniel --reason "not authorized"
```

The actor label is append-only attribution supplied by the caller, not authenticated identity.
Anyone who can control the private run directory or invoke Flow with the same local permissions is
inside this slice's administrative trust boundary.

### Approve an agent `exec` tool call

An agent node can require an operator decision for every model-requested `flow_exec` call:

```yaml
agent:
  prompt: Implement the change and run the focused tests.
  model: { provider: anthropic, id: claude-sonnet-4-5 }
  tools: [read, edit, exec]
  toolApproval:
    exec:
      mode: required
      grantTtlMs: 300000
```

Start the credential-requiring example in one terminal, attached or detached:

```sh
node dist/cli/main.js run examples/agent-command-approval.workflow.yaml \
  --run-id agent-approval-demo
node dist/cli/main.js inspect agent-approval-demo
```

Inspection shows the live Pi node plus its pending exact executable, ordered arguments, normalized
working directory, timeout, operation digest, request digest, request id, and grant lifetime. From
another terminal, submit the decision:

```sh
node dist/cli/main.js approve agent-approval-demo <request-id> --actor local:daniel
# or
node dist/cli/main.js deny agent-approval-demo <request-id> --actor local:daniel \
  --reason "command is not authorized"
```

The decision command writes an immutable owner-only receipt and reports
`agent_command_approval_decision_submitted`. It does not append authoritative run state or spawn a
process. The active run owner validates the exact run, workflow, node, attempt, working directory,
command, timeout, and digests, then records the grant or denial in the event ledger. A grant is
exclusive, expiring, and consumed atomically by one matching command-preparation event before
sandbox preparation or spawn. A denial becomes a bounded tool error so the live model can revise
its plan; it does not automatically fail the agent node. A malformed, forged, or mismatched receipt
closes the pending request as invalid and executes nothing. Transient local receipt-read failures
keep waiting with bounded backoff until the node is cancelled, reaches its deadline, or reads a
valid receipt. Concurrent agent nodes share a run-scoped decision queue, so only one exact human
prompt is pending at a time.

This is a live tool-call suspension, so there is no `resume` step after an ordinary decision. If
the owning process crashes while Pi is suspended, Flow preserves the request for inspection but
does not reconstruct the opaque Pi tool call or transcript; recovery fails closed. Child workflows
cannot declare interactive approvals. Actor labels and same-user run-directory access have the
same local administrative trust boundary as command and graph approvals.

### Approve durable graph evidence

An `approval` node pauses the graph after its declared command, agent, accepted verifier, or typed
result evidence is complete:

```sh
node dist/cli/main.js run examples/evidence-approval.workflow.yaml --run-id review-demo
node dist/cli/main.js inspect review-demo
node dist/cli/main.js approve review-demo approval-4 --actor local:daniel
node dist/cli/main.js resume examples/evidence-approval.workflow.yaml --run-id review-demo
```

The request binds the workflow digest, prompt, logical attempt, and ordered source node, attempt,
field, and content hash. Sources must be direct dependencies and may select `command.stdout`,
`command.stderr`, `agent.text`, accepted verifier fields, or `result.value` from a compatible
successful node. Truncated evidence fails the approval node without creating a request.

Unlike command approval, approving graph evidence immediately succeeds a pure control node. It
does not authorize a process, expand sandbox or tool policy, create a grant, or consume execution
budget. Denial immediately fails the node without a `node_started` event or downstream execution.
The same `approve` and `deny` commands inspect the pending request type and emit the matching durable
event protocol. Resume is still explicit and requires the exact starting workflow.

### Bound a run

The budget example is credential-free and demonstrates run-wide start, active-execution, and
retained-artifact limits:

```sh
node dist/cli/main.js validate examples/budgeted-foundation.workflow.yaml
node dist/cli/main.js run examples/budgeted-foundation.workflow.yaml --run-id budget-demo
node dist/cli/main.js inspect budget-demo
```

A workflow can declare any non-empty combination of `maxNodeStarts`, `maxModelTokens`,
`maxCostUsd`, `maxExecutionMs`, and `maxArtifactBytes`. Missing `budget` means unbounded. Each limit
is a positive safe integer except `maxCostUsd`, which accepts positive values precise to one
micro-USD. Flow persists the compiled limits at run start and reconstructs `resources`, remaining
allowance, and exhausted dimensions from the event ledger. Agent usage comes from Pi session
statistics but is translated into Flow-owned token fields and integer micro-USD before persistence.

`artifactBytes` counts UTF-8 bytes retained in primary executor evidence: agent-command tool
`stdout + stderr` at durable command settlement, plus terminal command `stdout + stderr`, agent
`text`, model-verifier `raw`, command-verifier nested command
`stdout + stderr`, and a verified child tree's own `artifactBytes`. Committed failed evidence is
charged by the same rule; missing evidence contributes zero. Verdicts, verifier reasons, typed
result values, approvals, hashes, policy/effect/sandbox metadata, and other derived or control
projections are not charged again. This is a logical evidence-payload budget. Flow does not yet
provide an artifact store, content-addressed storage, spill, download, retention, or garbage
collection protocol.

Reaching a model-token, reported-cost, active-execution, or artifact ceiling records
`resource_exhausted`, exits with code 1, and starts no downstream work. A node-start limit prevents
the next start but does not invalidate a graph that completed with its final allowed start. Node
timeouts are reduced to the remaining active-execution allowance; an approval request displays and
binds that reduced timeout. Approval wait and client-detached wall time do not consume active time.

Artifact accounting normally settles with the terminal node outcome. Agent-command stdout and
stderr settle earlier with `node_agent_command_settled`, so an interrupted model turn cannot erase
them and terminal agent evidence does not charge them again. Equality is terminal and one bounded
outcome may overshoot. An already-admitted concurrency wave is allowed to quiesce; all of
its declaration-ordered outcomes remain retained and charged before the run stops. Per-node output
caps bound that overshoot, and bytes truncated before evidence exists cannot be recovered.

Model usage and cost become authoritative only after the provider response settles, so one response
can exceed its remaining allowance. Flow records the full observation and stops; it does not claim
to enforce a prepaid hard billing cap, infer prices, or reconcile provider invoices.

To inspect the coding-agent shape without contacting a provider, validate the implementation
template:

```sh
node dist/cli/main.js validate examples/implement-and-verify.workflow.yaml
```

The template declares `read`, `ls`, and `edit`, an opt-in bounded fresh-recovery policy, and a
first-class deterministic command verifier. Adapt its prompt, model, and verification command before running
it; unlike the credential-free foundation example, execution requires a configured Pi provider and
may change the selected workspace.

To validate the command-capable agent template:

```sh
node dist/cli/main.js validate examples/agent-command.workflow.yaml
```

This template adds the explicit `exec` capability. The model receives `flow_exec`, whose only
inputs are a bounded executable, literal argument vector, and deadline. Flow authorizes and
durably prepares the exact normalized request before spawning it through the same production SRT
executor used by command nodes, then durably settles bounded stdout/stderr, hashes, exit/signal,
timeout, duration, and sandbox provenance. Retained stream prefixes have independent hashes and
UTF-8 byte counts, so inspection can authenticate them even when the complete stream was truncated.
The deadline includes sandbox preparation and kernel-backed descendant termination. On Linux, Flow
resolves Bubblewrap to an executable outside the workspace whose complete path is root-owned and
not group- or world-writable, configures SRT with that absolute path, and verifies the returned
descriptor uses the expected outer shell and canonical quoting, binds the same executable, and
places the secure PID/user-namespace, capability-drop, process-mount, and parent-death options in
their active positions before granting spawn authority. Flow parses every preceding Bubblewrap
option through a fixed arity allowlist, so lifecycle-looking operand values do not count and unknown
options fail closed pending review. A delayed preparation cannot spawn after
the absolute monotonic deadline.
On macOS, `flow_exec` returns `command_sandbox_unavailable` before spawn because process groups alone
cannot contain a descendant that creates a new session. Nonzero exit is returned to
the model as evidence; it does not bypass the downstream verifier. If descendant termination cannot
be confirmed, Flow durably records that fact, closes further command authority, aborts the model
session, rejects any later durable command preparation, and prevents terminal node success. The template intentionally has no fresh-recovery
policy.

### Recover interrupted work

Inspect the durable state first, then resume with the exact workflow that started the run:

```sh
node dist/cli/main.js inspect interrupted-run
node dist/cli/main.js resume examples/verify-foundation.workflow.yaml --run-id interrupted-run
```

Flow normally continues only from a committed node boundary. It skips nodes whose success is
durable and records `run_resumed` before starting new work. An agent node may explicitly opt into
bounded fresh recovery:

```yaml
recovery: { mode: fresh, maxAttempts: 3 }
```

`maxAttempts` includes the initial attempt and must be between 2 and 16. Omission preserves the
default refusal behavior. A fresh attempt uses the original node prompt and current workspace in a
new in-memory Pi session; it does not restore the interrupted transcript, continue a tool call, or
repeat a provider request inside the old session.

Writable agent attempts declare a versioned effect protocol; each edit is durably prepared before
atomic rename and settled after the commit boundary.
`inspect` can therefore distinguish no observed edit, not applied, committed, and post-commit
unknown effects. If an interruption leaves a prepared edit open, `resume` coordinates with the same
target lock used by edits, compares the current regular-file hash and mode, and appends one typed
recovery observation: applied, not applied, or unknown with a bounded reason. A durable
`node_started` without a matching node outcome remains uncertain unless the exact compiled node
opted into fresh recovery and replay proves that attempt applied no effects. Read-only attempts must
have no effect protocol or effects. Edit-capable attempts must have declared `flow.effects/v1`, and
every prepared edit must have settled or reconciled as `not_applied`. Flow then appends
`node_attempt_interrupted`, archives the old attempt and its effect provenance, appends
`run_resumed`, and starts the exact next attempt number. Applied, committed, unknown, open, legacy
writable, exhausted, or unconfigured attempts execute nothing. Repeating recovery does not
duplicate an observation or disposition.

An agent that selects `exec` cannot declare fresh recovery. Arbitrary commands are not classified
as read-only and have no general post-crash reconciliation proof. An open prepared command or an
open command-capable attempt therefore resumes only as `uncertain_operation`; Flow never replays
the argv automatically.

Because interrupted model usage, cost, and active duration are not authoritative, automatic fresh
recovery is also blocked whenever the run declares `maxModelTokens`, `maxCostUsd`, or
`maxExecutionMs`. A declared `maxNodeStarts` is supported only when it has capacity for the next
start. `recovery_retry_ineligible` identifies an opted-in attempt that lacks sufficient proof or
budget; `uncertain_operation` remains the result when recovery was omitted.
Terminal,
mismatched, corrupt, missing, or actively owned runs are also refused without changing committed
events. New runs also bind the normalized execution directory. Approval waits are safe committed
boundaries: an undecided request remains waiting, a valid grant starts once, and an unused expired
grant returns to a fresh request. Budget limits, consumption, and exact approval timeouts are also
revalidated; recovery terminalizes a committed exhausted settlement without rerunning its node. See
[Recovery and interruption safety](docs/recovery.md) for the complete contract.

Detached execution changes who owns the live process, not the recovery rules. A worker remains the
exclusive scheduler and run-ledger owner. If it disappears after `node_started` but before an
outcome, a later resume applies the same opt-in proof gate; it never repeats unconfigured or
ambiguous work.

Policy-package recovery is also closed over durable evidence. Flow revalidates the exact stored
manifest bytes and effective constraints before resumed work. It does not reload `.flow/policies`
or an installed bundle. The current trusted configuration must select the same policy package
names, versions, and digests as the run history. A mismatch stops recovery before claim or
execution.

## Security boundary

Each command and descendant receives workspace write access, a private temporary directory, an
explicit environment allowlist, and no network. Flow denies reads of the canonical project `.flow`
directory and the actual run store. Flow denies writes to those paths, `.git`, environment files,
and key files. If the sandbox is unavailable or reports degraded isolation, Flow does not spawn the
command. Agent-issued commands add a stricter lifecycle gate:
only verified Linux PID-namespace containment can authorize process creation.

When `agent.toolApproval.exec.mode` is `required`, Flow adds a human authorization boundary between
policy allowance and command preparation. The owner-only decision sidecar is transport only; the
append-only ledger remains authoritative. Approval never widens the declared tool set, policy
decision, sandbox profile, filesystem scope, network denial, timeout, or descendant-containment
requirements.

Policy packages add only declarative narrowing before these enforcement points. They do not replace
the policy broker, approval ledger, sandbox, budget accounting, or provider boundary. A workflow or
model cannot select a policy package, and a package cannot turn a denied operation into an allowed
one.

Flow does not trust a bare `bwrap` resolved through the model-visible `PATH`. The Linux adapter pins
one canonical root-owned executable outside the workspace and fails before SRT initialization if no
such executable is available.

On Linux, Flow explicitly re-exposes the canonical packaged SRT seccomp helper as a read-only
runtime-support file when Flow is installed outside the selected workspace. The rest of the user
home remains denied.

Child workspaces are owner-only reflink-or-copy snapshots that exclude Flow and run-store state and
are discarded after terminal settlement. They prevent child mutations from changing the parent
working tree, but they are not atomic filesystem snapshots or security sandboxes. Child command
processes still use SRT; host-side Pi agent sessions still have the invoking user's host authority
subject to the Flow tool broker. Use a stronger backend for hostile child workloads.

Agent nodes are different: the host-side Pi runtime runs with the invoking user's operating-system
permissions and receives only explicitly declared Flow-owned `read`, `ls`, `edit`, and `exec` tools. Reads
return a full-file SHA-256 version. An edit must name that version and exact unique replacements for
one existing UTF-8 file; stale versions fail rather than merge. Flow preflights the complete edit,
coordinates cooperating same-host Flow processes, atomically replaces the target, protects the run
store, nested `.flow` and `.git` state, environment files, and key files, and records separate
authorization decisions, write-ahead durable evidence, and before/after terminal receipts. A prepare
event is synced before rename. While journal publication remains available, settlement is synced as
committed only after directory sync, as not applied before rename, or as unknown after a post-rename
failure. A rejected settlement append poisons the attempt journal and leaves the prepared effect
unresolved rather than inventing an outcome. Replay requires every prepared edit, including a
not-applied edit, to retain its distinct allowed write decision. Recovery observations remain
separate from executor settlements: matching the after-state later does not prove that the original
directory sync or model turn completed and blocks fresh recovery. Only an exact before-state
observation (or executor-settled not-applied effect), together with the node's persisted opt-in
policy and all other eligibility checks, can support a separate interruption disposition. Reconciliation
hashes only the bounded size observed before opening the no-follow handle, in fixed chunks totaling
at most 8 MiB, while holding the shared target lock. If the target's parent has also disappeared and
the sibling lock cannot exist, only a still-missing classification may be published; any observable
target remains open. Recovery persists no file bytes or raw OS error text and never repairs the
target. Directory
listings consume one logical policy authorization rather than one decision per entry. `flow_exec`
accepts no shell text, environment override, working-directory override, stdin, PTY, or background
mode. It requires an exact `process.execute` decision and write-ahead command journal, then delegates
to the fixed SRT profile described above. Create, delete, rename, shell, and network tools are not
exposed. Filesystem operations are canonically resolved and authorized by the Flow
policy broker. Pi's ambient tools, extensions, skill discovery, templates, context discovery,
built-in edit semantics, and executable-downloading helpers are disabled. Explicit Flow-selected
Agent Skills instead use immutable provider-neutral snapshots and bounded `skill://` reads; they
grant no filesystem or execution authority. Verifier packages are inert manifests captured in the
same snapshot; they execute only by resolving to the existing command or zero-tool model verifier
boundary and cannot widen either driver's authority. Workflow packages are inert source manifests;
the closed snapshot resolver feeds them back through the standard compiler and they cannot add
hooks, policy, providers, or sandbox authority.

Supervisor control state is stored in an owner-only directory under the selected run root. Its
Unix-domain sockets use a short owner-only temporary path so valid deep project paths also work on
macOS. Random worker tokens and identity handshakes prevent stale PID metadata from authorizing
control. These controls coordinate trusted processes of one operating-system user; they are not a
sandbox against that same user or root.

SRT is a beta native sandbox rather than a microVM. Use a reviewed container, microVM, Gondolin,
OpenShell, or managed sandbox for hostile workloads. Read the [security policy](SECURITY.md) before
running unattended work.

## Product thesis

A coding model is not a workflow engine, authorization boundary, evidence store, or recovery
system. Flow separates those responsibilities:

- Models solve bounded tasks inside workflow nodes.
- A deterministic scheduler controls graph transitions.
- Independently-ledgered child workflows isolate bounded delegated work and return typed results.
- A policy broker controls model-requested operations.
- A sandbox confines command filesystem/network access; Linux PID namespaces contain agent-command process lifecycles.
- An append-only event ledger records authoritative run state.
- A local supervisor owns detached process discovery and control without owning graph transitions.
- Durable resource accounting and run budgets stop further work at replayable boundaries.
- Mutation-free evaluation decides whether deterministic evidence accepts each criterion.
- Provider-specific behavior remains behind execution adapters.

The compiled graph—not model prose—decides what runs next. A confident completion narrative cannot
override missing or failing evidence.

## Documentation

- [Architecture](docs/architecture.md)
- [Local ACP v1 bridge](docs/acp.md)
- [Capability sourcing](docs/capability-sourcing.md)
- [Configuration](docs/configuration.md)
- [Workflow specification](docs/workflow-spec.md)
- [Recovery and interruption safety](docs/recovery.md)
- [Testing and evaluation](docs/testing-and-evaluation.md)
- [Reproducible harness evaluation](docs/evaluation.md)
- [Delivery roadmap](docs/roadmap.md)

## Community

- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
