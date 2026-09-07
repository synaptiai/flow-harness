# Native observer build foundation

This directory is for contributors preparing the Linux x64 observer. It preserves unchanged
upstream source and provides a separate observer-only patch and build mode. Neither artifact is a
qualified observer. Flow does not load the output in production issue runs.
`observer-result.h` implements the internal result-frame encoder. The observer-only build connects
it to the native process path. The unchanged upstream baseline does not include it.
The [verification repair design](../../docs/bounded-verification-repair-design.md) owns the
observer contract and the remaining implementation and qualification gates.

## Inspect the source

`source-manifest.json` records the exact Sandbox Runtime 0.0.70 commit, upstream paths, source
hashes, and build inputs. `upstream/` preserves `apply-seccomp.c`, `seccomp-unix-block.c`, and
`LICENSE` without changes. The source checker rejects changed bytes, symlinks, extra upstream
files, and changes to the recorded build inputs.

From the repository root, check the source without Docker or network access:

```sh
node native/verification-observer/build.mjs --check-sources
```

The expected result is `verified: true`. This result verifies local source identity only.

## Build and compare the upstream baseline

You need Node.js, Docker with Buildx, a Linux x64 Docker daemon, and network access to the pinned
container images and Debian snapshot. The launcher rejects other daemon architectures. It does
not start an emulated build or prepare a local Linux host.

Choose an output directory that does not exist. Its parent must already exist. To produce two
clean builds and compare every retained file, use:

```sh
node native/verification-observer/build.mjs --build /absolute/path/to/new-output
```

The launcher freezes the source and recipe bytes before either build. Each build uses a separate
BuildKit builder, the recorded Linux x64 image digest, and the same dated, signed Debian package
snapshot over HTTPS. The certificate bootstrap image and Dockerfile frontend are also pinned.
This recipe reuses existing repository image pins; it does not build Go or Lean.
`SOURCE_DATE_EPOCH=1785885248` is the pinned upstream commit's committer timestamp,
August 4, 2026, at 23:14:08 UTC, not the time of a local build.

`build.sh` compiles the original filter generator against the snapshot's libseccomp, generates
`unix-block.bpf`, and converts those exact bytes to `unix-block-bpf.h`. The header permits only
the native x86-64 application binary interface. The script compiles the unchanged upstream
helper, statically links it, removes build IDs, fixes build paths and timestamps, and rejects
an executable with a dynamic interpreter or shared-library dependency.

The output is named `upstream-apply-seccomp`, not an observer. `toolchain.txt` records installed
package versions, compiler and linker versions, and tool hashes. `build-evidence.json` records
the frozen source-manifest and recipe hashes, the actual output hashes, and the successful
two-build comparison. It explicitly records that observer qualification was not performed.

If a build or cleanup fails, inspect the reported owned scratch directory and any partial
output. The launcher does not overwrite an existing output directory or report success before
cleanup completes. Docker calls have bounded deadlines and captured output; filesystem cleanup
does not have a hard operating-system deadline.

The first hosted Linux x64 comparison passed in
[run 34147986514](https://github.com/synaptiai/flow-harness/actions/runs/34147986514).
Two clean builds produced 15 identical artifacts. The baseline helper SHA-256 was
`9883ef93f808fec05f95cdf71cb43642ef3ef825d7d9d73cb85417f1b0376d5d`.
This verifies reproducibility for that recorded source and recipe, not observer compatibility or
isolation. A later source or recipe change requires new evidence.

The existing hosted `proof-runtime` CI job runs this comparison after the proof acceptance tests.
It reuses that job's native Linux x64 Docker host and prints `build-evidence.json` only after a
successful comparison and cleanup. A failed comparison fails the job. This step does not load,
publish, or qualify the baseline as an observer.

## Build the observer-only application-result artifact

Use the same Linux x64 Docker prerequisites and a new output directory:

```sh
node native/verification-observer/build.mjs --build-observer /absolute/path/to/new-observer-output
```

This explicit mode freezes `observer.patch`, `observer-application.h`, `observer-result.h`, and
`host-bridge-guardian.c`
with the source manifest and build recipe. It applies the patch to a copy of the upstream source,
then builds `flow-observer-apply-seccomp` and its relinkable object. It preserves the unchanged
upstream artifacts and redistribution materials. The observer build adds the snapshot's `patch`
package. The default `--build` mode does not install that package or apply the observer patch.

The observer build also compiles `flow-host-bridge-guardian` and retains its relinkable object and
source. This separate executable owns trusted host-bridge processes during development tests.
It is not connected to the production SRT manager. Its first release-contract tests do not qualify
active descendants, complete interruption handling, or runtime custody. See the
[host-bridge test guide](../../docs/testing-and-evaluation.md#test-the-host-bridge-owner).

The launcher compares two clean builds before copying the results to the new output directory.
The `observer/` output directory retains the patch, both headers, original and patched source,
and source manifest. `build-evidence.json` records their identities and the build inputs.
Its purpose is `observer-application-result-build`. Its `observerQualification` remains
`not-performed`. Successful compilation or reproducibility does not qualify application results,
private-channel custody, policy interference, or repair enablement.

The focused hosted workflow uses the separate failure-controls mode described in the
[native transport testing guide](../../docs/testing-and-evaluation.md#develop-the-native-result-transport-independently)
to build this artifact alongside a deliberately broken negative-control executable. It supplies
distinct paths through `FLOW_TEST_NATIVE_OBSERVER_HELPER` and
`FLOW_TEST_NATIVE_OBSERVER_FALSE_NORMAL_HELPER`. The ordinary observer build remains available
without that control. No qualified observer artifact is included in the published package.

The first observer build and transport check passed in
[run 34154482610](https://github.com/synaptiai/flow-harness/actions/runs/34154482610) at `e615d44`.
All 23 artifacts matched across two clean builds. The observer binary SHA-256 was
`67f7fed7aef6b2bf63082bc05387164b26db02bc49454564a0829872acb6627d`.
The fixed application's private exit-7 result passed. This is one application-result control,
not qualification of failure paths, signals, protected writers, complete cleanup, or repairs.

The expanded transport gate passed all 266 cases without skips in
[run 34155655729](https://github.com/synaptiai/flow-harness/actions/runs/34155655729) at `063843a`.
It covers every normal exit code, real SIGTERM, invalid inputs, and selected kernel-enforced failure paths.
All 23 artifacts again matched across two clean builds; the observer binary hash remained unchanged.
Protected writers, immutable runtime custody, full cleanup, policy interference, and repairs remain unqualified.

The later [275-case qualification](../../docs/testing-and-evaluation.md#develop-the-native-result-transport-independently)
adds bounded writer-access and held-descendant evidence. The guide owns the current results and their
limits. The signal-state and false-normal expansion passed all 289 cases without skips in
[run 34159189998](https://github.com/synaptiai/flow-harness/actions/runs/34159189998) at `0255e9d`.
All 29 artifacts matched across two clean builds. The genuine observer binary and object remained
unchanged. The separate mutant binary SHA-256 was
`6d3cc6fd7f49a28f70e0d70e7cacd6f527d7471bae4e1b7b0a45b74bc5156c8b`.
These results qualify the tested controls only, not remaining reporting, cancellation, or isolation gates.

The explicit `--build-observer-failure-controls` mode preserves the genuine build and adds six files
under `test-controls/false-normal/`. They retain the test executable, relinkable object, source,
two headers, and mutation metadata. The mode changes only an owned copy of the exact worker failure
function. Its build evidence purpose is `observer-application-result-build-with-test-failure-controls`;
its qualification remains `not-performed`. Never distribute or use the negative-control executable
as the observer. Ordinary build and comparison modes do not admit these additional artifacts.

## Preserve redistribution materials

Keep the vendored Apache-2.0 license with the source and retain applicable notices. The build
output includes the application object, generated filter header and bytes, exact libc source
package downloads, and installed libc, libgcc, and libseccomp copyright and license texts.
The object supports relinking the unchanged application with a replacement compatible libc:

```sh
gcc -static -Wl,--build-id=none -o upstream-apply-seccomp upstream-apply-seccomp.o
```

This command requires a compatible Linux x64 compiler and the replacement static library.
Preserve this directory's source, manifest, and build scripts alongside any distributed output.
Before distribution, review the actual linked components and their requirements; the retained
materials are not a release-license approval. See the repository's
[third-party notices](../../THIRD_PARTY_NOTICES.md).

## Check the build tooling

To check the portable result encoder, you need a C11 compiler at `/usr/bin/cc` on macOS or Linux:

```sh
npx vitest run --config vitest.runtime.config.ts test/runtime/native-observer-encoder.runtime.test.ts
```

The three runtime cases compile and execute C controls. They compare encoded bytes against the
TypeScript decoder, including all normal exit codes, signal values, failure boundaries, and flags.
Invalid fields or buffer lengths must leave the output unchanged. Memory controls check boundary
bytes and overlapping correlation storage. Ordinary `npm test` does not require this compiler.
These checks establish frame compatibility only, not channel custody, execution identity, or Linux isolation.

The focused build-tooling tests use real files and subprocesses without Docker. Synthetic artifact trees test
comparison and rejection behavior only; they are not executable artifacts or native evidence.

```sh
npx vitest run test/integration/fixtures/verification-observer-build.test.ts --maxWorkers=1
```

For source-snapshot diagnostics, `--freeze-context ROOT NEW_DIRECTORY` writes a new frozen
context and reports its hashes without building. `--compare FIRST SECOND` compares complete
artifact trees without claiming their origin or native qualification. Neither operation
enables the observer or changes the sandbox policy.

The explicit `--freeze-observer-context ROOT NEW_DIRECTORY` and `--compare-observer FIRST SECOND`
operations provide the corresponding observer-input and artifact diagnostics. They do not build,
execute, or qualify the artifact.
