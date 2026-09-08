# Verification relay source admission and builds

These maintainer procedures check the reviewed source inputs and build a separate static baseline
for the observer-only RC-B relay. The baseline is not the restricted profile. The
[runtime custody design](../../docs/host-bridge-runtime-custody-design.md) owns the profile,
authentication caveats, and remaining qualification gates. Repairs remain disabled.

## Check reviewed inputs

Use a supported project Node.js version and a checkout containing this directory. This source-only
check runs on macOS or Linux; native relay qualification requires Linux x64.

1. Create an empty, private directory outside the checkout. Use its canonical absolute path.
2. Download the seven files identified by `inputs` in [source-manifest.json](source-manifest.json).
   Use each exact `url` and `path`. Require verified HTTPS and do not bypass certificate errors.
   Keep extracted files, public keys, and other files outside this input directory.
3. From the checkout root, check the local bundle:

   ```sh
   node native/verification-observer/build.mjs --check-relay-sources /absolute/path/to/source-inputs
   ```

   Success exits with status 0 and emits JSON with `verified: true`, `sourceOnly: true`,
   `inputCount: 7`, the Flow manifest's SHA-256 digest, and `relayQualified: false`.
   The command reads files only. It does not download, extract, apply patches, check signatures,
   compile, or execute source contents.

4. Exercise the real-source regression cases with the same bundle:

   ```sh
   FLOW_TEST_RELAY_SOURCE_ROOT=/absolute/path/to/source-inputs \
     npm run test:runtime -- test/runtime/verification-relay-source.runtime.test.ts
   ```

   Tests copy the real inputs into owned temporary directories and check rejection of changed
   bytes and invalid file types. Without `FLOW_TEST_RELAY_SOURCE_ROOT`, the real-bundle cases skip;
   that run is not positive source-admission evidence.

## Resolve a rejection

A source-integrity error exits with status 1. Check that the directory contains exactly the seven
regular files with the reviewed names, sizes, and digests. Do not use symbolic links or a source root
that resolves through a symbolic link. Acquire an incorrect file again from its reviewed URL.
Do not change the trusted manifest to make unknown bytes pass.

The checker uses the manifest beside its own module, not a manifest from the input directory.
Treat the Flow checkout and bootstrap as trusted inputs. Captured bytes do not establish executable
custody, and a successful check does not authorize using a system relay as a replacement.

## Build the static comparison baseline

Use a native Linux x64 host with a Linux x64 Docker daemon and Buildx. macOS can prepare the
source context. The build command checks reported host and daemon architecture, not emulation.
Emulation is not qualified. The dedicated hosted
qualification workflow supplies this environment without changing your Mac's host policy.

To inspect the captured source and build recipe without compiling, create a new context directory:

```sh
node native/verification-observer/build.mjs --freeze-relay-context /absolute/path/to/source-inputs /absolute/path/to/new-context
```

The command rejects an existing destination. It captures the checked source buffers and the trusted
local recipe. Do not edit the context and then describe it as the original captured input.

On native Linux x64, build into a new output directory whose parent already exists:

```sh
node native/verification-observer/build.mjs --build-relay-baseline /absolute/path/to/source-inputs /absolute/path/to/new-baseline
```

The command prepares one private context and uses two separate clean Buildx builders. It verifies
the musl patch results, builds static musl and socat, rejects ELF interpreter or shared-library
requirements, and compares every retained artifact. Source compilation has no network access.
Pinned images and a dated Debian package snapshot supply the build tools.

Success emits `built: true`, `baselineOnly: true`, and `relayQualified: false`.
`build-evidence.json` records input and artifact digests. The output retains original sources and
patches, recipe, license notices, configuration, libc archive, link map, toolchain inventory,
ELF inspection, and `socat-static-baseline`. This is development evidence, not a published package.

Each Docker build has a ten-minute deadline. An operation failure stops the comparison and reports
owned scratch for inspection. An existing output is never replaced. A failed publication might
leave a partial output without complete evidence. Do not use partial output as a passing result.
Artifact capture permits at most 32 MiB per file and 64 MiB in total as build resource guards.
Those bounds are not relay runtime limits or proof that an artifact is safe.

The baseline deliberately has no Flow argument, environment, or resolver wrapper. Real forwarding
qualification uses the [host-bridge test procedure](../../docs/testing-and-evaluation.md#qualify-the-static-relay-baseline).
The restricted profile and executable-custody gates remain open.

## Prepare the restricted profile comparison

The user approved the [wrapper-only dual license](../../docs/host-bridge-runtime-custody-design.md#apply-the-approved-linked-wrapper-license)
on September 8, 2026. The wrapper offers `Apache-2.0 OR MIT`, and the combined GPLv2 relay selects the MIT option.
Flow's main Apache-2.0 license and upstream licenses remain unchanged. This decision is not release approval.
Native compilation and execution remain unverified.

The separate profile context captures the same authenticated inputs plus the trusted
`restricted-relay.c` source, its license grant, and the root Apache-2.0 license text:

```sh
node native/verification-observer/build.mjs --freeze-relay-profile-context /absolute/path/to/source-inputs /absolute/path/to/new-context
```

This source-only command works on macOS or Linux. It records
`profile: "host-bridge-ipv4-loopback-v1"`, `baselineOnly: false`, and `relayQualified: false`.
The ordinary baseline context does not capture this wrapper.
The profile context records 17 captured inputs, including the two license texts.

Use native Linux x64 to build the profile comparison:

```sh
node native/verification-observer/build.mjs --build-relay-profile /absolute/path/to/source-inputs /absolute/path/to/new-comparison
```

Each clean build preserves the unwrapped `socat-static-baseline` before relinking the same
upstream objects with the separately compiled wrapper. The 39 compared artifacts include the
wrapper source and object, `flow-host-relay`, profile link map, ELF reports, symbols, and selected
disassembly. They also retain `licenses/flow-relay-MIT` and `licenses/flow-Apache-2.0` with the upstream notices.
The output still reports `relayQualified: false`. Follow the
[profile qualification procedure](../../docs/testing-and-evaluation.md#qualify-the-restricted-relay-profile)
for explicit rejection and real forwarding checks. Do not use this development executable as
the shared SRT relay or treat a successful build as runtime custody.
