# Issue 10: Public pre-alpha readiness

- Status: accepted for implementation
- Date: 2026-08-06
- Issue: https://github.com/synaptiai/flow-harness/issues/10
- Branch: `codex/issue-10-public-readiness`

## Outcome

Flow will present one honest public pre-alpha contract across its repository landing page, source
installation path, package metadata, contribution intake, support channels, automation, and
GitHub controls. This milestone prepares a public release but does not publish one.

## Observed baseline

- The repository is public and GitHub recognizes its Apache-2.0 license, README, contribution
  guide, code of conduct, and security policy.
- GitHub's community profile scores the repository at 87 percent because issue and pull-request
  templates are absent.
- The repository description is accurate but generic, and no discovery topics are configured.
- The scoped npm package is not published and the manifest version is `0.0.0`.
- The README starts with architecture and uses `npm install` without first explaining that the
  only supported installation path is a source checkout.
- GitHub Actions is enabled, but every recorded job was cancelled without a runner assignment or
  executed step. A fresh workflow dispatch is being used to distinguish availability from YAML
  defects.
- `main` is unprotected. Secret scanning, push protection, and Dependabot security updates are
  disabled.
- The public Synapti organization contact is `support@synapti.ai`; vulnerability reports already
  use private GitHub security advisories.

## Design

### Public information architecture

The README will lead in this order:

1. Product identity and pre-alpha warning.
2. Implemented capability summary and explicit limitations.
3. Supported-host prerequisites.
4. Source checkout, reproducible install, build, example run, and inspection.
5. Explanation of the evidence and sandbox output created by that run.
6. Architecture thesis and design principles.
7. Documentation, support, contribution, conduct, security, and license links.

The README will not advertise an npm install command, stability promise, hosted service, or
feature that does not exist. Badges are deferred until hosted CI has a durable green result.

### Package contract

The package remains version `0.0.0` and unpublished. Its manifest will nevertheless declare the
metadata required for an eventual public scoped release:

- a public-access publish policy;
- repository-derived homepage and bug-report URLs;
- bounded discovery keywords;
- current license, operating-system, engine, binary, and packaged-file contracts.

A scaffold test will fail before the metadata is added and will prevent accidental removal.
Publishing, tagging, and version selection remain explicit non-goals.

### Contribution intake

GitHub issue forms will provide separate bug and capability requests. Both ask for observable
current behavior or outcome, reproduction/context, acceptance evidence, and security impact.
Security vulnerabilities are redirected to the private advisory route rather than accepted in a
public form. A pull-request template asks for issue linkage, boundary impact, verification,
failure modes, and documentation changes.

`SUPPORT.md` will route usage questions to public issues, vulnerabilities to advisories, and
private conduct reports to the already-public organization support address. The code of conduct
will reference that concrete private channel.

### Repository controls

Repository discovery metadata will identify Flow as a provider-neutral coding-agent harness with
deterministic workflow graphs, durable evidence, and fail-closed sandboxed execution. Topics will
cover agent harnesses, coding agents, workflow engines, LLMs, sandboxing, TypeScript, and Pi.

Where GitHub exposes the capability, enable:

- secret scanning;
- push protection;
- Dependabot security updates.

Default-branch protection is applied only after hosted CI has produced successful check contexts.
Protection will require the verified quality and dependency-audit contexts, reject force pushes
and deletion, and allow maintainers to recover through GitHub's normal administrator controls.

### Hosted CI

The current workflow remains the behavioral reference because it already matches the complete
local gate. A no-runner cancellation is an infrastructure finding, not evidence that increasing
test timeouts or weakening the sandbox is correct. YAML changes are allowed only when logs show a
workflow defect. A pull request and the resulting default-branch update must each produce green
quality and dependency-audit jobs before the criterion is accepted.

The first hosted execution identified Ubuntu 24.04's AppArmor restriction on capability-bearing
unprivileged user namespaces. The quality job configures the documented SRT prerequisite on its
dedicated ephemeral runner; it does not enable SRT's weaker nested-sandbox mode. Public setup
guidance warns that the equivalent sysctl is host-wide and directs shared hosts to a scoped
AppArmor profile instead.

## Failure modes

| Condition | Required behavior |
| --- | --- |
| Package is still unpublished | README says source-only pre-alpha; no registry command is shown |
| Unsupported operating system | Prerequisites state Linux/macOS support before installation |
| Missing Linux sandbox dependency | Setup names the packages and the first run fails closed |
| Security report entered through an issue form | Form redirects the reporter to a private advisory |
| Conduct concern requires privacy | Support and conduct documents provide the organization address |
| Hosted runner remains unassigned | Record the external blocker; do not weaken tests or claim CI success |
| Required check name is unknown | Do not enable guessed branch protection contexts |
| GitHub security feature is unavailable | Record the API result and retain the strongest available setting |
| Package metadata drifts | Scaffold contract fails before publication |

## Non-goals

- Publishing to npm, selecting a release version, tagging, or creating a GitHub release.
- A documentation website, custom domain, logo, social preview, screenshots, or TUI.
- A CLA, DCO, foundation, steering committee, or long-term maintainer governance model.
- Changing Flow runtime behavior or weakening sandbox verification for hosted CI.

## Acceptance verification map

| Criterion | Verification |
| --- | --- |
| Pre-alpha and unpublished status is visible | README content assertions and manual first-screen review |
| Source first run is complete | Clean install, build, CLI help, validate, run, and inspect commands |
| Discovery metadata is accurate | GitHub repository API returns the description and topics |
| Contribution prompts are structured | Parse issue-form YAML and inspect required fields; PR template assertions |
| Private reporting is concrete | Documentation link/email assertions; advisory URL remains in security policy |
| Hosted CI is green | GitHub Actions reports success for both jobs on PR and default branch |
| Default branch rejects unverified changes | Branch-protection API returns required verified contexts |
| Security automation is enabled | Repository security-and-analysis API reports enabled states |
| Package is ready but unpublished | Scaffold test, package dry run, registry lookup remains absent |
| Community files are recognized | GitHub community-profile API reaches complete coverage |
| Full repository quality | `npm run check`, `npm run test:coverage`, package install smoke, audit |

## Review questions

- Does any onboarding instruction imply a published package or stable API?
- Can a new contributor distinguish usage support, conduct concerns, and vulnerabilities?
- Are repository controls backed by observed check names rather than assumptions?
- Does any setting change reduce maintainer recoverability or silently expand authority?
- Can every public claim be proven from the repository or GitHub API?
