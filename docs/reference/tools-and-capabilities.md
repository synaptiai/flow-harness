<!-- Generated file. Do not edit directly. -->

# Tools and capabilities

This reference describes the public tools and capability seams registered by Flow production
composition. Regenerate it after you change a registered tool, schema, public limit, capability
family, or provider seam.

For behavior and security boundaries, read [Architecture](../architecture.md) and
[Use capability packages](../guides/capability-packages.md). For the exact machine-readable
contract, see
[Flow public capability catalog](../specs/flow-public-capability-catalog-v1.json).

Catalog version: `flow.public-capabilities/v1`

JSON Schema dialect: `https://json-schema.org/draft/2020-12/schema`

## Built-in model tools

| Workflow selector | Model-facing name | Authority | Availability |
| --- | --- | --- | --- |
| `artifact` | `flow_artifact` | read | artifact-store |
| `edit` | `flow_edit` | write | effect-recorder |
| `exec` | `flow_exec` | execute | command-recorder, production-sandbox |
| `ls` | `flow_ls` | read | Always |
| `read` | `flow_read` | read | Always |
| `semantic` | `flow_semantic` | read | language-server |

### `flow_artifact`

Read one bounded binary window from a retained command artifact owned by this run. Results are base64 encoded and never interpreted as text.

- Workflow selector: `artifact`
- Execution mode: `sequential`
- Policy actions: `artifact.read`
- Public limits: `artifact-maximum-bytes`, `artifact-read-window-bytes`, `policy-decisions-per-attempt`, `policy-target-bytes`

Input schema:

```json
{
  "additionalProperties": false,
  "properties": {
    "maxBytes": {
      "description": "Maximum bytes to return (default: 32768).",
      "maximum": 32768,
      "minimum": 1,
      "type": "integer"
    },
    "offset": {
      "description": "Zero-based byte offset (default: 0).",
      "maximum": 16777216,
      "minimum": 0,
      "type": "integer"
    },
    "reference": {
      "description": "Opaque artifact reference returned by Flow command evidence.",
      "pattern": "^artifact:[a-f0-9]{64}$",
      "type": "string"
    }
  },
  "required": [
    "reference"
  ],
  "type": "object"
}
```

### `flow_edit`

Atomically edit one existing UTF-8 workspace file using its flow_read SHA-256 version and exact, unique, non-overlapping replacements. Stale versions fail without automatic merging.

- Workflow selector: `edit`
- Execution mode: `sequential`
- Policy actions: `filesystem.write`
- Public limits: `agent-effects-per-attempt`, `edit-file-bytes`, `edit-input-characters`, `edit-input-total-bytes`, `edit-replacements`, `policy-decisions-per-attempt`, `policy-target-bytes`, `tool-path-bytes`, `tool-path-characters`

Input schema:

```json
{
  "additionalProperties": false,
  "properties": {
    "edits": {
      "description": "Exact, unique, non-overlapping replacements matched against the same original content.",
      "items": {
        "additionalProperties": false,
        "properties": {
          "newText": {
            "description": "Replacement text.",
            "maxLength": 262144,
            "type": "string"
          },
          "oldText": {
            "description": "Exact, non-empty text that occurs once in the current file.",
            "maxLength": 262144,
            "type": "string"
          }
        },
        "required": [
          "oldText",
          "newText"
        ],
        "type": "object"
      },
      "maxItems": 32,
      "minItems": 1,
      "type": "array"
    },
    "expectedSha256": {
      "description": "Full SHA-256 version returned by flow_read for this file.",
      "pattern": "^[a-f0-9]{64}$",
      "type": "string"
    },
    "path": {
      "description": "Path to one existing UTF-8 file inside the Flow workspace.",
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "path",
    "expectedSha256",
    "edits"
  ],
  "type": "object"
}
```

### `flow_exec`

Execute one bounded executable and literal argument vector in Flow's production sandbox. No shell, environment overrides, cwd overrides, stdin, PTY, background mode, or network access are available.

- Workflow selector: `exec`
- Execution mode: `sequential`
- Policy actions: `process.execute`
- Public limits: `agent-commands-per-attempt`, `exec-argument-bytes`, `exec-arguments`, `exec-arguments-total-bytes`, `exec-artifact-bytes-per-stream`, `exec-executable-bytes`, `exec-output-bytes-per-stream`, `exec-timeout-milliseconds`, `policy-decisions-per-attempt`, `policy-target-bytes`

Input schema:

```json
{
  "additionalProperties": false,
  "properties": {
    "args": {
      "default": [],
      "description": "Literal argument vector passed without shell expansion (default: empty).",
      "items": {
        "maxLength": 8192,
        "type": "string"
      },
      "maxItems": 64,
      "type": "array"
    },
    "executable": {
      "description": "Executable name or path. Shell syntax is not supported.",
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    },
    "timeoutMs": {
      "description": "Command deadline in milliseconds (default: 120000).",
      "maximum": 600000,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "executable"
  ],
  "type": "object"
}
```

### `flow_ls`

List workspace directory contents alphabetically, including dotfiles and '/' suffixes for directories. Output is bounded to 500 entries by default and 50 KiB.

- Workflow selector: `ls`
- Execution mode: `default`
- Policy actions: `filesystem.list`
- Public limits: `ls-entries`, `ls-output-bytes`, `policy-decisions-per-attempt`, `policy-target-bytes`, `tool-path-characters`

Input schema:

```json
{
  "additionalProperties": false,
  "properties": {
    "limit": {
      "description": "Maximum entries to return (default: 500).",
      "maximum": 5000,
      "minimum": 1,
      "type": "integer"
    },
    "path": {
      "description": "Directory to list (default: current workspace directory).",
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

### `flow_read`

Read a UTF-8 text file inside the Flow execution workspace or an explicitly selected immutable skill:// resource. Workspace results include a full-file SHA-256 version for flow_edit. Binary and image decoding is not supported.

- Workflow selector: `read`
- Execution mode: `default`
- Policy actions: `filesystem.read`
- Public limits: `policy-decisions-per-attempt`, `policy-target-bytes`, `read-distinct-skill-resources-per-attempt`, `read-output-bytes`, `read-output-lines`, `read-skill-resource-bytes`

Input schema:

```json
{
  "properties": {
    "limit": {
      "description": "Maximum number of lines to read",
      "type": "number"
    },
    "offset": {
      "description": "Line number to start reading from (1-indexed)",
      "type": "number"
    },
    "path": {
      "description": "Path to the file to read (relative or absolute)",
      "type": "string"
    }
  },
  "required": [
    "path"
  ],
  "type": "object"
}
```

### `flow_semantic`

Query one operator-selected language server for bounded diagnostics, definitions, references, or hover information. The tool cannot edit files or run model-selected commands.

- Workflow selector: `semantic`
- Execution mode: `sequential`
- Policy actions: `filesystem.read`
- Public limits: `policy-decisions-per-attempt`, `policy-target-bytes`, `semantic-code-bytes`, `semantic-hover-bytes`, `semantic-message-bytes`, `semantic-path-bytes`, `semantic-path-characters`, `semantic-position`, `semantic-queries-per-attempt`, `semantic-result-bytes`, `semantic-result-items`

Input schema:

```json
{
  "additionalProperties": false,
  "properties": {
    "character": {
      "description": "Zero-based character for definition, references, or hover.",
      "maximum": 10000000,
      "minimum": 0,
      "type": "integer"
    },
    "line": {
      "description": "Zero-based line for definition, references, or hover.",
      "maximum": 10000000,
      "minimum": 0,
      "type": "integer"
    },
    "operation": {
      "anyOf": [
        {
          "const": "diagnostics",
          "type": "string"
        },
        {
          "const": "definition",
          "type": "string"
        },
        {
          "const": "references",
          "type": "string"
        },
        {
          "const": "hover",
          "type": "string"
        }
      ]
    },
    "path": {
      "description": "Portable path to one admitted project file.",
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "operation",
    "path"
  ],
  "type": "object"
}
```

## Public limits

A default is runtime behavior only when the corresponding implementation applies it. JSON
Schema `default` annotations alone don't insert a value.

| Identifier | Limit | Default | Scope |
| --- | ---: | ---: | --- |
| `agent-commands-per-attempt` | 32 items | — | Maximum flow_exec and command-tool-package executions started in one agent attempt. |
| `agent-effects-per-attempt` | 32 items | — | Maximum flow_edit effect reservations in one agent attempt. |
| `artifact-maximum-bytes` | 16777216 bytes | — | Maximum retained artifact size. |
| `artifact-read-window-bytes` | 32768 bytes | 32768 bytes | Maximum bytes returned by one artifact read. |
| `edit-file-bytes` | 8388608 bytes | — | Maximum UTF-8 bytes in one edited file. |
| `edit-input-characters` | 262144 characters | — | Maximum Unicode code points in one old or replacement text schema value. |
| `edit-input-total-bytes` | 262144 bytes | — | Maximum combined UTF-8 bytes across every old and replacement text value. |
| `edit-replacements` | 32 items | — | Maximum exact replacements in one edit call. |
| `exec-argument-bytes` | 8192 bytes | — | Maximum UTF-8 bytes in one command argument. |
| `exec-arguments` | 64 items | — | Maximum arguments in one command call. |
| `exec-arguments-total-bytes` | 32768 bytes | — | Maximum combined UTF-8 bytes in one command argument vector. |
| `exec-artifact-bytes-per-stream` | 1048576 bytes | — | Maximum retained command artifact bytes for each output stream. |
| `exec-executable-bytes` | 1024 bytes | — | Maximum UTF-8 bytes in one executable value. |
| `exec-output-bytes-per-stream` | 32768 bytes | — | Maximum UTF-8 bytes returned inline for each command output stream. |
| `exec-timeout-milliseconds` | 600000 milliseconds | 120000 milliseconds | Maximum command deadline. |
| `ls-entries` | 5000 entries | 500 entries | Maximum requested directory entries. |
| `ls-output-bytes` | 51200 bytes | — | Maximum UTF-8 bytes returned by one directory listing. |
| `policy-decisions-per-attempt` | 64 items | — | Maximum authorization decisions shared by all policy-backed tools in one agent attempt. One workspace flow_read call normally records two decisions; skill:// reads record none. |
| `policy-target-bytes` | 1024 bytes | — | Maximum UTF-8 bytes in one policy authorization target. |
| `read-distinct-skill-resources-per-attempt` | 128 items | — | Maximum distinct skill:// resource receipts retained in one agent attempt. |
| `read-output-bytes` | 51200 bytes | 51200 bytes | Maximum text bytes returned by one underlying Pi read window. |
| `read-output-lines` | 2000 lines | 2000 lines | Maximum lines returned by one underlying Pi read window. |
| `read-skill-resource-bytes` | 131072 bytes | — | Maximum UTF-8 bytes returned for one admitted skill:// resource. |
| `semantic-code-bytes` | 256 bytes | — | Maximum UTF-8 bytes in one semantic code value. |
| `semantic-hover-bytes` | 16384 bytes | — | Maximum UTF-8 bytes in one hover value. |
| `semantic-message-bytes` | 4096 bytes | — | Maximum UTF-8 bytes in one semantic diagnostic message. |
| `semantic-path-bytes` | 1024 bytes | — | Maximum UTF-8 bytes in one normalized semantic query path. |
| `semantic-path-characters` | 1024 characters | — | Maximum Unicode code points in one semantic query path schema value. |
| `semantic-position` | 10000000 position | — | Maximum zero-based line or character position. |
| `semantic-queries-per-attempt` | 16 items | — | Maximum semantic query receipts retained for one agent attempt. |
| `semantic-result-bytes` | 1048576 bytes | — | Maximum serialized bytes retained for one semantic query result. |
| `semantic-result-items` | 512 items | — | Maximum diagnostics or locations returned by one semantic query. |
| `tool-path-bytes` | 1024 bytes | — | Maximum UTF-8 bytes in one validated edit path. |
| `tool-path-characters` | 1024 characters | — | Maximum Unicode code points in one list or edit path schema value. |

## Capability-package families

Flow discovers exact package instances from the current project and installed immutable
bundles. This repository reference describes the supported family contracts. It doesn't list
operator-installed instances.

| Kind | Name | Extension | Summary |
| --- | --- | --- | --- |
| `agent-skill` | Agent Skills | dynamic | Inert instructions and resources selected by exact package identity. |
| `policy-package` | Policy packages | dynamic | Inert policy narrowing that cannot grant authority beyond operator policy. |
| `presentation-package` | Presentation packages | dynamic | Inert A2UI-profile presentation metadata for supported Flow hosts. |
| `tool-package` | Command tool packages | dynamic | Declarative scalar inputs rendered through closed argv-only command profiles. |
| `verifier-package` | Verifier packages | dynamic | Inert command or model verification definitions admitted by exact identity. |
| `workflow-package` | Workflow packages | dynamic | Inert workflow sources compiled through the ordinary Flow workflow contract. |

## Provider and evaluation seams

### Ordinary model execution

| Seam | Implementation | Openness | Summary |
| --- | --- | --- | --- |
| `model-provider` | `pi` | open | Provider and model identifiers resolve through the embedded Pi adapter at runtime. |

Provider and model identifiers are runtime inputs. This reference doesn't promise that a
specific provider, model, credential, price, or availability state exists.

### Evaluation adapters

| Adapter | Isolation | Summary |
| --- | --- | --- |
| `flow-workflow-v1` | flow-runtime | Execute an admitted workflow through the ordinary Flow runtime. |
| `omp-native-v1` | local-process | Execute the pinned native OMP harness through a local process adapter. |
| `pi-native-v1` | local-process | Execute the pinned native Pi harness through a local process adapter. |
| `prime-agent-native-v1` | oci-container | Execute the admitted Prime Agent harness through its OCI runtime contract. |
