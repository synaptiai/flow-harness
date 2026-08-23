# Decision Journal: Issue #163 — Generate the production capability reference

**Issue**: #163 | **Branch**: `codex/issue-163-capability-reference` | **Started**:
2026-08-23

---

## Context

Flow has six built-in model tools, six capability-package families, an open model-provider seam,
and four closed evaluation adapters. Their public names, schemas, limits, defaults, availability,
and authority properties currently live across workflow validation, production composition, package
discovery, runtime adapters, and hand-maintained documentation.

The documentation checks validate structure, style, links, and clarity. They do not prove that the
public reference matches the surface that production registers. The evaluation guide already
demonstrates this drift class: one built-in-adapter roster omits Prime although production admits
`prime-agent-native-v1`.

## Architecture alternatives

Scores are ordinal design judgments from one to five, not runtime measurements.

| Approach | Production parity | Determinism | Semantic coverage | Simplicity | Selected |
| --- | ---: | ---: | ---: | ---: | --- |
| A. Reflect the complete runtime composition | 5 | 2 | 3 | 3 | No |
| B. Share production descriptors and prove final parity | 5 | 5 | 5 | 4 | Yes |
| C. Generate runtime code and docs from a data specification | 4 | 5 | 3 | 2 | No |

### Refined Approach B decision

The user approved refined Approach B. Pure immutable descriptors become inputs to production
composition and to a content-only public projection. An independent integration test constructs the
final built-in tool definitions with inert dependencies and compares their normalized public surface
with the descriptors. This asymmetry prevents the registry and generated documentation from drifting
together unnoticed.

The public projection produces one versioned JSON catalog and one generated Markdown reference.
Verification renders both in memory and compares exact bytes with the committed files. Intentional
generation is a separate write operation. Neither operation constructs the complete CLI dependency
container or consults installed packages, credentials, network services, absolute paths, clocks, or
environment-specific provider availability.

## Specification

_Captured by specification-capture skill on 2026-08-23. Source: user-confirmed._

### Non-goals

- Do not enumerate locally installed capability packages or dynamic package-tool instances.

- Do not promise a closed inventory of model providers, models, credentials, pricing, or current
  provider availability.

- Do not generate a complete CLI command reference or inventory every internal limit.

- Do not describe ACP as an execution provider before Gate 10.1.

- Do not add an executable plugin surface, runtime generation during installation, or a stable
  pre-1.0 compatibility promise.

- Do not change model-visible tool names, descriptions, schemas, or declared order merely to improve
  documentation.

- Do not copy generated catalog tables or detailed guidance into the root README.

### Failure modes

- **Timeouts** — none: reference construction is pure and bounded, with no network, subprocess,
  provider, or runtime dependency that can time out. Existing command timeout values remain public
  catalog data only.

- **Partial failures** — intentional generation must compute and validate both complete artifacts
  before replacing either destination. A failed validation or write cannot report success. The
  read-only check must not change either destination.

- **Invalid input** — duplicate identifiers, unsupported schema values, non-finite numbers,
  environment-derived data, and invalid descriptors fail before publication. The error is bounded
  and actionable.

- **Missing context** — absent reference files, production descriptors, or parity registrations
  fail verification. The error identifies the stale or absent surface. Generation doesn't use
  ambient host state to fill missing data.

### Interface contracts

- The machine-readable catalog has one explicit Flow catalog version and one explicit JSON Schema
  Draft 2020-12 dialect. It contains deterministic arrays for built-in tools, capability families,
  ordinary execution seams, evaluation adapters, and referenced public limits.

- Each built-in tool entry binds its workflow selector, model-facing name, label, description, and
  input schema. It also binds authority classes, availability requirements, execution mode, and
  stable public-limit identifiers. Referenced limits bind an identifier, exact value, and unit. They
  also bind a scope and optional default.

- The Markdown reference is a deterministic projection of the same catalog. It has a generated-file
  notice. It distinguishes schema assertions from explanatory runtime behavior. It links to
  canonical task and architecture guidance.

- Production tool construction consumes the same descriptors. The final normalized tool name,
  label, description, execution mode, and parameter schema must equal the descriptor projection.

- Tool packages remain a documented extension ABI. Installed names and manifests do not enter the
  repository reference.

- Ordinary model execution and evaluation adapters are separate seams. The ordinary provider and
  model namespace remains open. Evaluation adapter identifiers form a closed production registry.

- Rendering uses UTF-8, LF line endings, and stable code-unit ordering. It omits generation time and
  adds one terminal newline. The check-only operation compares exact bytes without writing.

## Criterion verification map

### Criterion 1: Built-in tool contracts

- **Type**: contract and behavioral
- **Command**: `npm test -- test/unit/domain/capability/public-capability-reference.test.ts`
- **Expected evidence**: all six tools appear once. They include exact schemas, limits, defaults,
  prerequisites, and authority classes. Duplicate and invalid descriptors fail.
- **Does not promise**: package-tool instance enumeration or model-output schemas.

### Criterion 2: Capability families and provider seams

- **Type**: contract
- **Command**: `npm test -- test/unit/domain/capability/public-capability-reference.test.ts`
- **Expected evidence**: all six package families and four evaluation adapters appear. The ordinary
  provider seam remains open and environment-free.
- **Does not promise**: live provider or credential availability.

### Criterion 3: Deterministic generation

- **Type**: data processing
- **Command**: `npm test -- test/unit/application/public-capability-reference.test.ts`
- **Expected evidence**: repeated generation produces byte-identical JSON and Markdown with stable
  ordering and no host-dependent fields.
- **Does not promise**: RFC 8785 conformance or cryptographic signing.

### Criterion 4: Read-only drift verification

- **Type**: error handling and configuration
- **Commands**:
  - `npm test -- test/integration/package/public-capability-reference.test.ts`
  - `npm run docs:capabilities:check`
- **Expected evidence**: committed artifacts match without writes. Mutation tests reject tool,
  schema, limit, family, and seam drift. Each error names the affected artifact.
- **Does not promise**: automatic repair during verification.

### Criterion 5: Independent production parity

- **Type**: behavioral and contract
- **Command**: `npm test -- test/integration/pi/workspace-agent-tool-reference.test.ts`
- **Expected evidence**: all final built-in definitions match the independent normalized reference
  and workflow-selectable tool set.
- **Does not promise**: parity for operator-installed tool packages.

### Criterion 6: Documentation routing

- **Type**: configuration
- **Command**: `npm test -- test/integration/package/documentation-structure.test.ts`
- **Expected evidence**: the documentation hub and canonical capability guidance reach the
  generated reference. The README remains within its landing-page contract.
- **Does not promise**: a generated CLI command manual.

### Criterion 7: Published documentation quality

- **Type**: configuration and contract
- **Command**: `npm run docs:style && npm run docs:links && npm run docs:ste && npm run pack:check`
- **Expected evidence**: public documentation passes style, links, and clarity checks. Package
  verification evidence includes both generated artifacts.
- **Does not promise**: a stable API guarantee before 1.0.

## Adversarial review disposition

Three independent review facets challenged the implementation for security, composition drift, and
holdout contract gaps. The final implementation closes the confirmed findings:

- It distinguishes schema character ceilings from UTF-8 runtime byte ceilings. It publishes shared
  policy, command, effect, skill-resource, semantic-result, command-output, and artifact limits from
  their production constants.

- It bounds complete directory-list output and both generated artifacts. Verification opens only
  regular files through a no-follow, nonblocking path and rejects symlinked directory ancestors,
  special files, and oversized inputs.

- It validates public descriptors against closed values and Draft 2020-12 JSON Schema. It does not
  compile external schema identifiers into persistent validator state. Canonical JSON preserves
  every own property, including `__proto__`.

- It deep-freezes tool schemas and freezes every exported family and evaluation-adapter entry. The
  runtime derives built-in policy actions from the descriptors and verifies declared prerequisites.

- One selector-to-policy-action registry now drives descriptors, broker allowlists, and policy
  package admission. Production catalog composition adds the sandbox prerequisite from the same
  descriptor that constructs the sandbox-backed command executor.

- It enforces the distinct skill-resource ceiling before decoding or recording the 129th resource.
  Generator failures return bounded, fixed public messages without rejected values, host paths, or
  operating-system error codes. Controlled catalog failures include a safe section and array index.

- Direct mutations cover numeric limit defaults and JSON Schema defaults. Both Markdown and JSON
  projections must change, and exact-byte verification must identify both stale artifacts.

Focused tests reproduce each finding before the fix and now pass. The full repository gates remain
the release authority.

## Stranger test

A contributor unfamiliar with the implementation can identify the public and environment-neutral
surfaces. The contributor can also identify each drift failure and generated artifact. The listed
commands prove every acceptance criterion. Refined Approach B requires no further design choice.
