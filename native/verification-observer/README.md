# Native observer build foundation

This directory is for contributors preparing the Linux x64 observer. It contains unchanged
upstream source, Flow's observer patch, and a build recipe, not a qualified observer. Flow does
not load its output.
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

## Review the observer patch

`observer/` holds Flow's changes. `upstream/` stays byte-identical to the pinned commit.

- `namespace-restriction.h` defines a seccomp filter that stops the workload and its
  descendants from creating or joining a namespace. An i386 system call kills the process.
  Every x32 system call and `clone3` return `ENOSYS`. `setns` returns `EPERM`. `unshare` and
  `clone` return `EPERM` when any namespace flag is set. Calls without namespace flags are
  unchanged, so ordinary processes and threads keep working.
- `apply-seccomp.patch` adds a modification notice to the helper header and one fail-closed call
  in the worker. The call runs after the helper's own namespace and mount setup, and before the
  workload filter and `execvp`. If the filter cannot be installed, the helper exits without
  running the command.

The build applies the patch to a copy with `--fuzz=0`, compiles the result with the upstream
warning flags, and produces `observer-apply-seccomp`. The offline test also compiles it with
`-Werror`. The source checker records both files by hash, so a changed
patch or header fails before any build.

An observer command opts in through the `namespaceRestriction` request field of
`executeLinuxObserverCommand`, which names the installed helper and its expected SHA-256. The
helper and every ancestor directory must be root-owned and writable only by root. Flow does not
ship or locate a default helper.

The filter does not record denied calls. A denial also outranks the upstream observation
filter, so the upstream observation channel does not report it. Policy-interference
observation, runtime integration, and kernel qualification remain separate gates in the
[verification repair design](../../docs/bounded-verification-repair-design.md).

To check the filter logic without Docker, run:

```sh
npx vitest run test/integration/fixtures/observer-namespace-filter.test.ts --maxWorkers=1
```

The test captures the filter instead of installing it and evaluates it against synthetic
system-call records. It also applies the patch and compiles the patched helper. It does not
run the helper or create a namespace, so it does not prove kernel enforcement.

## Build and compare the helpers

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

The script then applies the observer patch to a copy and builds `observer-apply-seccomp` the
same way. The unchanged upstream output is named `upstream-apply-seccomp`. `toolchain.txt`
records installed package versions, compiler and linker versions, and tool hashes. `build-evidence.json` records
the frozen source-manifest and recipe hashes, the actual output hashes, and the successful
two-build comparison. It explicitly records that observer qualification was not performed.

If a build or cleanup fails, inspect the reported owned scratch directory and any partial
output. The launcher does not overwrite an existing output directory or report success before
cleanup completes. Docker calls have bounded deadlines and captured output; filesystem cleanup
does not have a hard operating-system deadline.

Source checks, synthetic artifact comparisons, and a pinned recipe alone do not prove native
compilation, reproducibility, compatibility, or isolation. No artifact hash is supplied in advance,
and the hosted result below is a record, not a pin that later builds must match.

The existing hosted `proof-runtime` CI job runs this comparison after the proof acceptance tests.
It reuses that job's native Linux x64 Docker host and prints `build-evidence.json` only after a
successful comparison and cleanup. A failed comparison fails the job. This step does not load,
publish, or qualify the baseline as an observer.

The first hosted execution, before the observer patch existed, passed in
[`proof-runtime` at `30a9281`](https://github.com/synaptiai/flow-harness/actions/runs/37362795735/job/111969291228)
on October 5, 2026. Two clean builds produced identical trees of 15 retained files, with source
manifest SHA-256 `cfd742fbe7ed805aac70d48f00f7b61828acb81cdea5a2973913089c00682dce` and
`upstream-apply-seccomp` SHA-256
`9883ef93f808fec05f95cdf71cb43642ef3ef825d7d9d73cb85417f1b0376d5d`. The evidence records
`observerQualification: "not-performed"`. This result shows reproducible native compilation of the
unchanged upstream helper on one hosted Linux x64 runner.

The first hosted execution with the observer patch passed in
[`proof-runtime` at `ca3140d`](https://github.com/synaptiai/flow-harness/actions/runs/37489685721/job/112358826477)
on October 6, 2026. Two clean builds produced identical trees of 17 retained files, with source
manifest SHA-256 `3ef2d2f6f4c5ecfc56a4ddd8581ed3dcf54e9e714a59498d0f6432ebaf10d78f`.
`observer-apply-seccomp` has SHA-256
`9039d4e1ddcea9b2dbd0ad70652db43722212c953a94de2f0cbb45582c7c32f4`. `upstream-apply-seccomp`
kept SHA-256 `9883ef93f808fec05f95cdf71cb43642ef3ef825d7d9d73cb85417f1b0376d5d`, so the patch
build left the baseline unchanged. These results show reproducible compilation only. They do
not qualify compatibility, isolation, or kernel enforcement of the namespace restriction.

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
