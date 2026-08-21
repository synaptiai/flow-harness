# Prime runtime operations

This runbook prepares the Linux x64 Prime Agent evaluation profile and the higher-isolation
container command profile.

Do not use this procedure for the credential-free first run. Follow
[Getting started](../getting-started.md) instead.

## Safety boundary

Use this profile only on a dedicated, reprovisionable runner. Do not use a shared development host.
Do not use a host that serves Kubernetes or other `containerd` clients.

This procedure changes Docker, `containerd`, systemd, and the host core pattern. Version one does
not record enough prior state for safe in-place rollback.

Recreate the runner from its trusted base image to roll back.

The container profile shares the Linux kernel and Docker daemon. It is not VM-grade isolation for
hostile workloads.

## Required host

### Platform and daemon

- Linux x64.
- Docker Engine 28.3.3 with Docker API 1.51.
- cgroup v2 and the systemd cgroup driver.
- Local Docker socket at `/var/run/docker.sock`.
- No Docker socket activation.
- A non-piped host core pattern.

### Network, storage, and capacity

- IPv6 loopback support in the private container network namespace.
- One whole block device for Docker image storage and `io.max`.
- Capacity for the fixed Prime resource policy.

The verified version-one acceptance profile also requires:

- `containerd.io` 1.7.27-1.
- `/usr/bin/runc` from that package.
- `runc` 1.2.5 commit `v1.2.5-0-g59923ef`.
- One Docker-managed `containerd` child.
- Docker's canonical PID records under `/run/docker`.

A different path, version, commit, daemon endpoint, or runtime argument is outside this profile.
Flow does not resolve `runc` through `PATH`. It requires the admitted `/usr/bin/runc` path.

## Configure the Docker runtime

Configure the dedicated `flow-prime-runc` runtime with no arguments:

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

The daemon configuration must not set these options:

- `containerd`
- `containerd-namespace`
- `containerd-plugins-namespace`
- `hosts`
- `exec-root`
- `pidfile`

Flow also rejects custom daemon configuration-file paths and related command options.

For systemd, disable socket activation and the separate `containerd` service:

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

## Verify daemon ownership

Confirm that Docker owns the managed `containerd` process:

```sh
docker_pid="$(cat /run/docker.pid)"
containerd_pid="$(cat /run/docker/containerd/containerd.pid)"
test "$(ps --no-headers --pid "$containerd_pid" --format ppid | xargs)" = "$docker_pid"
```

Confirm the admitted versions and runtime:

```sh
test "$(/usr/bin/runc --version | sed --quiet '1p')" = 'runc version 1.2.5'
test "$(/usr/bin/runc --version | sed --quiet '2p')" = 'commit: v1.2.5-0-g59923ef'
test "$(docker version --format '{{.Server.APIVersion}}')" = '1.51'
test "$(docker version --format '{{.Server.Version}}')" = '28.3.3'
test "$(docker info --format '{{.DefaultRuntime}}')" = 'flow-prime-runc'
```

## Publish the protected runtime observation

Flow runs as a non-root user. Publish the protected observation that binds both live processes to
their canonical paths and hashes:

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

The observation contains host-sensitive process and executable identity. Keep it outside public run
evidence.

## Prepare the image

Build Flow first, then initialize the selected project:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/main.js init .
node dist/cli/main.js runtime prepare prime-agent
node dist/cli/main.js doctor --profile prime-agent
```

Preparation performs two image builds and compares their identities. It stores local host evidence
under the project `.flow` directory.

A fixed-stage preflight rejects an incompatible host before the first build. Preparation repeats
authoritative inspection after the second build. Evaluation does not build or pull an image.

The diagnostic reopens the prepared evidence and reports a fixed `prime.runtime` result. It doesn't
create, start, stop, or remove a container. Read
[Diagnose the Flow environment](../guides/diagnose-environment.md) for the report contract.

## Run the Prime evaluation profile

Validate the example before execution:

```sh
node dist/cli/main.js eval validate examples/evaluation/native-prime-agent-comparison.evaluation.yaml
node dist/cli/main.js eval run examples/evaluation/native-prime-agent-comparison.evaluation.yaml
node dist/cli/main.js eval inspect native-prime-comparison
```

Prime runs in one fixed OCI image. Python receives no provider credential or external network route.
The host broker makes model requests. Flow removes the container before accepting a terminal result.

Read [Reproducible harness evaluation](../evaluation.md) for the plan, identity, broker, and evidence
contracts.

## Select the container command profile

Only a trusted operator can select the profile. Add this field to the operator configuration:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowOperatorConfig
sandbox:
  profile: container
```

Use `${XDG_CONFIG_HOME}/flow/config.yaml`. When `XDG_CONFIG_HOME` is absent, use
`${HOME}/.config/flow/config.yaml`.

Do not place this field in `.flow/config.yaml`. Project configuration cannot select or widen
sandbox authority.

Inspect the effective result:

```sh
node dist/cli/main.js config show
```

The effective policy digest changes with the profile. An active supervisor must become idle and
stop before it can bind the new digest.

Read [Configuration](../configuration.md) for operator ceilings and policy changes.

## Container profile behavior

The `flow-container-v1` profile starts one container per command. It preserves the exact executable
and argument vector without a shell.

The selected workspace is the only read-write bind. Explicit runtime support paths are read-only.
Flow masks protected `.flow`, credential, key, and environment paths before container creation.

Before Docker create, Flow records a durable intent under `.flow/container-command-intents`. The
intent binds the complete submitted Docker configuration, policy digest, and bounded workspace
content snapshot. Flow rechecks the workspace immediately before launch.

Flow attaches before start and verifies the full container ID. It records bounded task output only.
Docker control text does not become task output or an exit code.

A control failure after possible start reports uncertain command effects. Confirmed container
absence does not undo earlier workspace writes.

The container has no external network route. The profile also denies local TCP and Unix socket
creation. It does not grant Docker socket access to the command.

Read [Architecture](../architecture.md) and the [Security policy](../../SECURITY.md) for the exact
namespace, mount, cgroup, filesystem, process, and cleanup boundaries.

## CI-only second-user proof

The full release gate creates a second Docker-authorized user. This proves daemon-wide admission
across authorized users:

```sh
sudo useradd --create-home --groups docker flow-prime-peer
export FLOW_PRIME_TEST_SECOND_USER=flow-prime-peer
npm run ci:local
```

This step is for a dedicated release runner. It is not required for ordinary Flow use.

The hosted workflow is the executable reference for the exact accepted host. See
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).

## Failure and remediation

- A failed preflight changes no Docker image state.
- An uncertain preparation requires inspection of the project runtime evidence.
- An uncertain container cleanup blocks another Prime trial on that daemon.
- A policy or identity mismatch rejects before task authority.
- A changed daemon, runtime, image device, cgroup, or protected observation requires new preparation.

Do not relax capabilities, seccomp, namespaces, read-only root policy, or cgroup controls to bypass
a fixed failure stage. Diagnose the named invariant first.

Read [Recovery and interruption safety](../recovery.md) before manual cleanup of uncertain Prime
state.
