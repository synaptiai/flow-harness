# Decision: bounded replay-safe typed workflow results

Status: accepted for Issue #42

## Context

Flow needs a typed information boundary before it can safely compose isolated child runs,
optimization metrics, or package workflows. Existing source fields are bounded durable strings.
They carry attempt and hash identity, but JSON-shaped text is neither schema-checked nor canonical.

The existing condition decision anticipated boolean, numeric, enum, and schema-aware results. The
child-run roadmap requires typed results, and optimization requires numeric metrics. Implementing a
child-only output shape now would create a second evidence model and force parent orchestration to
trust prose or duplicate parsing rules.

## User, operator, and system flows

### User: declare a result

1. The author adds a pure result step after one evidence-producing direct dependency.
2. The declaration selects one complete durable source field and a bounded closed schema.
3. Compilation rejects incompatible sources, unsafe schemas, excessive complexity, and topology
   that could bypass the source.
4. After dependencies settle, Flow validates the source as strict I-JSON-compatible JSON.
5. A valid value is canonicalized and recorded; the result step succeeds and may release dependent
   work. Invalid input creates a typed control failure and releases nothing.

### User: inspect or consume a result

1. Attached and detached inspection expose the canonical value, schema digest, value hash, and
   source identity.
2. Later conditions, approvals, verifiers, loop checks, and child-run parents can select the
   canonical `result.value` field through the same direct-dependency rules as other evidence.
3. No consumer receives a provider object, mutable JavaScript object, or unvalidated raw value.

### Operator: resume after interruption

1. Recovery replays the persisted graph and source evidence.
2. A committed result is independently re-parsed, schema-checked, canonicalized, and hash-checked.
3. A missing result transition is deterministically recomputed from the already-committed source.
4. No command, model, package, or workspace operation is repeated.

### System: fail closed

1. Cancellation and resource exhaustion are checked before the pure transition.
2. Truncated, malformed, duplicate-key, oversized, Unicode-invalid, number-invalid, or
   schema-incompatible input becomes a typed failure. Omitted, failed, or absent dependencies retain
   ordinary graph precedence and never produce a result transition.
3. Replay rejects any mutation of the schema, source, canonical value, hash, event order, or node
   outcome.

## Existing invariants

- Only the compiler creates graph topology.
- Pure control transitions are evaluated only when no executable wave is in flight.
- Control transitions consume no node starts, model usage, command duration, policy decisions, or
  workspace effects.
- Source consumers require compatible direct dependencies and bind source node, attempt, field,
  hash, and truncation state.
- The run ledger, not an executor transcript, is authoritative.
- The compiled control projection is bounded to 524288 bytes and each run event to 2097152 bytes.
- Omitted dependencies propagate omission unless an explicit validated control structure handles
  them.

## Research findings

- RFC 8259 permits implementations to differ when object names repeat. `JSON.parse` keeps the last
  value, so Flow must reject duplicates before ordinary parsing, including escape-equivalent names.
- `JSON.parse` accepts a syntactically valid exponent that overflows to `Infinity`; I-JSON/JCS
  requires finite IEEE-754 values.
- `JSON.parse` accepts lone UTF-16 surrogates. JCS requires invalid Unicode to terminate
  canonicalization.
- RFC 8785 canonicalization uses ECMAScript primitive serialization, no emitted whitespace,
  recursive object-property sorting by raw UTF-16 code units, and unchanged array order.
- JavaScript default string sorting matches the required UTF-16 code-unit comparison. A direct
  canonical string builder avoids prototype mutation from special object names.
- The pinned TypeBox interpreter can reject missing required and additional properties, but it does
  not provide the complete duplicate-key/I-JSON/canonicalization boundary. The implementation keeps
  the deliberately small schema evaluator inside Flow rather than generating or executing validator
  code.
- A 262144-byte canonical result is 12.5% of the 2097152-byte event ceiling, leaving 1835008 bytes
  for metadata and framing. Even when considered beside the independent 524288-byte control graph
  ceiling, 1310720 bytes remain below the event envelope. The actual event-size validator remains
  authoritative.
- Temporal child workflows have separate histories and local state; they therefore need an
  explicit parent-visible result. OMP combines isolated tasks with output schemas. Neither makes
  its transcript authoritative for Flow replay.

## Approaches considered

| Approach | Strengths | Weaknesses | Disposition |
| --- | --- | --- | --- |
| Child-node-only opaque result | Smallest child implementation | Prose boundary, duplicated output system, unusable by ordinary workflows | Rejected |
| Workflow-level output projection | Familiar service/workflow API; naturally one terminal output | Failure does not map to an ordinary graph node; awkward branching/loop reuse and recovery state | Rejected for first slice |
| Pure typed result control node | Reuses dependencies, omission, direct-source identity, typed control failures, replay, loops, and inspection | Adds a control event and graph node; output declaration is explicit | Selected |
| Full JSON Schema 2020-12 | Broad ecosystem compatibility and tooling | References, regexes, unions, annotations, dialects, and evaluation semantics expand the attack and compatibility surface | Rejected for core v1alpha1 |
| External package validator | Extensible and reusable | Gate 6 provenance/permissions do not exist; would make child-run safety depend on executable package code | Deferred |

## Decision

Add a pure guarded `result` control node. It selects one compatible direct-dependency evidence
field, validates it against a strict Flow-owned closed JSON-schema subset, emits a canonical JSON
string plus provenance hashes, and succeeds without entering `NodeExecutor`.

The supported schema vocabulary is deliberately bounded:

- `null`
- `boolean`
- `number` with optional finite minimum/maximum
- `integer` with optional safe-integer minimum/maximum
- `string` with an explicit bounded maximum length
- `array` with one item schema and explicit bounded maximum items
- `object` with bounded identifier-keyed properties, an explicit unique required list, and no
  additional properties

Schemas may nest to depth 8, contain at most 128 schema nodes, and serialize within a fixed schema
byte ceiling. Values may contain at most a fixed total number of nodes and canonicalize to at most
262144 UTF-8 bytes. The compiler normalizes defaults and property order before freezing the schema.
It stores the result declaration in the control projection.

Strict input parsing first uses duplicate-key detection, then JSON parsing. Validation rejects
non-finite numbers, unsafe values for integer schemas, lone surrogates in values and keys, excessive
value complexity, unknown object properties, and every schema mismatch. Canonicalization follows
RFC 8785 for the supported I-JSON subset: literals and numbers use ECMAScript JSON serialization,
strings preserve Unicode, arrays retain order, and object keys sort recursively by UTF-16 code
units.

A successful durable transition records:

```text
nodeId, attempt=1,
sourceNodeId, sourceAttempt, sourceField, sourceHash,
schemaDigest,
canonicalValue, valueHash
```

The reducer resolves the declared source from earlier state, repeats strict parsing, schema
validation and canonicalization, compares every identity/hash, and only then succeeds the node.
Control failure uses the existing pure-control failure event with stable result-specific codes.

Add `result.value` as a typed evidence-source field containing canonical JSON. Conditions and loop
checks may compare it exactly; approvals and model verifiers may bind it; a later child node may
import it without a new parsing contract. Rejected or failed nodes remain unavailable as sources.

Permit result nodes at top level and in bounded loop bodies. Permit a result node to be terminal.
Do not permit goal criteria to bind it because result validity is not task acceptance; goals remain
bound to deterministic commands or typed verifiers.

## Coupling analysis

```text
workflow YAML -> schema/compiler -> compiled result declaration
                                      |
                                      v
                              persisted control graph
                                      |
durable source -> scheduler pure transition -> canonical result event
                                      |                    |
                                      +---------> reducer replay validation
                                                           |
                                                    inspect/next consumer
```

- Workflow domain owns the result schema vocabulary, structural bounds, source compatibility, and
  immutable compiled declaration.
- Run domain owns strict JSON parsing, schema validation, canonicalization, hashes, event legality,
  and replay projection.
- Application owns only readiness, source resolution, and publication of the pure transition.
- Infrastructure, Pi, command containment, policy, packages, and the supervisor do not validate or
  reinterpret the value.
- CLI and detached workers transport ordinary workflow/run state and need no separate result
  authority.

Dependency direction remains UI/infrastructure -> application -> domain. The domain imports no Pi,
filesystem, supervisor, or package implementation.

## Failure modes

| Failure mode | Required behavior |
| --- | --- |
| Unknown, self, indirect, or incompatible source | Compilation fails before run creation |
| Unsafe or excessive schema | Compilation fails with a bounded path-specific diagnostic |
| Source omitted or failed | Ordinary dependency omission/failure semantics apply; no result is recorded |
| Source has no successful durable evidence | Ordinary omission/failure precedence applies; an impossible or corrupt succeeded-without-evidence state is rejected during replay |
| Source truncated | Typed side-effect-free failure before parsing |
| Duplicate JSON key, including escape-equivalent spelling | Typed invalid-JSON failure |
| Invalid JSON or trailing prose | Typed invalid-JSON failure |
| Non-finite number, unsafe integer, or lone surrogate | Typed I-JSON failure |
| Schema mismatch or unknown property | Typed schema-mismatch failure with bounded diagnostic |
| Value or canonical event too large | Typed limit failure before append; no partial result |
| Event append fails | Durable prefix remains authoritative; source is not re-executed |
| Crash after result append | Replay restores the committed result; no republish |
| Crash before result append | Resume recomputes the pure result from the committed source |
| Forged event or source/schema mutation | Replay rejects at the offending event |
| Cancellation before evaluation | Run cancellation wins and result is absent |
| Resource exhaustion before evaluation | Resource exhaustion wins and result is absent |
| Concurrent executable wave | Pure result waits for wave quiescence |
| Dependency/library failure | Fail closed; no permissive parser or raw-string fallback |

## Non-goals

- This slice does not create child workspaces, spawn child runs, or import child results.
- It does not implement optimization direction, metrics, selection, promotion, or rollback.
- It does not implement full JSON Schema, `$ref`, patterns, formats, unions, conditionals, defaults,
  coercion, transforms, or remote schemas.
- It does not expose JSONPath, arbitrary expressions, field projection, or dynamic schema mutation.
- It does not make result validation executable package code.
- It does not treat a valid result as goal acceptance.
- It does not turn worktree or process separation into a security sandbox.

## Acceptance verification map

| Contract | Verification | Expected evidence |
| --- | --- | --- |
| Strict schema and topology | Compiler tests | Valid recursive closed schemas compile; invalid bounds/sources/terminals/loops reject |
| Strict JSON and I-JSON | Domain unit tests plus RFC vectors | Duplicate/escaped keys, overflow, unsafe integers, lone surrogates, trailing prose reject |
| Canonical identity | Domain unit/property tests | Equivalent object order/whitespace canonicalizes identically; arrays retain order; hashes match |
| Pure transition | Scheduler tests | Result records after quiescence with zero executor calls and zero resource increase |
| Failure behavior | Scheduler/reducer adversarial tests | Truncation, malformed input, mismatch, cancellation, exhaustion, omission, and mutation fail closed |
| Replay and recovery | Reducer/application tests | Committed result never republishes; missing transition recomputes without source execution |
| Composition | Attached and detached integration tests | Run/inspect/resume expose identical result facts without credentials |
| Compatibility | Snapshot/regression tests | Workflows without results retain compiled and runtime behavior |
| Public contract | Documentation tests and executable example | README/spec/architecture/recovery/security/testing/roadmap agree with behavior |
| Release | Full source/runtime/coverage/package/audit/actionlint gates | All configured gates pass |

## Planned RED -> GREEN -> REFACTOR sequence

1. RED: strict result schema/source/compiler cases and legacy snapshot compatibility.
2. GREEN: source and compiled types, bounded recursive schema, field compatibility, loop remapping,
   terminal allowance, and control projection.
3. RED: strict JSON, I-JSON, canonicalization, schema validation, hash, and RFC vector tests.
4. GREEN: pure domain parser/validator/canonicalizer with iterative complexity preflight.
5. RED: result event/reducer success, ordering, source identity, hash, schema, resource, and mutation
   cases.
6. GREEN: event schema, state projection, control-graph validation, and replay transition.
7. RED: scheduler quiescence, success/failure, conditions, approvals, verifiers, loops, omission,
   cancellation, exhaustion, and recovery.
8. GREEN: deterministic result transition and reusable `result.value` source resolution.
9. RED/GREEN: attached CLI and detached-worker integration, inspection, and example.
10. REFACTOR/VERIFY: centralize duplicated source resolution, update every public claim, run mutation
    probes, adversarial review, full suites, coverage, build, package installation, audit, and
    action lint.

## Primary references

- RFC 8259, JSON Data Interchange Format: https://www.rfc-editor.org/rfc/rfc8259
- RFC 8785, JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- Temporal child workflows: https://docs.temporal.io/child-workflows
- AWS nested workflows: https://docs.aws.amazon.com/step-functions/latest/dg/concepts-nested-workflows.html
- OMP task and isolated output contract: https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md
- Git worktree lifecycle: https://git-scm.com/docs/git-worktree
- Prime Agent long-running workers: https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/long-running-agents.md

## Consequences and remaining uncertainty

- The result contract becomes reusable infrastructure for child runs and optimization instead of a
  child-only special case.
- The schema subset deliberately sacrifices full JSON Schema compatibility for bounded replay and
  reviewability. Gate 6 may add package validators, but they cannot replace the durable core result.
- Canonical JSON is stored rather than a mutable object representation. Consumers must explicitly
  parse after integrity validation.
- The 256 KiB result limit is conservative relative to the event envelope but should be challenged
  with package/artifact use cases before v1 stability.
- JSON numbers remain IEEE-754. Exact decimals and integers outside the safe range must be strings
  until a tagged decimal type is designed.
- A later child-run decision must choose dirty-workspace snapshot and promotion semantics; this
  result slice intentionally does not preselect them.
