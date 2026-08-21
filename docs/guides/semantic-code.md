# Use read-only semantic code queries

Use Flow's semantic code tool when an agent needs diagnostics, definitions, references, or hover
information from a language server. This guide explains how to select one exact server, declare
semantic access in a workflow, run the workflow, and inspect its bounded evidence.

This feature is available in current source builds. The hosted runtime acceptance test covers
Linux x64. The feature doesn't make a language-server result authoritative workflow evidence.

## Before you begin

You need:

- A built Flow source tree.
- A Flow project and workflow.
- A local language-server executable that supports LSP 3.18 over standard input and output.
- The SHA-256 digest of the exact executable.
- A supported native Flow sandbox.

Flow doesn't find servers on `PATH` or read editor configuration. You select one manifest for each
new run that declares the `semantic` tool.

## Create a language-server manifest

Create a manifest such as `.flow/language-servers/typescript.json`:

```json
{
  "apiVersion": "flow.synapti.ai/v1alpha1",
  "kind": "LanguageServer",
  "metadata": {
    "name": "typescript"
  },
  "spec": {
    "protocol": "lsp-3.18",
    "executable": "/opt/flow/bin/typescript-language-server",
    "executableSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "args": ["--stdio"],
    "languages": [
      {
        "id": "typescript",
        "suffixes": [".ts", ".tsx"]
      }
    ],
    "containmentProfile": "default",
    "requestTimeoutMs": 5000
  }
}
```

Replace the executable path and digest with values from your host. Keep arguments fixed. If the
server requires initialization settings, add a bounded JSON `initializationOptions` value under
`spec`.

Flow reopens the manifest and executable before it creates run state. It binds the canonical
manifest bytes, executable digest, file identity, arguments, language mappings, initialization
settings, containment profile, and timeout into the immutable capability snapshot.

## Declare semantic access

Add `semantic` to the agent's tool list:

```yaml
apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata:
  id: semantic-review
nodes:
  - id: analyze
    type: agent
    agent:
      prompt: Check src/example.ts for diagnostics and inspect the definition of value.
      model:
        provider: anthropic
        id: claude-sonnet-4-20250514
      tools: [semantic]
  - id: publish
    type: result
    dependsOn: [analyze]
    result:
      source:
        nodeId: analyze
        field: agent.text
      schema:
        type: string
        maxLength: 4096
```

The model receives the `flow_semantic` tool only when the workflow declares `semantic`. The tool
accepts these operations:

| Operation | Required input | Result |
| --- | --- | --- |
| `diagnostics` | One project-relative path | Sorted diagnostics with severity, range, code, and message |
| `definition` | One path and zero-based position | Sorted, unique project locations |
| `references` | One path and zero-based position | Sorted, unique project locations |
| `hover` | One path and zero-based position | Bounded plain-text or Markdown hover information, or no result |

Paths must use canonical forward-slash notation and stay inside the admitted project snapshot.

## Validate and run

Validate the workflow and server together:

```sh
flow validate semantic-review.workflow.yaml \
  --language-server .flow/language-servers/typescript.json
```

Start an attached run:

```sh
flow run semantic-review.workflow.yaml \
  --language-server .flow/language-servers/typescript.json
```

You can also add `--detach` to a new run. A resumed run uses the language-server identity stored in
its run snapshot. `flow resume` doesn't accept a replacement manifest.

Flow rejects these configurations before model or durable run mutation:

- A semantic workflow without a selected server.
- A non-semantic workflow with an unexpected server.
- More than one `--language-server` option.
- A changed manifest or executable.
- An unsupported protocol, language mapping, argument, path, or timeout.

## Understand isolation and evidence

Flow creates a bounded private copy of the admitted project for each query. At every directory
depth, it excludes `.flow`, `.git`, `node_modules`, `dist`, `coverage`, and Flow workspace
collections. The language server can read the copy, but the selected sandbox denies writes and
network access. Flow starts one server process for one request and terminates the process tree after
shutdown. The selected timeout starts before source capture and covers projection, sandbox
preparation, protocol work, source revalidation, and receipt preparation. Cleanup continues with
independent settlement authority after timeout or cancellation.

After the query, Flow captures the authoritative project again. It discards the result if the
project digest changed. It records a receipt only after protocol shutdown, process-tree
termination, source currentness, and sandbox release all settle.

An internal receipt binds:

- The normalized request and result.
- The project and selected-file digests.
- The exact language-server snapshot digest.
- The sandbox backend, version, profile, and policy digest.
- The receipt sequence and canonical receipt digest.

Public run output doesn't include source paths, diagnostic messages, hover text, or raw server
data from the receipt. It shows the operation, item count, digests, and sandbox identity.

## Know the limits

| Limit | Maximum |
| --- | ---: |
| Project entries | 4,096 |
| One project file | 1 MiB |
| Total copied project bytes | 16 MiB |
| Project depth | 32 levels |
| Results per operation | 512 |
| Semantic receipts per agent attempt | 16 |
| One persisted normalized result | 1 MiB |
| One inbound LSP message | 1 MiB |
| One outbound LSP request envelope | 8 MiB |
| Inbound LSP messages per query | 64 |
| Inbound JSON depth | 32 levels |
| Inbound JSON nodes | 50,000 |
| Observed server standard error | 64 KiB |
| Request timeout | 30 seconds |

The manifest can select a smaller request timeout. Flow doesn't truncate a semantic result into a
valid-looking partial result. It rejects an over-limit request or response.

## Handle failures

Flow returns fixed categories without raw server errors, standard error, absolute paths, source
text, configuration values, or nested causes.

| Category | Meaning | Action |
| --- | --- | --- |
| `semantic_service_unavailable` | The selected server identity or launch boundary isn't current. | Recheck the executable, manifest, permissions, and sandbox. Then start a new run with a newly admitted snapshot. |
| `semantic_operation_unsupported` | The selected server doesn't advertise the requested operation. | Select a compatible server or remove that operation from the workflow. |
| `semantic_request_invalid` | The operation, path, position, source, or language mapping is invalid. | Correct the request or the manifest language mapping. Don't broaden path access. |
| `semantic_source_changed` | The project changed during capture or query. | Inspect concurrent project changes, then retry the query in a new attempt. |
| `semantic_protocol_failed` | The server violated the admitted LSP subset or exited incorrectly. | Check server compatibility with LSP 3.18 over standard input and output. |
| `semantic_deadline_exceeded` | The request exceeded the manifest timeout. | Fix server startup or project-index cost. Select a reviewed timeout only if the bounded work requires it. |
| `semantic_response_limit_exceeded` | The project, output, standard error, or receipt count exceeded a bound. | Reduce the selected project surface or split the work. Don't bypass the bound. |
| `semantic_cleanup_uncertain` | Process-tree or sandbox settlement couldn't be confirmed. | Stop and inspect the host. Don't retry until you resolve the cleanup state. |

Caller cancellation uses the enclosing agent's fixed `pi_agent_aborted` code. The semantic adapter
preserves the exact caller reason internally and restores it only after confirmed cleanup. Flow
doesn't retry a failed semantic request or fall back to an uncontained server.

## Security boundary

Semantic results are advisory context for the model. They cannot grant policy authority, approve
an operation, mutate a file, select the next node, verify a goal, or prove completion. Downstream
deterministic evidence or a verifier must establish those outcomes.

The native sandbox is not a VM-grade hostile multi-tenant boundary. Read the
[security policy](../../SECURITY.md) before you use Flow for unattended or high-impact work.

For the normative workflow and receipt contract, read the
[workflow specification](../workflow-spec.md). For component ownership and trust boundaries, read
the [architecture](../architecture.md).
