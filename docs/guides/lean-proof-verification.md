# Verify an exact Lean statement

Use Flow's optional Lean proof profile when a workflow must verify one exact formal statement. The
profile can accept an operator-provided proof or a proof proposed by one exact model route. In both
cases, the proof remains untrusted until compilation, kernel replay, an independent check, human
statement approval, and container cleanup succeed.

This feature has two independent questions:

- **Mathematical acceptance:** Does the submitted proof establish the exact Lean statement under
  the closed axiom policy?
- **Statement faithfulness:** Does that exact Lean statement represent the source specification
  that the operator intended?

Lean can answer only the first question. Flow requires a human approval for the second question.
A proof can't replace ordinary builds, tests, runtime checks, or other criterion evidence.

## Before you begin

You need:

- A Flow project on a supported Linux x64 Docker host.
- A prepared `.flow/proof-runtime/attestation.json` for that project.
- A bounded source specification, one exact namespaced Lean theorem or lemma header, and a separate
  Lean `by` proof term.
- An ordinary deterministic test or verification path for every non-proof requirement.

Read [Operate the Lean proof runtime](../operations/lean-proof-runtime.md) to prepare the appliance
and understand its containment boundary.

## Define the three proof inputs

Keep the inputs separate:

1. Write the source specification in human-readable language. Flow permits at most 65,536 UTF-8
   bytes.

2. Write one theorem or lemma header. Use a namespaced declaration such as
   `Flow.Proof.add_zero`. Don't include `:=` or a proof body. Flow permits at most 131,072 UTF-8
   bytes.

3. Write a separate proof that starts with `by`. Flow permits at most 262,144 UTF-8 bytes.

For example:

```text
Specification: For every natural number n, n plus zero is n.
Statement: theorem Flow.Proof.add_zero (n : Nat) : n + 0 = n
Proof: by
  omega
```

The first profile admits only `import Mathlib`. It rejects incomplete or executable metaprogramming
constructs such as `sorry`, `admit`, user `axiom` declarations, `unsafe`, `partial`, `run_tac`,
`initialize`, `#eval`, and `Lean.trustCompiler`. This source check is defense in depth. SafeVerify
and Nanoda remain the proof authorities.

## Add the proof verifier to a workflow

Create direct workflow dependencies for the specification, statement, proof, and approval. The
verifier reads only durable, untruncated outputs from those dependencies.

Use this structure as a template. Replace every angle-bracket value with the corresponding value
from `.flow/proof-runtime/attestation.json` and your source nodes:

```yaml
- id: approve-statement
  type: approval
  dependsOn: [specification, statement]
  approval:
    prompt: Confirm that the exact formal statement represents the exact source specification.
    evidence:
      - { nodeId: specification, field: command.stdout }
      - { nodeId: statement, field: command.stdout }

- id: verify-proof
  type: verifier
  dependsOn: [specification, statement, proof, approve-statement, ordinary-tests]
  verifier:
    kind: lean-proof
    targetDeclaration: Flow.Proof.add_zero
    specification: { nodeId: specification, field: command.stdout }
    statement: { nodeId: statement, field: command.stdout }
    proof: { nodeId: proof, field: command.stdout }
    faithfulnessApprovalNodeId: approve-statement
    timeoutMs: 300000
    runtime:
      version: 1
      platform: linux
      architecture: x64
      imageDigest: <attested OCI digest>
      buildAttestationDigest: <attestation digest>
      dependencyManifestDigest: <build-input manifest digest>
      leanVersion: 4.33.1
      mathlibRevision: <attested Mathlib revision>
      safeVerifyRevision: <attested SafeVerify revision>
      nanodaRevision: <attested Nanoda revision>
      profileDigest: <attested profile digest>
```

The `ordinary-tests` dependency is illustrative, but the separation isn't optional when the task
has non-proof requirements. A successful proof verifier establishes only its formal theorem. It
doesn't establish application behavior, integration behavior, performance, security, usability, or
the completeness of the source specification.

### Use an optional proof model

To ask a model for the proof, make `proof` an ordinary agent node with one exact operator-selected
provider, model, and thinking level. Set no fallback route. The verifier records the exact model
route with the proof request. Change the verifier's proof reference to
`{ nodeId: proof, field: agent.text }` so that it reads the agent's durable final text.

The model can propose only the proof text. It can't approve the statement, choose another model,
change the runtime, add an import, weaken ordinary verification, or authorize completion. A
hand-written proof has no proof-model route and needs no provider credential.

## Validate and start the workflow

Validate the graph and exact runtime fields before the first attempt:

```sh
flow validate proof.workflow.yaml
```

Start the workflow with an explicit run ID:

```sh
flow run proof.workflow.yaml --run-id exact-proof
```

Flow runs the source nodes and stops at `waiting_for_approval`. Inspect the public run state and
find the approval request ID:

```sh
flow inspect exact-proof
flow events exact-proof --after 0
```

Review the private specification and statement evidence from the local run ledger. Confirm that
the statement expresses the intended specification, not merely that it looks plausible. Approve
the exact evidence pair with a stable actor label:

```sh
flow approve exact-proof <request-id> --actor operator:<your-label>
```

Resume the same workflow and run ID:

```sh
flow resume proof.workflow.yaml --run-id exact-proof
```

Any change to the specification or statement changes its digest and invalidates the approval.
Flow doesn't reuse a human approval across changed content.

## Interpret proof evidence

Flow records the private request and execution evidence in the run ledger. Public inspection and
export replace private content with its digest and UTF-8 byte count.

| Evidence | Accepted state | What it establishes |
| --- | --- | --- |
| Human faithfulness approval | Exact specification and statement digests approved by `human` authority | A named operator accepted the formalization relationship. It doesn't prove the relationship objectively. |
| Compiler | `accepted` with the requested declaration, statement digest, and environment digest | Lean compiled the exact submission and target environment. |
| SafeVerify | `accepted` with the same declaration, statement, environment, and only allowed axioms | Kernel replay accepted the declaration under `propext`, `Quot.sound`, and `Classical.choice`. |
| Nanoda | `accepted` with the same environment digest | An independent checker accepted the complete exported environment. |
| Cleanup | `confirmed` | Flow proved that the exact container is absent after execution. |

The verifier verdict has these meanings:

| Verdict | Meaning |
| --- | --- |
| `accepted` | Compiler, SafeVerify, Nanoda, identities, human approval, and cleanup are complete and consistent. |
| `rejected` | Complete evidence establishes a proof or authority failure, such as compiler rejection or a disallowed axiom. |
| `inconclusive` | Required evidence is missing, inconsistent, unavailable, disagrees, or has uncertain cleanup. |

Checker disagreement is `inconclusive`. Flow doesn't choose one checker as the winner. An
unavailable checker, malformed output, timeout, version drift, or unconfirmed cleanup also can't
become an accepted proof.

## Inspect content-free public output

Use public commands for sharing run state without sharing the proof material:

```sh
flow inspect exact-proof
flow events exact-proof --after 0
```

The public projection can include:

- Request, specification, statement, proof, target, runtime, and approval identities.
- UTF-8 byte counts.
- Compiler, SafeVerify, Nanoda, cleanup, and final verdict states.
- Checker axioms, reason codes, and durations.
- The exact optional proof-model route.

It excludes the specification, statement, proof, raw compiler diagnostics, model prompt and
response, credentials, environment values, and workspace paths. The local run ledger is private
operator state and still requires filesystem protection.

## Qualify one exact proof profile

Qualification answers whether one exact profile has complete evidence across a declared task set.
It doesn't activate the profile or claim general theorem-proving superiority.

Assemble a JSON qualification document from the immutable private run and ordinary-test evidence.
The qualifier checks the document's closed schema, identities, completeness, and internal
consistency. It doesn't reopen a run ledger or independently prove that an operator-provided field
came from that ledger. Keep the source document with the referenced private evidence for review.

The document must contain:

- One `profile` containing the exact profile digest and runtime identity.
- A unique declared task denominator. Each task binds the expected proof request, specification,
  and statement digests.
- Exactly one trial for each task.
- The proof verdict and individual compiler, SafeVerify, and Nanoda states.
- A human faithfulness decision bound to the declared specification and statement.
- A separate ordinary-test result and its suite digest.
- Complete cost in USD micros and latency in milliseconds. Use the provider-observed cost for a
  model-generated proof, zero for a hand-written proof, and `null` when cost evidence is missing.
- Policy-failure reason codes and the cleanup state.

Produce the content-free report and an immutable review file:

```sh
flow eval proof qualify proof-qualification.json --output proof-qualification-report.json
```

The content-free report includes the declared task denominator and each evidence category's
coverage. It also includes totals, per-task states, policy failures, cleanup failures, and explicit
missing fields. Each task result retains the request, specification, statement, and ordinary-test
suite digests. `qualificationInputDigest` binds the complete admitted source document.
`reportDigest` binds the complete public report.

| Qualification verdict | Rule |
| --- | --- |
| `qualified` | Every declared task has identity-consistent accepted proof evidence, human approval, passed ordinary tests, complete cost and latency, no policy failures, and confirmed cleanup. |
| `not_qualified` | At least one complete field establishes a failure, identity drift, model-only approval, policy violation, test failure, or cleanup failure. |
| `insufficient_evidence` | No established failure exists, but at least one required proof, approval, test, cost, latency, or cleanup field is missing. |

Qualification reports are review artifacts. They don't activate a profile, authorize a workflow,
or replace the original private evidence. Don't reuse a report after changing a task, request,
statement, runtime, image, profile, or ordinary test suite.

## Recover or cancel safely

Attached, detached, resumed, and replayed runs use the same proof request and runtime identities.
Flow stores a write-ahead container lease before the Docker effect. Cancellation still performs
stop, removal, and confirmed-absence checks.

If recovery finds a prior lease, it reconciles the exact container and blocks automatic proof
retry. Inspect the evidence and start a new attempt only after Flow confirms that the prior
container is absent. Don't delete the lease to force progress.

For the complete lifecycle and remediation rules, read
[Operate the Lean proof runtime](../operations/lean-proof-runtime.md#recover-an-interrupted-attempt)
and [Recovery and interruption safety](../recovery.md).

## Non-goals

The first proof profile doesn't provide:

- Native macOS or Linux arm64 execution.
- A remote proof service or networked proof work.
- Unrestricted imports, user axioms, or executable package plugins.
- Dynamic or model-selected routing.
- Model authority to approve statement faithfulness.
- Replacement for deterministic builds, ordinary tests, runtime checks, or human review.
- Proof that a formal statement fully captures a product requirement or user intent.

Use formal proof as one strong, narrow evidence source inside Flow's existing verification graph.
