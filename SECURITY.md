# Security policy

## Reporting a vulnerability

Do not file a public issue for a suspected vulnerability. Use the repository's private [GitHub security advisory](https://github.com/synaptiai/flow-harness/security/advisories/new) form and include reproduction steps, affected revision, impact, and any known mitigation.

The maintainers will acknowledge a complete report, assess severity, coordinate a fix, and publish disclosure information when users can take protective action.

## Supported code

Before the first stable release, security fixes target the latest revision on `main`. There is no promise of backports to earlier commits or `0.x` package snapshots.

## Current trust boundary

Flow and embedded Pi run with the invoking user's operating-system permissions. The current release has no built-in sandbox and is intended for local, trusted workspaces.

- Agent sessions receive a Flow-owned system prompt and an exact read-only tool allowlist.
- Pi project extensions, skills, templates, themes, and context discovery are disabled.
- Command nodes use explicit argument arrays with shell parsing disabled.
- Run events are synced before scheduler advancement and replay fails closed on committed-record corruption.

These controls reduce accidental authority but do not contain a compromised process, malicious dependency, hostile workflow, or vulnerable tool. Use a container, microVM, or stronger operator-controlled boundary for untrusted or unattended work.

Workflow files and command nodes are trusted configuration. They can execute arbitrary programs with inherited environment variables. Review them before running and scope credentials outside the Flow process where possible.

Command output, agent text, executable arguments, and failure messages are persisted in the run ledger as evidence. They can contain secrets emitted by tools or providers. Keep `.flow/runs` private, apply repository ignore rules, and redact sensitive output at its source.
