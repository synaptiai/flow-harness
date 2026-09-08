# Verification relay source admission

This maintainer procedure checks the reviewed source inputs for the observer-only RC-B relay.
It does not build or qualify a relay. The
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
