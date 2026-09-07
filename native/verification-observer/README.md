# Native observer build foundation

This directory is for contributors preparing the Linux x64 observer. It contains unchanged
upstream source and a build recipe, not a qualified observer. Flow does not load its output.
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

The recipe has not yet been built or compared on a Linux x64 host. Source checks, synthetic
artifact comparisons, and a pinned recipe do not prove native compilation, reproducibility,
compatibility, or isolation. No artifact hash is supplied in advance.

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

The focused tests use real files and subprocesses without Docker. Synthetic artifact trees test
comparison and rejection behavior only; they are not executable artifacts or native evidence.

```sh
npx vitest run test/integration/fixtures/verification-observer-build.test.ts --maxWorkers=1
```

For source-snapshot diagnostics, `--freeze-context ROOT NEW_DIRECTORY` writes a new frozen
context and reports its hashes without building. `--compare FIRST SECOND` compares complete
artifact trees without claiming their origin or native qualification. Neither operation
enables the observer or changes the sandbox policy.
