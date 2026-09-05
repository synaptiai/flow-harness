# Usable-checkpoint execution plan

This plan helps maintainers deliver the approved evidence-first checkpoint and reduce the work
required to use Flow in another repository. The [roadmap](roadmap.md) owns capability gates. The
[research register](next-version-research.md) owns detailed future-capability research.

## Complete qualification first

As of September 5, 2026, the source-built controller completed digital-twin issue 6 through verified
merge. This proves neither the installed package on hosted Linux x64 nor a generally unattended
service. The [field report](field-reports/digital-twin-issue-6-alpha4.md) retains all 52 parent runs
and operator interventions.

The fresh target is [digital-twin issue 106](https://github.com/danielbentes/digital-twin/issues/106):
a read-only JSON command for hook registration status. Preparation must leave that behavior absent.

The [preparation PR](https://github.com/danielbentes/digital-twin/pull/107) merged as
`7788170fe4d261865cc77a6aa198308217cef752`. Its checks passed without implementing the target
behavior. The first [hosted attempt](https://github.com/danielbentes/digital-twin/actions/runs/33967000922)
uses that base and Flow source `50e5e4c5c21bd1518ff6445a8cc3f93f5a93132e`. Dispatch is not
qualification: retain UC-01 as open until the installed lifecycle and independent observations pass.

Execute these steps in order:

1. Create one useful, previously unhandled digital-twin issue. Freeze its acceptance criteria,
   negative-control holdout, candidate paths, verification commands, provider, and budgets before
   the first model invocation. Do not implement its outcome during pilot preparation.
2. Review the hosted pilot configuration before adding credentials. Build from a pinned Flow
   commit and pack once. Record the archive SHA-256 digest. Install that archive into a separate
   consumer directory. Invoke only the installed command for the lifecycle.
3. Use one hosted Ubuntu 24.04 x64 runner for the entire lifecycle. Include implementation,
   verification, independent review, check observation, explicit approval, merge, and post-merge verification. Do not restore private
   run state onto a different host. This pilot does not establish cross-host recovery.
4. Reuse the existing OpenRouter credential. Keep model and GitHub credentials in dedicated Actions
   secrets, outside the candidate workspace and model context. Do not create another provider key.
   Remove run-specific secrets after the run no longer needs them.
5. Retain the exact package identity and content-free phase evidence. Record all model attempts,
   failures, costs when available, and human interventions. Stop on uncertain effects, budget
   exhaustion, or a changed frozen contract. Do not silently restart with larger budgets.
6. Inspect the reviewed candidate and gate before issuing a separate exact-head merge command.
   Automation must not manufacture approval from passing checks. An approval transport used only
   by this pilot must remain distinct from a supported remote-control interface.
7. Require the installed command to record `merged`. Independently confirm the approved head,
   checks, merge, issue state, and branch outcome on GitHub. Close Slice 13.3 only after both checks.
8. Complete exact-head review and all required Flow checks. Publish a new immutable release only
   after separate authorization for its exact version. Verify the published install instructions.

The first hosted attempt has a ceiling of one full lifecycle run. Workflow-level recovery remains
bounded by its frozen contract. A failed attempt triggers analysis and a recorded disposition
before any replacement run. This is an initial pilot limit, not a claim about an optimal agent
budget or a standard industry limit.

## Track the product priorities

The maintainer executing Approach A owns every open row until a named owner accepts it. Priority
order does not authorize an unreviewed design or broaden model authority.

| ID | Disposition and owner | Dependency and next action | Evidence required to close | Reconsideration trigger |
| --- | --- | --- | --- | --- |
| UC-01 | Release blocker; Approach A maintainer | Complete the installed hosted pilot described in this plan. | Exact archive identity and complete issue-to-merge evidence, with all attempts retained. | Every pilot settlement. |
| UC-02 | Release blocker; release maintainer | After UC-01, complete Slice 13.4 and obtain exact publication authorization. | Qualified package on both named hosts, no P1–P3 findings, successful required CI, and verified public installation. | UC-01 passes or package identity changes. |
| UC-03 | Next delivery-design priority; Approach A maintainer | Design repository onboarding and reusable configuration after qualification. | A new user configures a separate clean repository from the guide without maintainer-authored hidden files; measure steps, time, and interventions. Missing checks or credentials fail safely. | UC-01 settles; reassess before selecting another infrastructure feature. |
| UC-04 | Next delivery-design priority; Approach A maintainer | Design guided issue-to-plan preparation with UC-03. | Proposed criteria, commands, paths, budgets, and approval rules are explicit and reviewable. A human freezes the contract before execution; generated plans pass production admission. | UC-03 design review and every plan-authoring failure. |
| UC-05 | Prioritized research, not autonomous authority; Approach A maintainer | Complete NV-03 design using the field denominator and a frozen NV-01 comparison. | Bounded verifier-directed repairs reduce human interventions without changing holdouts, acceptance rules, authority, or aggregate budgets. Include oscillation and false-acceptance tests. | UC-04 design review or another operator-authored repair series. |
| UC-06 | Measurement requirement; evaluation maintainer | Freeze the NV-01 plugin-versus-harness baseline before broader readiness claims. | Compare equivalent model routes and fresh tasks; report verified success, total cost, time, interventions, false acceptance, and missingness. | Before claiming plugin parity, superiority, or readiness beyond the qualified scope. |
| UC-07 | Parity research; Approach A maintainer | Inventory plugin review teams, challenge rounds, design, test-first development, visual checks, and reviewed learning against actual harness defaults. | Each feature is classified as enforced, optional, workflow-authored, missing, or intentionally excluded, with a runnable demonstration where supported. | UC-03 design review; prioritize gaps that blocked users in UC-06. |

UC-03 through UC-07 are not evidence that Flow has left alpha. Qualification of one task is a
bounded usability checkpoint. A broader readiness decision needs a support contract and repeatable
results from users who did not build the harness.

## Keep deferrals bounded

Use the stable NV identifiers for existing research. Do not create a second detailed inventory.
UC-03 and UC-04 cover onboarding and plan preparation, which were not explicit delivery priorities
in that inventory. UC-05 and UC-06 promote NV-03 and NV-01 for decision work without declaring their
research complete.

At every qualification settlement and version-scope review:

1. Review every open UC row and every NV item implicated by the latest failure or intervention.
2. Keep, promote, split, or retire each reviewed item with a reason and evidence link.
3. Assign an owner and the next evidence gate before moving work out of the active slice.
4. Reconsider optional infrastructure only after comparing its user benefit with UC-03 through
   UC-07. Do not let an easy infrastructure task displace a demonstrated usability blocker.
5. Preserve unresolved findings as open. A workaround, pilot script, or documentation warning is
   not an implemented product capability.

Remote multi-user operation, executable extensions, broader package automation, and VM-grade
isolation remain in the research register. They are not prerequisites for the current single-user
checkpoint unless qualification demonstrates a concrete dependency.
