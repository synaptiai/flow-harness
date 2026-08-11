# Third-party notices

Flow is licensed under the Apache License 2.0. It depends on or studies the following separately licensed projects.

## Pi

- Project: [earendil-works/pi](https://github.com/earendil-works/pi)
- Packages: `@earendil-works/pi-coding-agent` 0.84.0 and `@earendil-works/pi-ai` 0.84.0
- License: MIT
- Use: direct runtime dependencies behind Flow's agent-executor adapter
- Copied source: none

Pi's dependency packages retain their own license metadata in the installed dependency tree. A Flow distribution that bundles dependency source or binaries must preserve all applicable notices.

## Anthropic Sandbox Runtime

- Project: [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- Package: `@anthropic-ai/sandbox-runtime` 0.0.70
- License: Apache-2.0
- Use: direct runtime dependency behind Flow's command-sandbox adapter
- Copied source: none

Sandbox Runtime and its dependency packages retain their own license metadata in the installed dependency tree. Flow's profile and adapter are independently implemented. Pi's example extension was used as an architecture reference only.

## YAML

- Project: [eemeli/yaml](https://github.com/eemeli/yaml)
- Package: `yaml` 2.9.0
- License: ISC
- Use: direct runtime dependency for strict workflow parsing
- Copied source: none

## Zod

- Project: [colinhacks/zod](https://github.com/colinhacks/zod)
- Package: `zod` 4.4.3
- License: MIT
- Use: direct runtime dependency for workflow and event validation
- Copied source: none

## TypeBox

- Project: [sinclairzx81/typebox](https://github.com/sinclairzx81/typebox)
- Package: `typebox` 1.3.7
- License: MIT
- Use: direct runtime dependency for Flow-owned custom Pi tool schemas
- Copied source: none

## OMP

- Project: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
- Packages: `@oh-my-pi/pi-coding-agent` 17.2.12 and `@oh-my-pi/pi-ai` 17.2.12
- License: MIT
- Use: optional runtime dependencies for the native OMP evaluation adapter
- Copied source: none

OMP dependency packages retain their license metadata in the installed dependency tree. A Flow
distribution that bundles these packages must preserve all applicable notices.

## Bun

- Project: [oven-sh/bun](https://github.com/oven-sh/bun)
- Required version: attested official Linux 1.3.14 for the native OMP evaluation adapter
- License: MIT
- Use: external executable for the optional native OMP evaluation adapter
- Copied source: none

## Prime Agent

- Project: [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
- Package: `prime-agent` 0.7.1 from the official release archive
- License: MIT
- Use: optional runtime dependency inside the native Prime Agent OCI evaluation image
- Copied source: none

The OCI image keeps the package license metadata. A distribution that ships the image must preserve
all applicable Prime Agent and transitive dependency notices.
