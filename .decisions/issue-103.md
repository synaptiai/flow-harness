# Decision Journal: Issue #103 — Deterministic runtime ownership and cleanup evidence

**Issue**: #103 | **Branch**: `codex/issue-103-runtime-test-reliability` | **Started**: 2026-08-16

---

## Context

Pull request #102 changed the browser presentation host, but two unchanged runtime tests failed on
separate hosted Linux x64 attempts. The implementation commit first failed the container descendant
test, then passed unchanged. A documentation-only follow-up passed that test but failed the
cross-process run-identifier test. The failures therefore block unrelated work and make reruns a
weaker release signal.

## Root-cause evidence

- Node.js 26.7.0 states that timers do not guarantee exact callback timing or ordering. The existing
  descendant test compared a five-second host deadline with an eight-second timer in a different
  process. A delayed host callback could let the descendant write before correct cleanup began.

- The cross-process test required the winning run to execute a sandboxed command successfully.
  Its target contract is one durable run identifier, but an unrelated command failure made both
  public processes exit with code 1.

- The old ownership test failed deterministically in the restricted desktop environment because
  SRT could not create its Unix socket. The revised test passes there because it no longer invokes
  the command sandbox. It also passes repeatedly with full local socket access.

- Production cleanup stops the full-ID container, removes it, and confirms inspection returns
  absence before it reports confirmed termination. No production source is changed by this issue.

## Approaches considered

| Approach | Signal quality | Cost | Risk | Decision |
| --- | --- | --- | --- | --- |
| Use causal, invariant-specific test actions | Strong | Low | Test-only change | **Selected** |
| Increase delays or rerun failed CI | Weak | Low initially | Slow and still nondeterministic | Rejected |
| Add production quiescence or ownership behavior | Stronger product surface than required | High | Changes runtime semantics to repair tests | Rejected |

The selected descendant test arms a prepared child only after Flow reports confirmed cleanup. A
surviving child can then create a fixed marker. The selected run-ID test holds one run at its
existing command-approval boundary, so it proves one creation and one `run_exists` response without
executing a command.

## Specification

### Non-goals

- No production cleanup, retry, ownership, error, timeout, or sandbox change.
- No weaker assertion, retry allowance, CI-only skip, or widened relative timer margin.
- No macOS or Windows claim for the Linux x64 Docker boundary.

### Failure modes

- A descendant that survives confirmed cleanup observes the post-cleanup arm and writes the
  survival marker. The test fails.
- A descendant that never reaches the ready boundary cannot prove termination. The test fails.
- Zero or two public run creators produce the wrong exit-code pair or event ledger. The test fails.
- A command sandbox failure cannot decide the run-ID test because the admitted command is never
  executed.

### Interface contracts

- The descendant arm is created only after the command outcome reports a timeout and confirmed
  termination.
- The ready marker proves the descendant reached the observation loop before cleanup.
- The run-ID winner exits with the existing waiting-for-approval code and ledger state. The loser
  emits the existing fixed `run_exists` diagnostic.

## Verification map

| Criterion | Command | Expected evidence |
| --- | --- | --- |
| Public run-ID isolation | `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts -t "allows only one process"` | One waiting owner, one conflict, exact two-event ledger, no command execution |
| Adjacent compiled-process behavior | `npx vitest run --config vitest.runtime.config.ts test/runtime/cli-process.runtime.test.ts` | Complete file passes with host Unix-socket access |
| Causal descendant termination | `npx vitest run --config vitest.runtime.config.ts test/runtime/container-command-sandbox.runtime.test.ts -t "terminates descendants"` | Ready descendant cannot write after confirmed settlement |
| Complete Linux x64 boundary | `npm run test:runtime` | Runtime gate passes on the pinned hosted runner without a retry |
| Static and documentation quality | `npm run typecheck && npm run format:check && npm run lint && npm run docs:ste && git diff --check` | All static gates pass |

## Activity log

- 2026-08-16: Hosted run 31959528278 attempt 1 failed because `late.txt` already existed. The
  unchanged attempt 2 passed.
- 2026-08-16: Hosted run 31961261541 failed because both shared-run processes exited with code 1.
  The earlier container test passed in this run.
- 2026-08-16: Twenty unrestricted repetitions of the original ownership test passed locally. The
  restricted environment reproduced its unrelated SRT socket dependency.
- 2026-08-16: The causal descendant and approval-boundary designs were implemented in a disposable
  main-based worktree. The revised ownership test passed twenty restricted repetitions.

## Verification evidence

The revised focused ownership test passed twenty consecutive restricted repetitions. The complete
compiled-process file passed 14 tests with local Unix-socket permission. The portable serial suite
passed 3,655 tests in 257 files, with four tests and one file skipped. The local runtime suite passed
39 tests in eight files and skipped 34 Linux-only tests in ten files on Darwin.

`npm run build`, `npm run typecheck`, `npm run format:check`, `npm run lint`, `npm run docs:ste`,
scoped Biome, and `git diff --check` passed. The clean package-install check passed for archive
`5dfe0f1ccb0084305d1785bff67aeb9b9dc3c8a22a63e8ea44a5d780f8b053b4`. The root audit reported zero
vulnerabilities, and the Prime dependency audit passed for the Node lock and 60 Python packages.

The Linux x64 Docker descendant test and complete hosted gate remain pending. Local Darwin cannot
prove this boundary. The pull request must pass the hosted quality job on its first attempt before
the issue can close.
