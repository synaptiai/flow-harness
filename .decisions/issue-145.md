# Decision journal: Issue #145 — Complete a guided quick start for the public preview

**Issue:** #145 | **Branch:** `codex/issue-145-guided-quickstart` | **Started:** 2026-08-21

## Context

Gate 8.1 publishes an installable preview, and Gate 8.2 provides a bounded selected-path
diagnostic. A new user must still assemble the first useful run from separate initialization,
package-location, validation, execution, evidence, and presentation commands. Gate 8.3 provides one
safe entry point without bypassing Flow's existing admission, sandbox, run, or evidence boundaries.

## Research

- npm's initializer preserves existing package fields unless the user explicitly changes them.
  Cargo can initialize an existing directory. These tools support an additive first-run contract,
  but Flow must use stronger no-replacement and publication-settlement rules because its project
  configuration controls later execution authority.

- Terraform separates initialization from later execution and provides noninteractive behavior
  explicitly. The command-line interface guidelines likewise recommend that prompts depend on a
  terminal and that automation never require a prompt. Flow uses one deterministic behavior for
  both interactive and noninteractive quick starts, so terminal detection cannot change authority
  or output shape.

- GitHub CLI exposes `--no-browser` behavior and prints a destination when it does not launch a
  browser. Flow adopts the explicit-follow-up principle, not automatic browser launching: the
  quick-start result returns the exact existing `flow web` command only after an accepted run.

- Node's promise-based filesystem operations are not synchronized with concurrent callers. Flow
  therefore cannot implement the project write as a check followed by an ordinary write. It must
  retain exclusive staging, atomic publication, directory settlement, and a distinct uncertain
  outcome when the visible result cannot be proved durable.

Primary sources:

- [npm init](https://docs.npmjs.com/cli/commands/npm-init/)
- [Cargo init](https://doc.rust-lang.org/cargo/commands/cargo-init.html)
- [Terraform init](https://developer.hashicorp.com/terraform/cli/commands/init)
- [GitHub CLI browse](https://cli.github.com/manual/gh_browse)
- [Command Line Interface Guidelines](https://clig.dev/)
- [Node.js file system API](https://nodejs.org/api/fs.html)

## Approaches

| Approach | Summary | Main advantage | Main risk |
| --- | --- | --- | --- |
| Thin CLI orchestration | Make `quickstart` call the existing command handlers in sequence. | Small apparent implementation. | Hides phase ownership, duplicates parsing, and cannot express publication settlement safely. |
| Bounded application use case | Add one application service with explicit publication, preflight, execution, and result ports. | Makes mutation, cancellation, privacy, and evidence boundaries independently testable while reusing production services. | Requires a small shared foreground-run seam instead of directly calling CLI handlers. |
| Scaffold and print commands | Create the project and tell the user which commands to run. | Minimal runtime coupling. | Does not complete the accepted first run or prove the installed execution path. |
| Durable quick-start state machine | Persist a second lifecycle around project and run creation. | Maximum recovery detail. | Duplicates the existing run lifecycle and creates unnecessary durable authority. |

## Decision

Use the bounded application use case. The CLI owns grammar and public serialization. The
application layer owns ordered preflight, project publication, selected provider validation,
foreground execution, cancellation boundaries, and the stable quick-start result. Infrastructure
adapters retain filesystem, provider, sandbox, and run-store authority.

The credential-free path uses the installed `examples/verify-installation.workflow.yaml` workflow.
The provider path constructs one bounded zero-tool workflow from the exact `--provider` and
`--model` pair, validates local model and credential configuration without model network access,
and only then enters the ordinary foreground run boundary.

The command never launches a browser. A successful result includes the exact existing `flow web`
command with a fixed quick-start actor. Interactive and noninteractive invocations have identical
behavior and output.

## Specification

_Captured on 2026-08-21. Source: the approved roadmap, Issue #145, the approved Approach B
contract, repository contracts, and primary-source research._

### Non-goals

- Quick start does not create a hosted service, install a provider, obtain a credential, start
  Docker or Prime, detach a run, resume a run, or add a second durable lifecycle.

- Quick start does not replace or merge an existing `.flow/config.yaml` or any other existing file.
  Existing projects continue to use `flow run` directly.

- Quick start does not launch a system browser, vary behavior based on terminal detection, or make
  browser presentation part of run acceptance.

- Quick start does not make an optional provider, Docker, Prime, or a model request a prerequisite
  for the credential-free path.

- The result does not expose workflow source, command output, model output, credentials, provider
  responses, absolute paths, or nested private causes.

### Failure modes

- **Timeouts** — Selected provider inspection and workflow execution retain their existing bounded
  deadlines. A timeout becomes the owning fixed public stage. Quick start does not add an unbounded
  retry or a second timer.

- **Partial failures** — A prepublication failure removes private staging and leaves existing files
  unchanged. A postpublication execution failure retains the published project and ordinary run
  evidence. A publication whose durability cannot be proved returns only the fixed uncertain state
  and requires inspection before retry.

- **Invalid input** — Unknown, repeated, incomplete, or incompatible arguments fail with usage
  status before project initialization, configuration discovery, provider inspection, store
  construction, or executor invocation.

- **Missing context** — A nonexistent or unsafe target directory fails before publication. A
  missing optional provider or credential fails only the explicitly selected provider path. The
  credential-free path remains available without provider configuration, Docker, or Prime.

- **Cancellation** — Cancellation stops before the next phase that Flow does not own. Publication
  and run settlement use their owning settlement rules. After a phase becomes authoritative, Flow
  reports that settled or uncertain phase instead of a misleading clean cancellation.

- **Resource exhaustion** — Input counts, identifiers, workflow bytes, result fields, and public
  text are bounded. The default workflow is package-owned. The provider workflow contains one
  zero-tool agent and one result node.

### Interface contracts

- Public grammar is `flow quickstart [directory] [--run-id <id>]` or `flow quickstart [directory]
  --provider <provider> --model <model> [--run-id <id>]`. `--provider` and `--model` are required
  together. Every option can occur at most once. The directory must already exist.

- Omitted run identifiers are deterministic: `quickstart-foundation` for the credential-free path
  and `quickstart-provider` for the provider path. Existing run identifiers fail through the
  ordinary run-store contract; quick start never overwrites evidence.

- Public result version 1 contains only a mode, project-publication state, run identifier, terminal
  status, project-relative evidence location, and tokenized inspection and browser commands. The
  browser command is present only after the run is accepted. No field contains an absolute path or
  untrusted runtime text.

- The application service accepts explicit ports for project publication, selected-path
  validation, and foreground execution. It does not invoke `main()`, parse CLI arguments, print
  output, or construct infrastructure directly.

- Project publication retains exclusive staging and atomic no-replacement publication. A failure
  before publication removes private staging. A failure after publication but before durability
  proof produces a typed `commit_uncertain` result that callers cannot convert to success or clean
  failure.

- Foreground execution reuses the same workflow admission, policy-package check, protected-path,
  sandbox, approval-channel, run-store, workspace-isolation, cancellation, and public-projection
  boundaries as `flow run`.

- Provider inspection uses the exact selected provider and model, the newly published effective
  project configuration, and model-network-disabled local inspection. Executor invocation cannot
  occur unless this inspection succeeds.

- The browser offer is the token array `flow web <run-id> --actor operator:quickstart`. Returning
  the command grants no presentation or supervisor authority; `flow web` repeats its own checks.

## Acceptance verification map

| Criterion | Type | Verification command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| One command creates only a minimal project without replacement. | Behavioral and error | `npx vitest run test/integration/config/project-config.test.ts test/unit/application/guided-quickstart.test.ts test/integration/cli/quickstart.test.ts` | Existing files and unsafe targets remain unchanged; exactly one configuration is published; repeated initialization fails. | Does not update an existing project. |
| The default path validates and completes the installed workflow through the production sandbox. | Behavioral and runtime | `npx vitest run test/integration/cli/quickstart.test.ts test/runtime/quickstart.runtime.test.ts` | The package-owned credential-free workflow reaches a terminal successful run through the native sandbox. | Does not prove Docker or Prime readiness. |
| Success returns one bounded stable result with evidence and exact follow-up commands. | Contract | `npx vitest run test/unit/application/guided-quickstart.test.ts test/integration/cli/quickstart.test.ts` | Exact version 1 result snapshots pass; private values and absolute paths are absent. | Does not serialize the full run state. |
| The provider path validates exact local configuration before any model request. | Behavioral and error | `npx vitest run test/unit/application/guided-quickstart.test.ts test/integration/cli/quickstart.test.ts` | Exact provider/model requirements reach offline inspection first; failure proves zero executor and model-network calls. | Does not verify the provider remotely or make a useful coding change. |
| Optional dependencies affect only their selected path. | Behavioral | `npx vitest run test/integration/cli/quickstart.test.ts` | Credential-free execution passes with provider, Docker, and Prime seams unavailable; the provider case alone fails. | Does not diagnose unselected systems. |
| Browser presentation is offered only after acceptance and never launched automatically. | Behavioral | `npx vitest run test/unit/application/guided-quickstart.test.ts test/integration/cli/quickstart.test.ts` | Failed and cancelled runs have no browser command; successful interactive and noninteractive runs return the same token array and never create a browser host. | Does not prove the separate browser session remains open. |
| Grammar, publication, cancellation, and uncertainty fail closed. | Error and data | `npx vitest run test/integration/config/project-config.test.ts test/unit/application/guided-quickstart.test.ts test/integration/cli/quickstart.test.ts` | Invalid/repeated options precede mutation; prepublication staging is absent; postpublication failures are typed uncertain; cancellation preserves settlement. | Does not make concurrent external filesystem mutation safe outside the documented trust boundary. |
| Installed release packages prove the complete noninteractive first run. | Runtime and package | `npm run pack:check && npx vitest run test/scaffold/package.test.ts test/scaffold/preview-release-workflow.test.ts` | A clean packed install initializes, runs, inspects evidence, and emits but does not invoke the browser command on release-qualified hosts. | Does not publish npm or validate an external provider. |
| Public documentation and architecture remain segmented and current. | Documentation | `npm run docs:style && npm run docs:links && npm run docs:ste && npx vitest run test/integration/package/documentation-structure.test.ts test/integration/package/architecture-documentation.test.ts test/scaffold/community-files.test.ts` | README routes to the canonical guide; command, architecture, status, roadmap, and release verification agree. | Does not rewrite historical release behavior. |
| The complete repository remains releasable. | Static, runtime, and security | `npm run check && npm run test:coverage && npm run test:browser && node scripts/smoke-compiled.mjs && npm run pack:check && node scripts/audit-prime-dependencies.mjs && npm audit --omit=dev --audit-level=low` | All static, runtime, coverage, browser, compiled, packed, dependency, and audit gates pass. | Does not constitute npm publication or a production release. |
