# Decision journal: Issue #147 — Prove a bounded provider-backed coding quick start

**Issue:** #147 | **Branch:** `codex/issue-147-coding-quickstart` | **Started:** 2026-08-21

## Context

Gate 8.3 proves installation and one selected provider request. Gate 8.4 must prove a useful coding
path. It must preserve the credential-free quick start. It must not expose an arbitrary existing
project to the first model run.

The pinned Pi runtime provides provider-owned authentication, tool-capable model catalogs, bounded
usage accounting, and an in-process agent session. Flow owns the declared tool set, path policy,
hash-bound edit protocol, durable effect journal, command sandbox, goal reducer, public projection,
and recovery authority. The coding quick start must traverse those existing boundaries.

## Approach decision

### Approaches considered

| Approach | Description | Benefit | Limitation | Decision |
| --- | --- | --- | --- | --- |
| Extend the existing provider check | Make every provider quick start edit a fixture. | Small public grammar. | Changes Gate 8.3 behavior, surprises existing users, and removes the cheap provider-only check. | Rejected |
| Add an explicit coding mode | Keep foundation and provider checks stable; require an explicit coding selection in an empty project. | Clear cost and mutation boundary; reuses the real run engine and evidence. | Adds one mode and a small project-publication contract. | **Approved** |
| Publish only an example workflow | Ask users to copy a fixture and run a documented workflow manually. | Minimal implementation. | Does not provide one guided, bounded, recoverable first agent path. | Rejected |
| Add a separate demo subsystem | Create a new disposable-workspace command and lifecycle. | Strong conceptual isolation. | Duplicates run, inspection, cancellation, and recovery mechanisms before the preview proves them. | Rejected |

The user approved the explicit coding mode on 2026-08-21.

## Specification

_Captured on 2026-08-21. Source: user-confirmed approach plus Issue #147._

### Non-goals

#### Product behavior

- Do not change the credential-free foundation quick start or the existing zero-tool provider check.

- Do not use a nonempty project or edit arbitrary repositories. Do not let the model create files,
  run commands, or write `.flow`.

- Do not add or persist provider credentials. Do not add provider retries, automatic browser
  launch, or a billing guarantee.

#### Authority and cleanup

- Do not treat every provider in the transitive Pi catalog as a supported Flow preview provider.

- Do not delete a failed or cancelled project automatically. Durable evidence remains available
  until the user completes inspection and explicit cleanup.

- Do not let model output, provider sessions, or tool-call success decide acceptance. Only the
  verifier and goal reducer can decide acceptance.

### Failure modes

#### Before a run

##### Limits and publication

- **Timeouts** — The agent and verifier have fixed time limits. A timeout creates a terminal failed
  or cancelled run with bounded, value-free public diagnostics. Flow does not retry the provider.
- **Partial failures** — Before the configuration publication marker, Flow removes its exact staged
  fixture when settlement is provable. After that marker, uncertain publication or edits require
  inspection before cleanup or retry.

##### Input and context

- **Invalid input** — Repeated, incomplete, unsupported, malformed, or conflicting coding options
  fail before project mutation. A nonempty target fails without replacing any entry.
- **Missing context** — An absent model, absent provider authentication, or unsupported preview
  provider fails before the first model request. A missing sandbox or verifier runtime causes a
  terminal run failure after project publication.

#### During or after a run

- **Provider failure** — Provider response text, credentials, and nested causes stay private.
  Partial model text does not enter public output or durable failure messages.

- **Verification failure** — The verifier rejects every fixture that differs from the expected
  bytes. Agent-reported success cannot override it.

- **Prepublication cancellation** — Flow keeps the caller reason internal and leaves no published
  project.

- **Postpublication cancellation** — Flow settles the run and edit journal. It then returns a fixed
  public recovery action.

### Interface contracts

#### Selection and files

##### Command grammar

- The added grammar is
  `flow quickstart [directory] --coding --provider <provider> --model <model> [--run-id <id>]`.
  `--coding` is optional, may occur once, and requires both provider options.
- Existing invocations without `--coding` remain exact. The default coding run identifier is
  `quickstart-coding`.

##### Provider and fixture

- Coding mode accepts only an existing, canonical, empty directory. Its reviewed public files are
  the minimal `.flow/config.yaml` and `FLOW_QUICKSTART.md` fixture.
- Coding mode supports the `anthropic` and `openai` preview provider identifiers. The model identifier
  remains explicit and is validated against the pinned offline model catalog and configured auth.

##### Fixture policy

- The fixture begins with exact package-owned bytes. The agent receives only `read`, `ls`, and
  hash-bound `edit`. It must change `status: pending` to `status: verified` without another byte
  change.

#### Workflow and output

##### Verification and limits

- The workflow has one agent and one dependent command verifier. Only that verifier can accept
  exact bytes and emit fixed output.
- Limits are two node starts, 8,192 reported tokens, USD 0.25, 120 seconds, and 128 KiB of artifacts.
  These values are Flow accounting limits. They are not provider reservations. One in-flight
  response can overshoot.

##### Public result and failure evidence

- The version 1 result reports mode, relative fixture, run status, and relative evidence. It also
  reports exact token arrays for `inspect` and `web`. It excludes model and command output.

- A failed coding run stores fixed agent failure categories. It can store bounded usage, activity,
  policy decisions, and settled edit receipts. Failure messages exclude raw provider errors and
  partial model output.

## User, operator, and system flows

### Start and execute

1. A user creates an empty directory and explicitly selects coding mode, provider, model, and
   optionally a run identifier.

2. Flow validates grammar and compiles the package-owned workflow. It confirms the empty target and
   publishes the reviewed files without replacement.

3. Flow resolves the exact published project and checks the selected provider and model offline.

4. The agent reads the public fixture and receives its SHA-256 version. It submits one exact
   hash-bound edit.

5. Only the deterministic verifier can accept goal evidence.

### Inspect and recover

1. Flow returns a bounded terminal result. The user runs `flow inspect quickstart-coding` to review
   usage, tool policy, edit hashes, verifier evidence, and criterion state.

2. If the run fails or is cancelled, the operator inspects first. The operator keeps the evidence,
   removes the dedicated directory, or retries elsewhere. Flow does not delete projects
   automatically.

## Coupling and boundary analysis

### Coordination ownership

- Guided orchestration owns phase order and public result mapping. It does not own filesystem
  atomicity, model sessions, workflow scheduling, or evidence reduction.
- Project storage owns empty-target admission, fixture/config publication, and settlement. It does
  not know provider or workflow semantics.
- The package-owned workflow declares tools and budgets. The Pi adapter cannot widen them.

### Enforcement ownership

- The existing policy broker and effect journal own edit authority and durable reconciliation.
- The existing verifier executor, goal reducer, and public projection own acceptance and evidence.
- Provider documentation names only the preview subset. The runtime can support other explicit
  workflows without expanding the quick-start support contract.

## Criterion verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Explicit coding mode preserves existing modes | Behavioral and contract | `npx vitest run test/unit/application/guided-quickstart.test.ts test/integration/cli/quickstart.test.ts` | Existing foundation/provider snapshots remain exact; coding grammar and mode pass; invalid combinations start no mutation. | A stable workflow-format promise. |
| Reviewed no-replacement project publication | Data and error | `npx vitest run test/integration/config/project-config.test.ts test/integration/cli/quickstart.test.ts` | Empty target succeeds; nonempty, symlink, race, cancellation, and settlement cases preserve or report exact state. | Hostile same-user multi-process isolation. |
| Real read and hash-bound edit path | Behavioral | `npx vitest run test/integration/pi/pi-agent-executor.test.ts test/integration/cli/quickstart.test.ts` | An in-process deterministic provider invokes Flow read/edit, records exact before/after hashes, and changes only the fixture. | A live external provider. |
| Deterministic acceptance | Behavioral | `npx vitest run test/integration/cli/quickstart.test.ts` | Exact bytes accept; one-byte, extra-byte, and model-claim-only cases reject. | Semantic verification of arbitrary repositories. |
| Bounded private-safe evidence | Error and contract | `npx vitest run test/unit/infrastructure/pi/pi-agent-executor.test.ts test/unit/cli/public-output.test.ts test/integration/cli/quickstart.test.ts` | Private provider/cause/workspace canaries are absent; usage, policy, edit receipt, verifier, and criterion evidence remain. | Removal of successful agent output from private durable storage. |
| Cancellation, cleanup, and recovery | Error and data | `npx vitest run test/unit/application/guided-quickstart.test.ts test/integration/config/project-config.test.ts test/integration/cli/quickstart.test.ts` | Phase-boundary cancellation and uncertain settlement preserve exact authority and fixed public recovery actions. | Automatic destructive cleanup. |
| Public provider and operations guide | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/documentation-structure.test.ts test/integration/package/architecture-documentation.test.ts` | Provider, cost, cancellation, cleanup, recovery, architecture, and README routing claims pass. | Provider pricing stability. |
| Opt-in live proof | Integration | `npm run test:live -- test/live/quickstart-coding.live.test.ts` | With explicit live environment variables, the real selected provider edits and verifies the fixture; otherwise the test skips. | Deterministic CI availability or zero provider charges. |

## External verification notes

### Provider sources

- Pinned Pi documentation lists tool-capable built-in models. It permits API-key auth through
  `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
- Anthropic and OpenAI publish token pricing. Flow documentation links to those sources. It describes
  USD as a reported run budget, not a billing cap.

### Catalog evidence

- The pinned local catalog confirms the documented example model identifiers. It does this before
  publication. Live provider requests remain opt-in.

## Verification evidence

_Recorded on 2026-08-21 against the settled Issue #147 worktree._

### Test evidence

- The exact eight-file criterion selector in the map passed 116 tests. The host-permitted run was
  required because some existing integration fixtures use local Unix sockets.

- The complete serial suite passed 4,705 tests and skipped four tests. It had 342 passing files and
  one skipped file.

- Coverage was 84.83% for statements and 79.46% for branches. It was 91.40% for functions and
  84.98% for lines. All results exceed the repository thresholds.

### Release evidence

- The browser gate passed two tests. The clean-package gate built, installed, verified, and ran the
  package artifact successfully.
- The production dependency audit reported zero vulnerabilities. The Prime dependency audit also
  passed.
- Formatting, lint, documentation style, link, Simplified Technical English, type-check, build,
  and diff checks passed. Lint retained one pre-existing informational constructor notice.

### Optional live evidence

- The opt-in live coding test skipped without `FLOW_LIVE_PI_PROVIDER` and
  `FLOW_LIVE_PI_MODEL`, as designed. A real request is never an implicit release cost.

### Host-specific evidence

#### Platform boundary

- `npm run ci:local` reached the expected platform boundary after its portable preliminary gates:
  Prime OCI preparation requires hosted Linux on x64. The local machine is macOS on x64, so hosted
  CI must certify Prime preparation and the remaining platform-composed gate.

#### Process time limits

- Two local process-composition checks were inconclusive under sustained desktop load. The runtime
  suite passed 36 tests and skipped 34 before eight existing process-heavy cases hit
  their fixed 30-second limits. The compiled smoke reached the TypeScript verifier before its fixed
  120-second limit. These checks are not passing evidence. Hosted CI must run both gates.
