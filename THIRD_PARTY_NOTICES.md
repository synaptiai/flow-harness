# Third-party notices

Flow is licensed under the Apache License 2.0. It depends on or studies the following separately licensed projects.

## Pi

- Project: [earendil-works/pi](https://github.com/earendil-works/pi)
- Packages: `@earendil-works/pi-coding-agent` 0.84.0, `@earendil-works/pi-ai` 0.84.0,
  and `@earendil-works/pi-tui` 0.84.0
- License: MIT
- Use: direct runtime dependencies behind Flow's agent-executor and terminal-renderer adapters
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

## Sigstore JavaScript

- Project: [sigstore/sigstore-js](https://github.com/sigstore/sigstore-js).
- Packages: `@sigstore/verify` 4.1.2, `@sigstore/bundle` 5.0.0, and
  `@sigstore/protobuf-specs` 0.5.1.
- License: Apache-2.0.
- Use: offline signed-bundle verification.
- Copied source: none.

Flow also embeds one immutable Sigstore public-good trusted-root target from
[sigstore/root-signing](https://github.com/sigstore/root-signing), commit
`e2dd69e9013072c308f5dd1800c27a8c2491cca2`, targets version 14. The target is public trust
material, not executable code. Its recorded SHA-256 is
`6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66`.

## The Update Framework JavaScript client

- Project: [theupdateframework/tuf-js](https://github.com/theupdateframework/tuf-js)
- Package: `tuf-js` 6.0.0
- License: MIT
- Use: standards-based repository metadata and delegated-target verification inside disposable
  Flow staging.
- Copied source: the minimal `tuf-on-ci-0.11` signed conformance fixture under
  `test/fixtures/tuf-conformance/`.
- Fixture revision: `theupdateframework/tuf-conformance` commit
  `672d7c00051efc97b3a9fa6f4ffa0aeb6647af03`.

tuf-js and its dependency packages retain their own license metadata in the installed dependency
tree. Flow owns the strict network adapter, durable repository state, package verification, and
activation boundaries.

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

## Lean

- Project: [leanprover/lean4](https://github.com/leanprover/lean4).
- Release: 4.33.1 Linux x64 archive.
- License: Apache-2.0.
- Use: compiler and kernel runtime in the optional locally prepared proof appliance.
- Copied source: none.

## Mathlib

- Project: [leanprover-community/mathlib4](https://github.com/leanprover-community/mathlib4).
- Revision: `0df444a360eaa60ab8c11dca51a86af692955474`.
- License: Apache-2.0.
- Use: exact admitted Lean library and dependency closure in the optional proof appliance.
- Copied source: none.

## Leanstral SafeVerify

- Project: [mistralai/LeanstralSafeVerify](https://github.com/mistralai/LeanstralSafeVerify).
- Revision: `fb9c583eb0ea96426d94625f89b7842c9dc1c313`.
- License: Apache-2.0.
- Use: kernel replay and observed-axiom reporting in the optional proof appliance.
- Copied source: none.

Flow builds the exact upstream source against the appliance's fixed Lean release. The source
archive and resulting executable have separate SHA-256 identities.

## lean4export

- Project: [leanprover/lean4export](https://github.com/leanprover/lean4export).
- Revision: `15f6055e299ad5b89345e533cc2192f4cc00f659`.
- License: Apache-2.0.
- Use: complete Lean environment export for independent proof checking.
- Copied source: none.

## Nanoda

- Project: [robsimmons/nanoda_lib](https://github.com/robsimmons/nanoda_lib).
- Revision: `68d5ca9db226849b41a6fff59d796ff19d0a8840`.
- License: Apache-2.0.
- Use: independent checking of the exported Lean environment in the optional proof appliance.
- Copied source: none.

The proof appliance is built locally from the exact source identities in
`proof-container/build-inputs.json`. A distribution that ships the resulting image must preserve
the applicable Lean, Mathlib, SafeVerify, lean4export, Nanoda, Debian, and transitive dependency
licenses and notices.
