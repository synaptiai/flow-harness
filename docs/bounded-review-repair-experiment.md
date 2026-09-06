# Bounded review repair experiment

The user approved option B and one pilot on September 6, 2026. Prepare and verify the exact
configuration before dispatch. This approval covers the documented resource limits and repair
disclosure on the existing provider route. Preparation merge, exact candidate merge, and publication
remain separate approval gates. The [execution plan](usable-checkpoint-plan.md) owns progress, and the
[repair design](bounded-review-repair-design.md) owns the approved runtime contract.

## Choose the experiment

Selected option B: continue digital-twin issue 106 with one permitted repair cycle and smaller
fixed child allowances inside the existing combined $3 reported-cost ceiling. Keep the original
criteria, holdout, permitted paths, verification commands, and P1–P3 blocking rules. Retain
OpenRouter `z-ai/glm-5.3-flash` with low thinking. This is another attempt on the same task, not a
fresh benchmark task or an upgrade of an old terminal run.

The alternatives differ in resource authority and what they can prove:

| Option | Resource choice | Benefit | Limitation |
| --- | --- | --- | --- |
| A: Preserve child allowances | Keep each existing implementation and review allowance; give repair the implementation allowance. Double each role's aggregate allowance. | Changes fewer child limits. | Raises the combined reported-cost ceiling from $3 to $6. The summed active-time allowances reach 100 minutes before separate controller work, exceeding the existing 90-minute lifecycle deadline. Requires a separate deadline decision or accepts earlier stopping. |
| B: Allocate smaller children | Use the complete limits in this proposal. Keep aggregate token, cost, active-time, and artifact ceilings equal to the existing role allowances; explicitly increase aggregate node-start counts. | Allows a repair and fresh review without doubling resource authority. Leaves unused capacity in every aggregate dimension. | Time and artifact allocations are experimental. Smaller children can stop sooner, and no live repair has established sufficiency. |
| C: Keep the one-pass control | Omit repair policy and retain the existing implementation and review allowances. | Provides another observation of the corrected review-report validator without adding repair behavior. | Stops on a valid blocked review and cannot qualify BR-06. |

Keeping full-sized children inside unchanged aggregate pools is not an opportunistic fourth
option. After any positive usage in a dimension, another full-sized child cannot fit that pool.
Flow does not shrink a frozen child allowance during execution.

## Review the evidence and its limits

The [issue 106 field report](field-reports/digital-twin-issue-106-installed.md) retains all three
failed lifecycle attempts. These are workflow totals, including their model-backed assessment or
validation nodes when reached:

| Attempt | Implementation tokens | Implementation reported cost | Review tokens | Review reported cost |
| --- | ---: | ---: | ---: | ---: |
| First | 1,473,550 | $0.028667 | Not reached | Not reached |
| Second | 243,890 | $0.010094 | Not reached | Not reached |
| Third | 174,830 | $0.005099 | 32,387 | $0.002286 |

The proposed initial 500,000-token allowance exceeds the second and third observations, but not
the first failed attempt. The proposed 200,000-token review allowance exceeds the sole review
observation. These comparisons do not estimate a success probability or establish an optimal
limit. The attempts used different preparation, and no repair consumption has been observed.

The public summaries do not establish complete active-time or retained-artifact consumption for
the second and third workflows. Do not substitute the encrypted archive's size for workflow
artifact accounting. The time and artifact allocations are deliberate experimental choices, not
measured capacity requirements. Reported costs are settled telemetry, not provider invoices or
guaranteed billing caps. The field report preserves message-rounding differences separately.

## Freeze option B's complete limits

The proposed policy permits at most one repair cycle. Preserve both approved runtime classes,
`review-findings` and `unsatisfied-criteria`, and all five mandatory `stop` policies from the
[authoring guide](guides/github-issue-review-repair.md#add-the-policy-to-the-lifecycle-plan).
The initial implementation and every review remain separately bounded child workflows.

Use these approved values for the single new pilot. One MiB is 1,048,576 bytes. The cost column uses integer
microdollars: 1,000,000 microdollars equals $1. Authored workflow `maxCostUsd` uses dollars.
Aggregate plan `maxCostUsdMicros` uses microdollars.

| Allowance | Node starts | Model tokens | Cost, microdollars | Active milliseconds | Artifact bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial implementation child | 4 | 500,000 | 1,000,000 | 900,000 | 4,194,304 |
| Repair child | 4 | 250,000 | 500,000 | 600,000 | 2,097,152 |
| Each review child | 4 | 200,000 | 400,000 | 480,000 | 3,145,728 |
| Implementation aggregate pool | 10 | 1,000,000 | 2,000,000 | 1,800,000 | 8,388,608 |
| Review aggregate pool | 10 | 500,000 | 1,000,000 | 1,200,000 | 8,388,608 |

The implementation pool covers initial implementation and repair together. The review pool covers
both independent reviews. Aggregate node-start counts of 10 are new explicit experimental choices,
not unchanged historical four-start workflow limits.

The complete child sums fit with the following unused capacity:

| Role | Maximum sum of child allowances | Aggregate capacity left after that sum |
| --- | --- | --- |
| Implementation plus repair | 8 starts; 750,000 tokens; $1.50; 1,500,000 ms; 6 MiB | 2 starts; 250,000 tokens; $0.50; 300,000 ms; 2 MiB |
| Two reviews | 8 starts; 400,000 tokens; $0.80; 960,000 ms; 6 MiB | 2 starts; 100,000 tokens; $0.20; 240,000 ms; 2 MiB |

These sums prove reservation compatibility if all actual usage remains within the child
allowances. They do not guarantee completion. Before any new dispatch, the
[accounting guard](../src/domain/issue-lifecycle/workflow-accounting.ts) checks both roles for
unknown usage or an exhausted aggregate dimension. Either condition stops further dispatch.
Actual overshoot is retained, not clamped. Unused review capacity cannot fund implementation.

## Preserve report validity and candidate verification

Keep the initial implementation's existing agent, command verifier, and assessment graph. Author
a separate repair-result agent followed by a terminal model verifier of its disposition. Map
the original five criterion IDs and unchanged descriptions to that terminal verifier. Give both
repair nodes at most two attempts within the single four-start child allowance.

The repair verifier validates a strict `changed` or `disputed` result. It must not force the
candidate to pass or reject a structurally valid dispute because the issue is incomplete. Copy
the four host-produced binding fields from `expectedResultBinding`. Never calculate them in
the prompt. Preserve complete finding and unsatisfied-criterion coverage for `changed`.

Do not copy the implementation's pytest prerequisite into the repair disposition gate. A partial
repair followed by a valid dispute must reach the host's dispute stop. After a valid `changed`
result, the controller runs every original deterministic check and the private holdout against
the new candidate. It then requests a fresh independent review. No check is waived.

Smaller whole-child time allowances can stop before an existing individual node deadline. Four
node starts do not guarantee that all recovery attempts fit. Validate any authored timeout change
separately. Do not silently expand node deadlines or the host deadline to make an attempt finish.

## Account for host verification time

One [host verification pass](../src/infrastructure/git/local-issue-verification.ts) runs the base
holdout, candidate holdout, and five original commands serially. Their configured timeout sum is
`120 + 120 + 300 + 4 × 120 = 1,020` seconds, or 17 minutes. This is a sum of command ceilings,
not a measured duration or a complete wall-clock bound.

For one repair, the unchanged path contains these verification calls:

| Stage | Verification passes | Configured command-timeout sum |
| --- | ---: | ---: |
| Initial candidate verification and first review-context preparation | 2 | 34 minutes |
| Repaired candidate verification and fresh review-context preparation | 2 | 34 minutes |
| First publication gate check | 1 | 17 minutes |
| Fresh gate check after exact merge approval | 1 | 17 minutes |

[Review-context preparation](../src/infrastructure/git/local-issue-review-evidence.ts) verifies
the candidate once before freezing that context. Reusing the frozen context does not repeat
those commands. However, each explicit CI-wait resume calls
[`createCurrentIssueGate`](../src/application/continue-github-issue.ts), which verifies before
observing GitHub. Each such retry adds another possible 17 minutes of configured command time.
Periodic status inspection alone does not rerun verification. The shared deadline bounds the
resume loop, but there is no separate authored count limit for those gate checks.

The child active-time sum is 41 minutes. Adding four prepublication verification passes gives
109 minutes. Adding the first gate check gives 126 minutes before approval. Adding the fresh
merge gate check gives 143 minutes across both phases. These subtotals exclude setup, hosted
check waiting, extra gate checks, human approval waiting, storage, and Git or GitHub operations.
They are not duration forecasts or full wall-clock upper bounds.

Option B keeps the existing 90-minute execution-and-check deadline, 30-minute approval-and-merge
phase, and 180-minute job ceiling. These are explicit earlier-stop choices. The 90-minute window
cannot accommodate every configured maximum simultaneously. Actual commands might finish much
sooner. The 30-minute phase also includes the human's response and the fresh merge gate check.
Do not claim guaranteed completion or silently extend a deadline after a stop.

Reusing verification receipts would require a separate validity and drift-detection contract.
This experiment does not remove verification or introduce caching to make its timing fit.

## Prepare the exact experiment before execution

The selected Flow source is `544aebc13bfc50879de52396062a869ca975c367` on draft
[PR 201](https://github.com/synaptiai/flow-harness/pull/201). All three jobs in
[source CI](https://github.com/synaptiai/flow-harness/actions/runs/34056651615) passed, including all
four Lean proof runtime tests without skips. This is source verification, not installed pilot
qualification. The target's draft [PR 110](https://github.com/danielbentes/digital-twin/pull/110)
is being extended from report validation to the approved repair configuration. Preparation must
not implement issue 106.

Complete these preparation gates before the approved dispatch:

1. Add the exact approved policy and repair workflow to the target preparation. Preserve the
   original holdout bytes, criterion descriptions, permitted paths, and command identities.
2. Add preparation contract tests for budget units, both repair dispositions, original scope,
   source identity, and approval ordering. Test the collection of repair child ledgers and frozen
   context blobs. Include dispatch and settlement evidence and owned candidate worktree content.
3. Review the target preparation independently. Run its existing control tests, Python tests,
   compilation, lint, type checking, and shell syntax checks. Confirm that the status command and
   its new tests remain absent from the preparation base.
4. Recheck the [host timing calculation](#account-for-host-verification-time) against the final
   workflows and driver. Preserve the documented earlier-stop deadlines. Any deadline change
   requires a separate decision.
5. Select the qualified immutable Flow source and final target base. Build and pack once. Retain
   the archive SHA-256 digest. Verify those same bytes on Ubuntu 24.04 x64 and macOS 15 Intel.
   Old two-host evidence does not qualify new package bytes.
6. Validate the plan with the installed binary and pass the credential-free baseline. Keep that
   baseline distinct from the frozen holdout negative control and from a comparative benchmark.
7. Use the authorization for one dispatch and the additional provider disclosure of selected
   review findings and criterion evidence. Reuse the existing OpenRouter credential. Configure
   dedicated Actions secrets only for that authorized run. Do not create another provider key.

Use one hosted Ubuntu runner for execution, evidence capture, approval, and merge. Preserve exact
candidate approval, the existing pilot-only approval transport, and authenticated private evidence
retention. A forensic archive is not a supported way to resume on another host. Final candidate
merge requires separate exact-head approval. Preparation approval does not supply it.

## Interpret the result without changing the gate

Retain every attempt, intervention, refusal, dispute, failure, and unavailable usage dimension.
A clear initial review can advance UC-01, but does not prove repair. Do not insert a defect,
force a blocking review, or restart until a preferred outcome appears.

BR-06 needs an observed valid blocked review, an eligible bounded repair, fresh passing
verification, and a fresh clear independent review. Hosted checks and separately approved merge
evidence must follow. A repair attempt alone is insufficient. UC-05 also retains its comparative
evidence requirement. One repaired issue does not establish reduced operator burden generally.

The [NV-01 research entry](next-version-research.md#nv-01-product-benchmark-and-claim-baseline)
owns the fresh-task comparison contract. Issue 106's repeated attempts cannot replace it.
