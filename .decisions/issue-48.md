# Decision Journal: Issue #48 — Discover and bind portable Agent Skills packages

**Issue**: #48 | **Branch**: `codex/issue-48-portable-agent-skills` | **Started**: 2026-08-08 | **Status**: Design approved; implementation in progress

## Outcome and flows

### Author flow

1. The author places standards-conforming Agent Skills packages below the Flow project capability root.
2. The author lists or inspects the discovered packages and receives fail-closed diagnostics for malformed, duplicate, unsafe, or oversized content.
3. The author selects skill names explicitly on an agent node. Omission retains the existing no-skills behavior, and selection requires the node's declared read capability.
4. Workflow validation resolves every selected skill recursively across root, child, loop, and optimization workflows before a new run is admitted.
5. A run freezes the exact selected package bytes and identities. Later source changes cannot alter the attached run, queued detached run, child run, or resumed run.
6. The model initially receives only selected skill names, descriptions, and immutable resource URIs. It reads full instructions and supporting resources only when needed.

### Operator flow

1. The operator inspects run state and sees the exact capability snapshot digest, source provenance, package digests, license, compatibility, metadata version, permission request, trust state, and bounded file manifest.
2. Agent evidence identifies every selected package and every immutable package resource actually read during the attempt.
3. Recovery rejects missing, malformed, forged, or workflow-incompatible capability history rather than consulting live package sources.
4. Child and detached execution use the same snapshot validation and disclosure rules as attached root execution.

### System flow

1. Flow scans only the explicit project capability root with entry, depth, file, package, and serialized-snapshot bounds.
2. Discovery accepts regular directories and regular files only, rejects every symlink and special file, parses strict Agent Skills frontmatter, and rejects duplicate names.
3. Flow canonicalizes sorted package metadata and file identities, verifies every content digest, and calculates one provider-neutral snapshot digest.
4. The root run persists the bounded snapshot in `run_started`; detached submission also includes it in the immutable, authenticated job record before queue admission.
5. Child runs inherit the already-frozen snapshot. Resume obtains the snapshot from durable run history and never reloads live sources.
6. Flow formats only the selected catalog into its locked agent system prompt. Pi's ambient skills, extensions, prompts, themes, context, and built-in tools remain empty or disabled.
7. `flow_read` routes selected `skill://<name>/<path>` resources to snapshot bytes without filesystem access or additional workspace authority and records a read receipt.

## Research evidence

- The Agent Skills specification defines a `SKILL.md` package with required `name` and `description`, optional license, compatibility, metadata, and experimental `allowed-tools`; names are bounded and must match the parent directory: <https://agentskills.io/specification>.
- The official client guide defines three-tier progressive disclosure: catalog metadata at startup, full instructions on activation, and individual resources on demand. It also recommends bounded discovery, deterministic collision handling, explicit trust treatment, and dedicated activation when ordinary file reads are unavailable: <https://agentskills.io/client-implementation/adding-skills-support>.
- Pi discovers ambient project/user/package skills and exposes them through its resource loader. In the pinned Pi implementation, prompt formatting is coupled to the literal built-in `read` tool; Flow instead disables Pi tools and exposes `flow_read`, so adopting Pi discovery would both weaken replay and silently omit the catalog in Flow sessions: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md>.
- OMP uses metadata-first disclosure and confined on-demand skill resource addressing, while keeping skills distinct from executable extensions and hooks. Flow adopts those separation and confinement principles without adopting OMP's ambient package authority: <https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md>.

## Architecture approaches

| Approach | Summary | Simplicity | Replay | Authority | Portability | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| A. Normal Pi resource loader | Enable Pi project/user/package discovery and use Pi prompt formatting | High | Low: reloads ambient paths | Low: packages/extensions share Pi runtime | Pi-specific | Rejected |
| B. Flow catalog + immutable snapshot | Flow discovers strict local packages, persists selected bytes, formats metadata, and serves resources through Flow tools | Medium | High | High: no tool widening or ambient code | Provider-neutral | Selected |
| C. Full remote package manager | Add npm/Git/registry installation, dependency resolution, signatures, and executable extensions now | Low | Medium | High risk and broad attack surface | Potentially high | Deferred |
| D. Inline skill bodies in workflow YAML | Embed instructions directly on each node | High | High | Medium | Provider-neutral | Rejected: no reuse or progressive resources |

### Decision

Use **B, a Flow-owned local catalog and immutable bounded run snapshot**. The first Gate 6 slice supports standards-shaped local Agent Skills packages only. It does not enable Pi or OMP ambient discovery, package installation, extensions, hooks, or automatic scripts.

The snapshot is a provider-neutral domain contract rather than a Pi `Skill` type. The adapter receives selected packages through `NodeExecutionContext`, creates the locked catalog prompt, and extends the Flow-owned read tool with immutable `skill://` resolution. `allowed-tools` is retained as a requested permission string for audit but never changes a node's declared tools or policy actions.

### Coupling consequences

- The workflow domain owns selected skill names but has no filesystem or Pi dependency.
- The capability domain owns immutable package and snapshot validation/digests but no executor dependency.
- The filesystem adapter owns local discovery and exact-byte snapshot capture.
- The application runner owns binding, persistence, child inheritance, and recovery compatibility.
- The supervisor protocol owns detached transfer and immutable job identity.
- The Pi adapter owns prompt representation and tool-result representation, not package identity or authorization.
- No package can advance graph state, define evaluators, add tools, or authorize filesystem/network access.

## Specification

_Captured by specification-capture skill on 2026-08-08. Source: issue plus approved architecture proposal._

### Non-goals

- Does not discover user-global, `.agents`, `.claude`, Pi, OMP, npm, Git, URL, registry, or organization package sources.
- Does not install, update, resolve dependencies for, sign, publish, or remotely fetch packages.
- Does not execute package scripts automatically or load Pi/OMP extensions, hooks, prompt templates, themes, or context files.
- Does not add tool, evaluator, workflow, policy, UI, MCP, or provider-plugin manifests in this issue.
- Does not grant a selected skill any workspace, command, network, environment, transition, evaluator, or approval authority beyond the node and Flow policy.
- Does not interpret `allowed-tools` as authorization or translate foreign tool names into Flow tools.
- Does not provide binary/image decoding through the text-only `flow_read` contract.
- Does not make untrusted instructions safe; explicit workflow selection and recorded trust/provenance make their influence visible and bounded.
- Does not guarantee a cross-file atomic filesystem view while discovery is reading a package; it guarantees that the completed snapshot is immutable and content-verified.

### Failure modes

- **Timeouts and cancellation** — local bounded discovery performs no network calls. Agent timeout/cancellation retains selected-package and completed read evidence already captured by the attempt and follows the existing Pi cleanup/effect rules.
- **Partial failures** — any unreadable, changed-to-unsafe, malformed, duplicate, or over-budget selected package rejects the entire binding before `run_started` or detached durable admission. No partial snapshot is executable.
- **Invalid input** — invalid workflow skill identifiers fail schema compilation. Invalid frontmatter, directory-name mismatch, duplicate names, unknown selected names, unsupported URI forms, traversal, invalid UTF-8 instruction files, and forged digests fail with bounded typed errors.
- **Missing context** — a workflow selecting skills without a Flow project capability root or without a matching immutable snapshot fails before execution. Resume with missing capability history fails recovery and never consults live files.
- **Dependency outage** — none for discovery because the first slice is local-only. Provider failure after binding preserves immutable capability evidence and uses existing node failure semantics.
- **Resource exhaustion** — discovery caps scan depth, visited entries, package count, files per package, bytes per file/package, and final serialized snapshot. Every excess is a deterministic validation error before durable execution.
- **Source drift** — detached run submission freezes bytes before queue admission; attached execution freezes before `run_started`; child execution inherits parent bytes; resume uses ledger bytes. Source mutation after those boundaries has no effect.
- **Unsafe filesystem state** — capability roots, package directories, and files must be real; symlinks, sockets, devices, FIFOs, and traversal are rejected. Reads use no-follow regular-file handles and verify captured byte digests.
- **Prompt injection** — package instructions are explicitly selected untrusted input, structurally delimited, and incapable of adding tools or changing graph authority. They may still influence model text and use of already-declared tools, which remains visible in policy/effect evidence.
- **History forgery** — replay validates snapshot, package, and file digests; uniqueness; bounds; selected package compatibility; and child inheritance before accepting events.

### Interface contracts

- Agent source accepts optional `skills: [<Agent Skills name>]`. Names are unique, bounded by the Agent Skills syntax, and selection requires declared `read`; omission compiles to an empty immutable list.
- The project source root is `.flow/skills` below the discovered Flow project root. Discovery is recursive within fixed bounds and stops descending after a `SKILL.md` establishes a package root.
- A package snapshot records `kind: agent-skill`, name, description, optional license and compatibility, string metadata, requested tools, `project-explicit` trust, project-relative provenance, exact sorted files, file sizes and SHA-256 digests, and one package digest.
- A capability snapshot records version, sorted packages, and one SHA-256 digest. Its final serialized JSON is capped independently of the 2 MiB run-event limit.
- Package files are stored as exact base64 bytes. `SKILL.md` must be valid UTF-8. Text resource activation requires valid UTF-8; binary bytes remain reproducible and inspectable by digest but are not decoded by `flow_read`.
- The catalog exposes only name, description, digest, and `skill://<name>/SKILL.md`. Full instructions and resource bytes are absent from the startup prompt.
- `skill://` accepts one selected skill name and normalized percent-decoded relative path segments. Empty segments, `.`, `..`, encoded separators, credentials, query, fragment, NUL/control bytes, and non-selected packages are rejected.
- Agent evidence records selected `{name,digest}` identities and ordered resource reads `{uri,packageDigest,fileDigest,bytes}`. A package's optional requested tools are recorded in the run snapshot only.
- New runs containing skill selections require an exact snapshot; runs with no selections persist no empty snapshot and preserve existing behavior.
- Detached `run` submissions include the exact snapshot in command/job identity. Detached and attached `resume` obtain the exact snapshot from run history and reject a supplied mismatch.

## Plan-time verification map

| Acceptance group | Type | Command | Expected evidence | Does not promise |
| --- | --- | --- | --- | --- |
| Discovery, list, inspect, validation, bounds | Behavioral/error | `npm test -- --run test/unit/capability test/integration/cli/skills.test.ts` | Valid packages list deterministically; malformed, duplicate, symlink, special, traversal, and budget fixtures fail before binding | Remote/global discovery or binary rendering |
| Workflow selection and no-skills compatibility | Contract | `npm test -- --run test/unit/workflow/compiler.test.ts test/unit/capability/workflow-capabilities.test.ts` | Skill names compile immutably; duplicates/missing read fail; omission remains empty | Dynamic model keyword activation |
| Progressive disclosure and authority | Behavioral/security | `npm test -- --run test/unit/infrastructure/pi/workspace-read-tools.test.ts test/unit/infrastructure/pi/pi-agent-executor.test.ts` | Prompt contains metadata only; selected resources load on demand; requests never add tools/policy actions | Protection from malicious instruction meaning |
| Snapshot audit and replay | Contract/error | `npm test -- --run test/unit/run/capability-reducer.test.ts test/unit/application/run-workflow-capabilities.test.ts` | Exact identities and reads replay; forged/missing/mismatched snapshots fail | Tamper resistance without run-store filesystem protections |
| Attached/detached/child/recovery parity | Behavioral | `npm test -- --run test/integration/cli/skills.test.ts test/integration/supervisor/worker.test.ts test/unit/application/run-workflow-capabilities.test.ts` | Source drift after each admission boundary cannot change execution; children and resume reuse the same digest | Distributed package registries |
| Documentation and runnable example | Runtime | `npm run build && npm run pack:check` plus CLI list/inspect/validate smoke fixture | Packaged CLI documents and exercises authoring/discovery/selection | Live provider invocation |
