# UC-08 research and verification record

Audience: maintainers reviewing the command-discovery correction. Access date: 2026-09-05.
Scope: command affordances, actionable refusals, deterministic stopping, durable recovery, and
the distinction between correction evidence and installed end-to-end qualification.

## Findings and source ledger

| Claim | Source and verification | Confidence and limit |
| --- | --- | --- |
| Tool errors should help the model correct its input. | [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), error handling; [Anthropic tool-design article, 2025-09-11](https://www.anthropic.com/engineering/writing-tools-for-agents), tool descriptions and actionable error guidance. | Primary-source guidance, not measured proof that this model will follow the catalog. Flow exec is not itself an MCP server. |
| Other harnesses use different repetition and correction counters. | [Gemini CLI loop detector at acae7124](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/services/loopDetectionService.ts) uses a repeated-call threshold of five with cycle lengths one through five, plus separate content and model-based checks. | Source verified through web retrieval and GitHub revision lookup. This is not a command-authority-refusal policy or a universal standard. |
| A per-tool retry counter is not a cumulative refusal bound. | [Pydantic AI retries at 68252f19](https://github.com/pydantic/pydantic-ai/blob/68252f1904d0b73ddd859db20b5f5a2252b5c0ca/docs/retries.md) describes per-tool counters that reset on success. Its [usage reference](https://pydantic.dev/docs/ai/api/pydantic-ai/usage/) distinguishes model requests from successful tool calls. | Official documentation cross-checked through Context7 MCP retrieval of the source documentation. Reset semantics permit alternation, which is unsuitable for this specific cumulative guard. |
| Flow's failure was a mismatch between exposed guidance and exact authorization. | `src/domain/agent-command.ts`, `src/application/frozen-issue-command.ts`, `src/infrastructure/pi/workspace-agent-tools.ts`, and the private issue 106 evidence summarized in the canonical field report. | Source plus executed pilot evidence. Catalog guidance is the proposed causal correction; the protective stop alone would not fix discoverability. |
| Throwing a structured JavaScript error does not preserve its fields in Pi tool evidence. | Installed locked Pi 0.84.4, nested `pi-agent-core/dist/agent-loop.js`, tool exception conversion. | Exact installed dependency inspected. Record a host-derived classification from the matching committed call and frozen authority, never from error prose. |
| A settled-batch stop fits current recovery invariants better than immediate cancellation. | The same locked Pi loop awaits listeners and settles sequential batches; `src/domain/run/model-session.ts` requires results for completed requests; `src/infrastructure/pi/pi-agent-executor.ts` wraps provider admission. | Source verified; regression tests must prove mixed-batch behavior and absence of the next provider call. |
| Flow's full installed lifecycle remains unqualified. | [Hosted issue 106 failure](https://github.com/danielbentes/digital-twin/actions/runs/33967000922), source field reports, and independent GitHub issue/PR reads on 2026-09-05. | Issue 106 remains open with no candidate PR. Source-built issue 6 merge is distinct evidence, not installed Linux qualification. |

## Arithmetic and counterfactual checks

- Refused exec requests: 48 / 52 = 92.307692...%. Executed commands: 4 / 52 = 7.692307...%.
- Tool errors: 49 = 48 command refusals + 1 unrelated read failure. A nonzero lint result is normal
  command evidence, not another authority refusal.
- Total reported tokens: 59,460 input + 12,746 output + 1,401,344 cache-read = 1,473,550.
  This is 47.355% above the 1,000,000 node-settlement token gate. It does not prove an undocumented
  per-request hard token reservation or justify increasing the gate.
- Cached input represented 1,401,344 / 1,473,550 = 95.0999% of reported tokens. Reported cost was
  28,667 microdollars = $0.028667. Token totals and monetary cost are different measures.
- A three-refusal guard would prevent a later model request once the cumulative threshold was
  reached. It does not imply exactly three tool results: an already-issued batch can cross it.
  Do not estimate saved cost or successful completion without replaying the exact request sequence
  and then observing a new independent trial.

## Attempts to disprove the design

1. **Maybe generic repeated-call detection is enough.** The pilot changed timeouts, executables,
   and arguments. Detecting only identical requests misses these semantically equivalent refusals.
   Conversely, repeatedly running tests after edits can be productive. Use the narrower proven
   authorization outcome, not a general judgment of model progress.
2. **Maybe successful commands should reset the counter.** This permits an agent to alternate one
   admitted command with invalid requests indefinitely within other budgets. Keep a cumulative
   counter; record false-stop observations to reconsider the provisional policy.
3. **Maybe immediate abort is safer.** It prevents later batch work but can leave committed tool
   calls without results. Current cancellation and uncertain-effect machinery would need a broader
   design. Finish the issued batch and stop before another model call; document that boundary.
4. **Maybe command identifiers would solve everything.** They reduce transcription errors, but
   require a new public input interface and do not by themselves solve schema errors, recovery
   evidence, or command discovery. Keep as a measured follow-up, not an implicit scope expansion.
5. **Maybe optional catalog data can be added to old runs harmlessly.** It changes bound authority
   and tool metadata. Preserve legacy objects when absent; never enrich an active run implicitly.
6. **Maybe any failed exec result proves no command ran.** Runtime and policy failures can occur
   around effects. Exclude only host-proven pre-execution refusals from command-result equivalence.
7. **Maybe a green suite establishes readiness.** Deterministic regressions prove selected software
   behavior. They do not prove live model selection, hosted operation, or usability by a new user.

## Search scope and remaining uncertainty

Discovery used three bounded web queries for primary tool-design, MCP, and harness-loop sources.
Follow-up inspected the original Gemini implementation, Pydantic retry and usage documentation,
two exact upstream revisions through GitHub CLI, and Pydantic source documentation through MCP.
Independent agents traced authority, durable stopping, and all 23 plugin commands. No LSP service
is available in this task; source references and TypeScript checks supply code-level verification.

Further broad searching is unlikely to establish an optimal Flow refusal threshold. The missing
evidence is behavioral: catalog-following success, false stops, refusal rates, recovery outcomes,
and operator intervention in new bounded trials. Three is a provisional product policy, not a
research-derived optimum. General loop detection and autonomous repair remain separate research.

The research-planning tool is unavailable in this environment. The coordinator's persisted phase
checklist in `uc08-command-discovery.md` owns progress instead. Static and runtime evidence is added
there after execution; this document does not claim tests that have not run.
