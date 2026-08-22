# Retain and inspect command artifacts

Flow keeps command output in two forms:

- A bounded preview remains in the run ledger and model context.
- Flow can retain exact bytes when bounded command output exceeds the preview limit. Command
  evidence then contains an opaque `artifact:` reference.

Use retained artifacts when a command result is too large for model context. You can inspect that
exact evidence later or let an agent read a bounded window.

## Understand the boundary

Flow currently retains truncated stdout and stderr from agent-issued commands. Each retained stream
has these limits and identities:

| Property | Contract |
| --- | --- |
| Maximum retained command stream | 1 MiB |
| Maximum artifact object | 16 MiB |
| Maximum agent read | 32 KiB for each `flow_artifact` call |
| Maximum immutable references in one project catalog | 4,096 |
| Byte identity | SHA-256 digest and exact byte count |
| Media type | `application/octet-stream` |
| Producer identity | Run, workflow, node, attempt, command, command sequence, and stream |
| Default retention | `retained` |

Flow doesn't create a reference when a stream fits in the existing preview. Flow also doesn't create
a partial reference when a command stream exceeds the 1 MiB capture limit. The existing bounded
preview and full-stream hash remain available in both cases.

Retention requires a configured Flow project root. A standalone run keeps the existing preview and
full-stream hash, but it doesn't create an artifact store or reference.

Command capture is in memory until publication. Flow admits at most 32 concurrent workflow nodes.
Two maximum-size command streams per node contribute at most 64 MiB of raw capture. Normal buffer
and publication overhead is additional. The larger 16 MiB object limit is reserved for producers
that publish without crossing the command executor's in-memory boundary.

The run artifact budget and retained-artifact storage serve different purposes. The run budget
counts logical terminal evidence used for scheduling. The project artifact store controls physical
availability and garbage collection. Retaining a content-addressed blob doesn't increase or reset a
run budget.

Pruning frees physical blob bytes. It doesn't remove immutable reference metadata or recover a
catalog slot. Before a long-lived project reaches 4,096 references, archive the project and continue
in a new project root. Don't delete individual catalog records. Reviewed catalog archival and
segmentation remain future work.

## Let an agent read retained bytes

Select the `artifact` tool on a node that might need to reopen truncated command output:

```yaml
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Run the check. If its output is truncated, inspect only the required artifact windows.
      model: { provider: anthropic, id: claude-sonnet-4-5 }
      tools: [exec, artifact]
      timeoutMs: 120000
```

If you select a policy package with tool constraints, allow both the tool name and the distinct read
permission:

```yaml
tools:
  allowed: [artifact, exec]
  allowedPermissions: [artifact.read, process.execute]
```

The command result includes a line such as:

```text
stdout artifact: artifact:0123456789abcdef...
```

The `flow_artifact` tool accepts the opaque reference, a zero-based byte offset, and a positive
`maxBytes` value of at most 32 KiB. It returns base64 bytes and window metadata. The model cannot
provide another run ID. Flow derives the run from the policy broker and rejects cross-run access.

Artifact bytes are untrusted command output. Decode or interpret them only in a bounded component
that is appropriate for their actual format.

## Inspect retention and availability

List the bounded catalog when you don't have a reference from run evidence:

```sh
flow artifacts list
```

The list contains immutable reference metadata and current retention only. It doesn't read every
blob or report availability. This keeps recovery discovery bounded even when the catalog contains
many maximum-size artifacts.

Inspect one reference:

```sh
flow artifacts inspect artifact:<sha256>
```

The command returns immutable descriptor and producer metadata plus these mutable fields:

- `retention` is `retained` or `released`.
- `availability` is `available`, `missing`, `changed`, or `pruned`.

Inspection never returns artifact bytes or a local storage path. A missing, changed, or pruned blob
doesn't invalidate its historical reference. Flow preserves the reference as unresolved evidence and
rejects reads.

## Release or retain a reference

Release one reference when the project no longer needs its bytes:

```sh
flow artifacts release artifact:<sha256>
```

Restore retention before pruning:

```sh
flow artifacts retain artifact:<sha256>
```

Identical bytes can have several producer references. Flow removes the shared blob only after every
reference to that digest is released.

These commands change the artifact catalog. They don't rewrite the append-only run ledger.

## Preview and apply pruning

Create a read-only prune plan:

```sh
flow artifacts prune
```

Review the exact descriptor list and save `planDigest`. Then apply that exact plan:

```sh
flow artifacts prune \
  --apply \
  --expected-plan-digest <sha256>
```

Flow rejects the apply operation if any publication or retention change made the plan stale. The
plan also includes safe finalized blobs that were published before a crash but never gained a
catalog reference.

Reads and mutations use one nonblocking project lock. While a read is active, another artifact
operation reports that the store is busy. Retry after the reader settles. Cancellation before the
first durable mutation changes no catalog authority. After Flow publishes a catalog or removes the
first blob in an approved prune plan, it settles that operation. It then returns the verified result
without checking the cancelled signal again.

## Recover an interrupted artifact operation

Flow serializes reads, publication, retention changes, and pruning with
`.flow/artifacts/mutation.lock`. It automatically settles recognized temporary blob links left by an
interrupted publication.

If Flow reports `artifact commit is uncertain`, don't assume that the operation failed or retry it
blindly. Run `flow artifacts list`, inspect the affected references, and create a fresh prune
preview. Apply only the newly reviewed plan digest. If Flow reports
`artifact store settlement is uncertain`, stop all project Flow processes and use the lock
remediation procedure below before you run another artifact command.

A process can also stop after catalog publication but before its run event is durable. The retained
reference remains visible in `flow artifacts list`. Compare its producer tuple with the run ledger.
Release it only after you confirm that no durable run evidence needs the bytes.

If a process stops while it owns the mutation lock, later commands report `artifact store is busy`.
Before you remove the lock:

1. Stop all Flow processes that use the project.
2. Back up `.flow/artifacts`.
3. Confirm that no Flow process still owns the project.
4. Remove only `.flow/artifacts/mutation.lock`.
5. Run `flow artifacts list`, then inspect affected references.
6. Run a prune preview and review every descriptor before you apply it.

Don't edit `catalog.json`, blob filenames, or blob bytes. A symbolic link, extra hard link,
non-regular file, changed digest, changed byte count, or unsafe directory makes the store fail
closed.

## Privacy and trust

### Public projection

- Flow-generated run, event, approval, presentation, and export fields contain only existing bounded
  previews, opaque references, and safe metadata. They don't embed retained blobs or local paths.
- An agent can quote or transform a byte window after an authorized `flow_artifact` read. Selecting
  the tool therefore grants bounded disclosure authority through the agent's normal output.

### Local storage and identity

- Treat `.flow/artifacts` and its backups as sensitive local data. Flow uses owner-only local files,
  but it doesn't encrypt artifact bytes at rest.
- An artifact digest identifies bytes. It doesn't authorize access and doesn't prove who produced
  them.
- The immutable producer reference supplies provenance. The mutable catalog supplies current
  retention and availability.

### Authority rules

- Only the explicitly selected `artifact` tool can request a policy-controlled read.
- Only an operator command can list, inspect, retain, release, or prune artifacts.

For interruption and uncertainty rules, read [Recovery and interruption safety](../recovery.md).
For the ownership model, read [Architecture](../architecture.md).
