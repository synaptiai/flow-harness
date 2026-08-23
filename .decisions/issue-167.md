# Decision Journal: Issue #167 — Qualify ACP interoperability and publish operator guidance

**Issue**: #167 | **Branch**: `codex/issue-167-acp-qualification` | **Started**: 2026-08-23

---

## Context

Slice 10.1b executes one exact local Agent Client Protocol (ACP) runtime behind Flow's
prompt-only containment boundary. Slice 10.1c asks whether two independent production ACP agents
can complete the same admitted work. Both agents must use equal provider, model, reasoning, prompt,
budget, retry, network, and verification controls.

The existing evaluation engine already owns paired scheduling, immutable plan and trial identity,
isolated workspaces, private verification, missing-metric semantics, durable ledgers, inspection,
and export. Its current verdict answers a different question: whether a candidate is superior to a
baseline. ACP qualification instead asks whether both exact executor identities conform. The
implementation can reuse evaluation mechanics, but it must not reuse superiority semantics.

The official ACP Registry provides discovery and installation metadata. Its registry checks and
protocol matrix do not prove authenticated prompt completion, Flow containment, private output
quality, complete usage evidence, or paired control equivalence. Flow therefore treats registry
metadata as operator input, never as qualification evidence.

## User, operator, and system flows

### Operator qualification flow

1. The operator installs two exact production ACP agents and authors project-relative manifests.

2. The operator authors one ACP qualification plan. It selects the same workflow, task, provider,
   model, reasoning setting, prompt, budgets, retry policy, and network policy for both profiles.

3. `flow eval validate` admits both current agent identities. It rejects unequal controls, identical
   executors, unsupported platforms, unavailable models, missing accounting, or a workflow outside
   the prompt-only contract.

4. `flow eval run` executes the paired schedule through ordinary Flow workflow execution and the
   existing ACP executor.

5. `flow eval inspect` and `flow eval export` report a qualification verdict and exact public
   identities. They also report output verification, latency, usage completeness, failures, and
   limitations.

### Auditor flow

1. An auditor opens an exported evaluation package without provider credentials or live executors.

2. Flow verifies the immutable plan header, trial hash chain, paired schedule, and workflow digest.
   It also verifies capability digests, verifier identity, and report derivation.

3. Missing or inconsistent evidence produces `insufficient_evidence` or `not_qualified`. This
   evidence never produces an interoperability claim.

### Failure and recovery flow

1. A malformed, drifting, over-limit, authority-seeking, hanging, abruptly closing, or
   descendant-leaking peer fails with one bounded ACP outcome.

2. Flow terminates the process group and preserves the existing uncertain-effect semantics where
   an effect might already have occurred.

3. The evaluation ledger records the failed trial. The operator can inspect or export its durable
   evidence. A rerun requires a valid admitted plan and current exact identities.

## Architecture decision

### Options considered

1. **Extend the evaluation engine with an ACP qualification purpose.** Reuse admission, scheduling,
   trial records, storage, replay, inspection, and export. Add qualification-specific profile
   admission, output verification, and verdict derivation.

2. **Create a dedicated `flow acp qualify` subsystem.** Define separate plans, ledgers, stores,
   reports, replay, and CLI paths for ACP.

3. **Publish a runtime compatibility test and generated report.** Test two agents from a harness
   without durable qualification semantics in Flow.

### Decision

Use option 1. It preserves one evidence architecture and one ordinary workflow execution path.
The new behavior is explicit and narrow:

- An `EvaluationPlan` can declare the `acp-interoperability-v1` purpose.

- Each of its two `flow-workflow-v1` profiles selects the same workflow and a different
  project-relative ACP agent manifest.

- Admission creates two exact capability snapshots, proves equal comparison controls and workflow
  identity, and proves different ACP executor identities.

- An `agent-result-v1` private verifier evaluates the durable workflow result. It does not grant
  filesystem authority or expose expected output in the task workspace.

- Qualification produces `qualified`, `not_qualified`, or `insufficient_evidence`. It keeps the
  existing candidate-superiority verdict unchanged.

Option 2 duplicates mature durability and replay code and creates two meanings for evaluation
evidence. Option 3 cannot support an auditable interoperability claim because a passing runtime
test alone does not preserve paired identities, private verifier evidence, or complete limitations.

### Coupling and dependency direction

- Domain evaluation types define qualification plan and verdict contracts. They do not import ACP
  infrastructure.

- Local admission resolves ACP manifests into capability snapshots and binds them to existing Flow
  evaluation profiles.

- The application evaluation adapter extracts only the admitted workflow result observation. It
  does not know expected output.

- The trial runner gives the result observation to the domain verifier and persists only bounded
  verification evidence.

- ACP protocol and sandbox implementations remain below the existing `AgentExecutor` boundary.

- CLI presentation consumes the report. It does not derive qualification independently.

No circular dependency is introduced: CLI/infrastructure -> application -> domain remains the
direction of travel.

### Consequences

- Existing comparison plans and their digests remain unchanged when they omit the new purpose and
  profile field.
- Qualification plans can use the existing `flow eval validate`, `run`, `inspect`, and `export`
  lifecycle.
- A production claim remains impossible until two live agents complete all required paired trials
  with complete required evidence.
- Supporting an agent that advertises commands might require distinguishing inert ACP metadata from
  actual tool activity. Any such change must retain tool-call rejection and sandbox containment.

## Specification

_Captured by specification-capture skill on 2026-08-23. Source: mixed issue contract, roadmap,
existing ACP executor contract, and three-approach analysis._

### Non-goals

- Do not expand the prompt-only ACP authority contract with filesystem, terminal, MCP, elicitation,
  editor, or unrestricted network authority.

- Do not make the ACP Registry, package availability, initialization success, or a skipped live test
  sufficient evidence of interoperability.

- Do not compare providers, models, reasoning settings, prompts, budgets, retries, network policies,
  workflows, tasks, fixtures, verifiers, seeds, or ordering.

- Do not treat duplicate agent identities, simulated peers, or versions of one executor as two
  independent production agents.

- Do not add automatic network installation, unpinned `latest` dependencies, ambient home-directory
  credentials, or secret values to durable evidence.

- Do not replace the existing candidate-superiority evaluation contract or change comparison-plan
  meaning.

- Do not claim ACP v2, remote ACP transport, editor interoperability, tool-capable executor
  interoperability, VM-grade isolation, or hostile multi-tenant isolation.

- Do not turn the root README into an operator manual. Canonical ACP and evaluation guides contain
  the detailed procedures.

### Failure modes

- **Timeouts** — initialization, session setup, configuration, prompt execution, cancellation,
  process exit, cleanup, and each qualification trial retain fixed deadlines. A timeout terminates
  the process tree, records a bounded failure, and prevents qualification.

- **Partial failures** — one successful executor or an incomplete pair remains a durable partial
  result. The report returns `insufficient_evidence` or `not_qualified`, never `qualified`.

- **Invalid input** — Malformed plans, unequal controls, duplicate identities, and unsupported
  verifiers fail at validation. Invalid expected digests, protocol violations, drift, and excessive
  output also fail without coercion or fallback.

- **Missing context** — Missing credentials, agent artifacts, platform support, model mapping, or
  required usage evidence prevents qualification. The same rule covers missing sandbox support or
  an incomplete paired schedule.

- **Dependency outage** — provider, agent, sandbox, or host-runtime failure records a harness
  failure. Flow does not retry through a different provider, model, agent, or containment path.

- **Resource exhaustion** — Trial count, output bytes, protocol frames, execution duration,
  artifact bytes, token usage, and cost remain bounded. Descendant cleanup is also bounded. Resource
  limits stop the affected attempt and prevent qualification.

### Interface contracts

- `EvaluationPlan.purpose`, when present, is exactly `acp-interoperability-v1`. Omission preserves
  existing comparison semantics and identity.

- Each qualification profile is `flow-workflow-v1` with exactly one `workflow` and one `acpAgent`
  project-relative manifest. Both profiles name the same workflow source. Their admitted workflow
  digests must match and their admitted ACP agent digests must differ.

- Qualification uses exactly two ordered profile identities and the ordinary paired-alternating
  task/seed schedule. The plan's model, budget, network, and retry controls apply identically.

- `agent-result-v1` binds a private expected SHA-256 digest and byte count. Admission requires the
  workflow result to source one agent text field. The adapter returns a bounded result observation.
  Raw expected output never enters the isolated workspace or model prompt.

- A qualification report includes its purpose, verdict, and required and completed pair counts. It
  includes workflow, capability, verification, latency, usage, failure, and limitation evidence.

- `qualified` requires two verified successes in every required paired trial. Each pair must have
  equal controls, one workflow identity, different ACP executor identities, and confirmed
  termination. It must also have no policy violation and complete required metrics.

- `not_qualified` means complete evidence proves at least one required conformance failure.
  `insufficient_evidence` means the required evidence is missing, skipped, unsupported, unavailable,
  or incomplete.

- Unsupported platforms, missing credentials, unavailable models, incomplete accounting, and
  absent production agents cannot create trial success. They cannot create qualification evidence.

## Criterion verification map

### Criterion 1: Deterministic independent peer

- **Type**: Behavioral and protocol contract.
- **Command**: `npx vitest run test/unit/infrastructure/acp/acp-agent-session.test.ts test/integration/process/acp-agent-executor.test.ts`.
- **Expected evidence**: The deterministic peer completes initialization, session setup,
  configuration, streamed prompt output, and usage. It also completes cancellation and confirmed
  shutdown.
- **Does not promise**: production-agent interoperability or provider availability.

### Criterion 2: Adversarial peers

- **Type**: Error handling and security boundary.
- **Command**: `npx vitest run test/unit/infrastructure/acp/strict-acp-stream.test.ts test/unit/infrastructure/acp/acp-agent-protocol-stream.test.ts test/unit/infrastructure/acp/acp-agent-session.test.ts test/integration/process/acp-agent-executor.test.ts && npx vitest run --config vitest.runtime.config.ts test/runtime/acp-agent-sandbox.runtime.test.ts`.
- **Expected evidence**: Malformed frames, versions, undeclared authority, tool activity, drift,
  excessive output, hangs, and EOF fail closed. Surviving descendants also fail and settle cleanup.
- **Does not promise**: proof against a hostile kernel or remote process.

### Criterion 3: Two production agents under the same controls

- **Type**: Behavioral, configuration, and live integration.
- **Command**: `npx vitest run test/integration/cli/acp-qualification.test.ts && npm run test:live -- test/live/acp-qualification.live.test.ts`.
- **Expected evidence**: Two exact production agents complete the same admitted workflow. Both use
  equal provider, model, reasoning, prompt, budget, retry, network, task, verifier, seed, and
  ordering.
- **Does not promise**: qualification when credentials, models, platforms, or agents are absent.

### Criterion 4: Different executor identity and same workflow identity

- **Type**: Contract and data integrity.
- **Command**: `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts test/integration/cli/acp-qualification.test.ts`.
- **Expected evidence**: Admission rejects equal executor digests and unequal workflow digests. It
  retains two distinct capability digests in the immutable plan identity.
- **Does not promise**: organizational independence beyond the exact executable/package identities.

### Criterion 5: Qualification report completeness

- **Type**: Data processing and schema.
- **Command**: `npx vitest run test/unit/evaluation/aggregate.test.ts test/unit/evaluation/records.test.ts test/integration/cli/acp-qualification.test.ts`.
- **Expected evidence**: Reports contain output verification, latency, usage completeness,
  failures, limitations, and one closed qualification verdict. Missing metrics remain null or
  unavailable and cannot contribute to `qualified`.
- **Does not promise**: model-quality generalization beyond the admitted task suite.

### Criterion 6: Explicit unsupported and missing-evidence outcomes

- **Type**: Error handling and configuration.
- **Command**: `npx vitest run test/unit/evaluation/aggregate.test.ts test/unit/infrastructure/fs/local-acp-qualification-plan.test.ts test/integration/cli/acp-qualification.test.ts`.
- **Expected evidence**: Unsupported platforms, credentials, models, and accounting produce bounded
  validation, skip, failure, or insufficient-evidence reasons and never `qualified`.
- **Does not promise**: automatic installation, credential acquisition, or model fallback.

### Criterion 7: Operator documentation

- **Type**: Documentation contract.
- **Command**: `npx vitest run test/scaffold/community-files.test.ts && npm run docs:style && npm run docs:links && npm run docs:ste`.
- **Expected evidence**: The canonical ACP guide separates the editor bridge from the executor. It
  covers installation, manifests, qualification, containment, recovery, limitations, and
  troubleshooting in Google-style prose.
- **Does not promise**: detailed guidance in the root README.

### Criterion 8: Architecture and repository map

- **Type**: Architecture documentation.
- **Command**: `npx vitest run test/integration/package/architecture-documentation.test.ts test/scaffold/community-files.test.ts`.
- **Expected evidence**: Mermaid and repository map show agent selection, process containment,
  protocol flow, and admitted identities. They also show verifier evidence, durable stores, and
  report ownership.
- **Does not promise**: a code-level class diagram for every module.

### Criterion 9: Generated references and operational documents

- **Type**: Generated-reference and documentation contract.
- **Command**: `npm run docs:capabilities:generate && npm run docs:capabilities:check && npx vitest run test/scaffold/community-files.test.ts`.
- **Expected evidence**: Capability references, project status, roadmap, testing, and recovery agree
  with production behavior. Regeneration does not change generated artifacts.
- **Does not promise**: hand-edited generated files.

### Criterion 10: Concise README

- **Type**: Documentation structure.
- **Command**: `npx vitest run test/scaffold/community-files.test.ts`.
- **Expected evidence**: README contains one concise ACP qualification link and does not duplicate
  the operator procedure.
- **Does not promise**: standalone operation without following the canonical guide.

### Criterion 11: Full and hosted verification

- **Type**: Build, package, runtime, and hosted environment.
- **Command**: `npm run ci:local && npm run pack:check && npm run test:runtime` locally, followed by the repository quality and dependency-audit workflows on Ubuntu 24.04 x64.
- **Expected evidence**: Local quality, package contents, runtime containment, documentation, and
  hosted Linux x64 jobs pass from the final commit.
- **Does not promise**: hosted qualification with secrets that are unavailable to pull requests.
