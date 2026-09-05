# Flow plugin comparison

This assessment helps maintainers prioritize the remaining migration from the Flow plugin to the
standalone harness. The harness implements core execution, evidence, and approval boundaries, but
it is not yet a complete replacement for the plugin's developer experience.

Use the [project status](project-status.md) for current platform support and the
[usable-checkpoint plan](usable-checkpoint-plan.md) for delivery priorities. This comparison does
not establish a performance advantage, general unattended operation, or release qualification.

## Interpret the evidence

The September 5, 2026 assessment compared these sources:

- The plugin's
  [23 command files](https://github.com/synaptiai/synapti-marketplace/tree/4c5cc3e3795d20a946aa551450c101d7da246a70/plugins/flow/commands)
  and
  [documented behavior](https://github.com/synaptiai/synapti-marketplace/blob/4c5cc3e3795d20a946aa551450c101d7da246a70/plugins/flow/README.md).
- Harness source at `cf802bde9d6b7a464884c5b76aaa8a387b5765b0`, including
  [CLI dispatch](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/cli/main.ts), [issue admission](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/application/issue-workflow-admission.ts),
  [controller transitions](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/application/continue-github-issue.ts), and
  [review validation](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/domain/issue-lifecycle/review.ts).
- Existing [controller regression tests](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/test/unit/application/github-issue-controller.test.ts)
  and the field reports for [issue 6](field-reports/digital-twin-issue-6-alpha4.md) and
  [issue 106](field-reports/digital-twin-issue-106-installed.md).

Source and test inspection establishes what is implemented and what regression coverage exists. It
does not report a fresh test run. Source and test links use the assessed revision, so they also work
from the installed documentation without a source checkout.

The classifications describe behavior within the named scope:

| Classification | Meaning |
| --- | --- |
| Enforced | Production code enforces the stated boundary; this is not a claim of complete command equivalence. |
| Workflow-authored | The runtime can execute the practice when an operator supplies an admitted workflow; the practice is not automatic. |
| Optional | An operator-selected skill or capability can contribute the practice within its authority. |
| Missing | No dedicated equivalent exists for the plugin behavior. Related primitives might exist. |
| Excluded | The current product scope explicitly excludes that behavior. |

Three milestones remain distinct: implementation in source, successful field execution, and
qualification of a public package. Published alpha.4 does not contain the GitHub issue lifecycle.
The issue 6 controller used newer source on macOS and reached a verified merge once. The first
installed Linux x64 attempt, issue 106, failed before candidate acceptance and review.

## Compare all 23 commands

The table accounts for every command file, including the universal dispatcher and conflict
resolution. Similar names do not imply equivalent interfaces or authority.

| Plugin command | Harness classification and coverage | Evidence or remaining gap |
| --- | --- | --- |
| `/flow` | Missing natural-language dispatcher. The harness provides explicit CLI command families. | [CLI dispatch](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/cli/main.ts) selects commands, not conversational intent. |
| `/flow:start` | Enforced issue lifecycle after an operator authors and freezes the plan. Planning convenience is workflow-authored or missing. | [Issue plan schema](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/domain/issue-lifecycle/plan.ts) requires implementation, holdout, verification, review, and hosted-check contracts. |
| `/flow:commit` | Enforced commit step within the issue lifecycle; no general standalone equivalent. | [Local Git effects](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/infrastructure/git/local-git-issue-effects.ts) operate on the admitted candidate. |
| `/flow:pr` | Enforced publication step within the issue lifecycle; no general standalone equivalent. | [Controller](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/application/continue-github-issue.ts) gates publication on verification and independent review. |
| `/flow:review` | Enforced independent candidate-bound review. Multi-reviewer challenge teams are not a default harness procedure. | [Review validation](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/domain/issue-lifecycle/review.ts) requires exact identities, complete criteria, and blocking P1–P3 findings. |
| `/flow:address` | Workflow-authored repairs; automatic repair selection is missing. | [Controller tests](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/test/unit/application/github-issue-controller.test.ts) cover stopping on blocked review without starting another implementation. |
| `/flow:merge` | Enforced exact approval-bound merge within an existing issue run. Arbitrary PR merge is missing. | [Merge controller](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/application/merge-github-issue.ts) checks the current gate before continuation. |
| `/flow:release` | Missing general target-project release workflow. Flow's own release procedure is separate. | [Preview release operations](operations/release-preview.md) do not implement releases for arbitrary consumer repositories. |
| `/flow:status` | Enforced run and goal inspection; repository-wide conversational overview is missing. | [Run controls](guides/run-and-control.md) and [goal workspaces](guides/goal-workspaces.md) expose durable state. |
| `/flow:learn` | Optional reviewed adaptation and memory capabilities; session-pattern discovery is not a full equivalent. | [Evaluation and adaptation](project-status.md#evaluation-and-adaptation) requires reviewed candidates and activation. |
| `/flow:setup` | Enforced initialization and diagnostics; real-repository plan preparation remains missing. | [Configuration initializer](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/infrastructure/fs/flow-config-store.ts) and [issue diagnostics](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/cli/production-github-issue-service.ts) are existing reusable boundaries. |
| `/flow:explain` | Missing dedicated interactive decision explanation. Evidence inspection provides related information. | [Run inspection](guides/run-and-control.md) is not a conversational decision-journal interpreter. |
| `/flow:issue` | Missing issue-authoring equivalent. Harness `flow issue` controls an existing issue contract. | [CLI grammar](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/cli/main.ts) exposes validation, diagnostics, execution, observation, recovery, cancellation, and merge. |
| `/flow:brainstorm` | Optional skills or workflow-authored reasoning; no dedicated equivalent. | [Capability packages](guides/capability-packages.md) can supply instructions but do not automatically enforce the plugin's process. |
| `/flow:debug` | Optional skills or workflow-authored diagnosis; no dedicated equivalent. | [Workflow specification](workflow-spec.md) provides execution primitives, not automatic root-cause investigation. |
| `/flow:design` | Optional skills or workflow-authored design; no dedicated equivalent. | Architecture discussion and alternative selection are not automatic lifecycle stages. |
| `/flow:goal` | Enforced revisioned goal storage and evidence-based evaluation within harness contracts. | [Goal workspace application](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/application/goal-workspace.ts) is not identical to the plugin's file-backed interaction. |
| `/flow:workflow` | Enforced compilation and execution of authored workflows, plus workflow-package management. | [Workflow specification](workflow-spec.md) defines the executable contract rather than the plugin's conversational phase tracking. |
| `/flow:trigger` | Missing general trigger management. Remote and distributed scheduling are excluded from current scope. | [NV-10](next-version-research.md#nv-10-distributed-supervision-and-hosted-operation) tracks the research boundary. |
| `/flow:run` | Enforced execution and durable observation. | [Run application](https://github.com/synaptiai/flow-harness/blob/cf802bde9d6b7a464884c5b76aaa8a387b5765b0/src/application/run-workflow.ts) owns execution, rather than only inspecting plugin run files. |
| `/flow:resume` | Enforced proof-gated recovery; not just a proposed next action. | [Recovery contract](recovery.md) preserves effect uncertainty and exact identity. |
| `/flow:watch` | Missing general workflow-watch equivalent. Package update watching is narrower. | [Capability package guide](guides/capability-packages.md) does not establish general issue monitoring. |
| `/flow:resolve` | Missing general merge-conflict resolution. Stale or conflicting lifecycle conditions stop safely. | [Issue lifecycle non-goals](roadmap.md#gate-13-failure-behavior-and-non-goals) exclude broad delivery behavior beyond the frozen run. |

## Compare practices separately from command names

Plugin review teams are opt-in, and single-session review is the default. A fair baseline compares
default behavior separately from enabled team behavior. The harness's mandatory independent review
is useful coverage, but it does not prove equivalent challenge-round quality.

The plugin's `resume` command is informational-only. Harness recovery performs actual durable
ownership and effect reconciliation. More conversational automation is not necessarily a stronger
recovery guarantee.

Test-first development, architectural reasoning, brainstorming, structured debugging, and visual
verification are not uniformly enforced by the harness. Skills and workflows can describe them,
but loading instructions is not proof that a practice ran. UC-07 requires runnable demonstrations
and evidence before classifying a practice as delivered.

The approved command-discovery correction does not create guided plans or choose repair workflows.
It helps an implementation agent use existing authority and stop ineffective requests. It must not
relax command matching, expose private holdouts, or convert tool success into acceptance.

## Use the comparison to prioritize work

Keep delivery status in the [usable-checkpoint plan](usable-checkpoint-plan.md), not in a second
task register. UC-08's correction is implemented and locally verified. Complete UC-08a's
archive-retention gate before another hosted qualification attempt. UC-01 and UC-02 remain blockers
until their evidence is complete.

Then prioritize repository onboarding and guided plan preparation, measured under UC-03 and UC-04.
Use UC-06's equivalent-condition benchmark to identify costly gaps. Keep UC-05's automatic repair
selection in its separate research boundary. UC-07 remains open until supported practices have
runnable demonstrations as well as this inventory.

Do not convert command counts or completed roadmap gates into a completion percentage. They differ
in scope, authority, and verification cost. Report verified outcomes, human interventions, failures,
and missing evidence instead.
