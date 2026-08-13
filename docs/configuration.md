# Configuration

Flow uses strict, versioned operator and project documents. Configuration is resolved before a
detached state mutation, and `flow config show` reports the effective values, source provenance,
selected project root, and canonical policy digest without starting a supervisor or provider.

## Initialize and inspect

```sh
flow init [directory]
flow config show
```

`flow init` atomically creates `<directory>/.flow/config.yaml` with the minimal project document:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowProjectConfig
```

It preserves an existing target unless `--force` is explicit. Symbolic-link and non-file targets
are refused. Project discovery begins at the invocation directory and selects the nearest ancestor
containing `.flow/config.yaml`; that ancestor becomes the default root for `.flow/runs`. An explicit
`--runs-dir` remains relative to the invocation directory.

## Capacity policy

The built-in policy permits one active detached worker and 32 queued jobs. An operator can set a
different ceiling in `${XDG_CONFIG_HOME}/flow/config.yaml`, or `${HOME}/.config/flow/config.yaml`
when `XDG_CONFIG_HOME` is absent:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowOperatorConfig
supervisor:
  maxActiveWorkers: 4
  maxQueuedJobs: 128
```

A project can omit either field or narrow the operator ceiling:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowProjectConfig
supervisor:
  maxActiveWorkers: 2
  maxQueuedJobs: 16
```

`maxActiveWorkers` must be an integer from 1 through 64. `maxQueuedJobs` must be an integer from 0
through 1024; zero rejects overflow immediately. Unknown fields, duplicate YAML keys, invalid
versions or kinds, and values outside these bounds fail with source and field diagnostics. A
project value above its operator—or built-in—ceiling is `unsafe_widening`; it is never silently
clamped.

The merge law is field-specific:

```text
effective = project value ?? operator value ?? built-in value
project value <= operator value ?? built-in value
```

This is not a generic last-wins deep merge. Equivalent effective values produce the same SHA-256
policy digest regardless of comments or source paths.

## Sandbox profile

The native profile is the built-in default. It uses the fixed SRT backend. A trusted operator can
select the Linux x64 container command profile:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: FlowOperatorConfig
sandbox:
  profile: container
```

Project configuration cannot select a sandbox profile. A workflow also cannot select, replace, or
widen it. An unknown profile or a project `sandbox` field is invalid configuration. Flow does not
fall back to the native profile after such an error.

The container selection requires the prepared Prime OCI runtime and image evidence described in
the README. It uses the fixed `flow-container-v1` policy. The selection changes the canonical
policy digest. `flow config show` reports the effective profile and source without loading Docker.
An active supervisor keeps its original digest until the operator retires that idle generation.

Each container command also records a command-specific sandbox policy digest. It is the canonical
digest of the complete submitted Docker configuration, including the attested fixed-policy label,
bounded workspace snapshot, workspace protections, and effective resource controls. This command
evidence does not change who can select the profile and does not expose the private configuration.

## Applying a policy change

A live supervisor is bound to its effective digest and exact limits. Changing a contributing file
does not hot-reload the generation. Stateful commands fail with `policy_mismatch` until existing
active and queued work reaches idle and the old generation is explicitly retired:

```sh
flow supervisor status
flow supervisor shutdown
flow supervisor status
```

Shutdown refuses non-idle admission. An explicit idle shutdown archives the old admission ledger;
the next stateful command starts a generation bound to the newly resolved policy. Do not hand-edit
the admission ledger or private supervisor metadata. Offline policy retirement is not implemented:
if the old supervisor already exited, temporarily restore the previous effective values, start that
generation, let it reconcile to idle, and run `flow supervisor shutdown` before applying the new
values again.

## Authority and secrets

The current schema contains no credential or secret fields. Optional private OCI package access is
an explicit install-time CLI input. It is not configuration and is not persisted. Operator
configuration can widen the conservative built-in defaults only within hard schema caps. Project
configuration can narrow but cannot widen that operator authority.

Capacity policy coordinates
trusted processes of one local operating-system user. It is not a sandbox, distributed quota,
provider billing limit, or security boundary against that same user or root.
