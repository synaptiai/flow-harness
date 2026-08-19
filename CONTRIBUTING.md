# Contributing

Flow welcomes focused issues and pull requests that preserve the harness boundaries documented in [architecture.md](docs/architecture.md).

## Development setup

Requirements:

- Node.js 26.7 or newer
- npm with lockfile support
- Git
- Linux or macOS with the native sandbox prerequisites listed in
  [Getting started](docs/getting-started.md#before-you-begin)

Install and verify:

```sh
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm run pack:check
```

Use `npm install` only when intentionally changing dependencies. Commit the resulting `package-lock.json` change and explain why the dependency is needed.

## Change workflow

1. Start from an issue with observable acceptance criteria.
2. Add or change a failing test before production behavior.
3. Keep Flow domain modules free of Pi, provider, filesystem, process, or UI types.
4. Keep commands as executable-plus-argument arrays; never add shell command strings.
5. Update the workflow specification when an executable contract changes.
6. Record copied or substantially adapted upstream code in `THIRD_PARTY_NOTICES.md` with its commit and license.
7. Run the complete local quality and package gates.
8. When changing capability-bundle format, acquisition, or storage behavior, update the architecture,
   security, recovery, sourcing, and workflow contracts together and add an adversarial regression.

Production modules may not contain mock executors, fake providers, fallback successes, placeholder results, or hidden network calls. Tests may use explicit test doubles at Flow-owned ports.

## Live provider tests

Default tests never use model credentials. To exercise a configured Pi provider explicitly:

```sh
FLOW_LIVE_PI_PROVIDER=<provider> FLOW_LIVE_PI_MODEL=<model> npm run test:live
```

The caller is responsible for provider cost and credential scope. Never commit credentials, transcripts containing secrets, or `.flow` run data from a private repository.
The command intentionally fails when either required variable is absent; it never reports a skipped live suite as success.

## Pull requests

Describe the user-visible outcome, the relevant architecture boundary, evidence for each acceptance criterion, failure modes considered, and the commands used for verification. Keep unrelated cleanup out of the change.
