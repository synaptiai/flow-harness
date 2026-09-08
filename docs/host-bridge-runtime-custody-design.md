# Host-bridge runtime custody proposal

Status: research complete for the next decision; implementation and qualification have not started.
This proposal is for maintainers implementing the observer-only host bridge in issue #197.
It does not change the approved [RL-A lifecycle boundary](bounded-verification-repair-design.md#resolve-host-bridge-ownership-before-integration).
Selecting a restricted runtime profile requires a separate compatibility decision.

Runtime custody means binding execution to admitted code bytes and preventing those bytes from
changing through the owned process lifetime. It includes executable dependencies, not just a path.
The [usable-checkpoint plan](usable-checkpoint-plan.md) remains incomplete. Repairs remain disabled.

## Current evidence and remaining gap

At `4da0028`, the [guardian](../native/verification-observer/host-bridge-guardian.c) checks an
absolute canonical path, regular-file status, and executable access in `valid_arguments`.
Its child later calls `execve` with that path and the inherited environment.
These checks do not bind execution to immutable bytes or admit a dynamic library closure.
The passing [owner-loss qualification](testing-and-evaluation.md#qualify-bridge-owner-loss)
does not establish that missing property.

The installed SRT `0.0.70` implementation has two coupled relay roles:

| Role | Actual command and implication |
| --- | --- |
| Host bridge | `UNIX-LISTEN:PATH,fork,reuseaddr` to `TCP:localhost:PORT,keepalive,keepidle=10,keepintvl=5,keepcnt=3`. Process creation inherits the environment, working directory, identity, and host network. |
| Inner sandbox bridge | `TCP-LISTEN:3128,fork,reuseaddr` or port `1080` to `UNIX-CONNECT:PATH`. The same `socatPath` setting selects this executable. |

The source owner is upstream `src/sandbox/linux-sandbox-utils.ts`. The installed compiled functions
are `initializeLinuxNetworkBridge` and `buildSandboxCommand`.
The manager reuses one host bridge when the HTTP and SOCKS proxy ports match.
Changing `socatPath` globally would therefore change more than the host guardian's child.
The proposed first qualification must not replace that setting globally.

The latest hosted test used Ubuntu package `socat` version `1.8.0.0-4ubuntu0.1`, with canonical
path `/usr/bin/socat1`. Reviewing pristine upstream `1.8.0.0` does not establish that package's
complete source, patches, build options, or dependency identity.
Source review supports the fixed-command ancestry premise, but artifact-specific proof remains open.
The [Ubuntu package metadata](https://packages.ubuntu.com/noble/socat) lists libc, OpenSSL, and
libwrap dependencies. The native build manifest does not identify that installed relay and its
complete dependency set.

Upstream commit `2da070164d454971d5c970b5278e645051f0d0f7` uses ordinary fork in its
[connection-child path](https://third-party-mirror.googlesource.com/socat/+/2da070164d454971d5c970b5278e645051f0d0f7/xioinitialize.c).
Its [session and process-group changes](https://third-party-mirror.googlesource.com/socat/+/2da070164d454971d5c970b5278e645051f0d0f7/xioopts.c)
are explicit options absent from the admitted arguments. Inherited `SOCAT_*` variables also affect
execution waits and resolver preferences. The linked original source is hosted by a third-party
mirror. The reviewed upstream tag does not authenticate the installed Ubuntu artifact.

## Required flows and trust boundary

The user flow remains: request verification, execute admitted relays, verify the candidate, stop
owned processes, and classify evidence. Unknown custody or cleanup must prevent repair eligibility.

The operator flow is: install an identified Flow artifact, check the supported Linux profile, and
receive actionable rejection if required host features are unavailable. No privileged provisioning
or host-policy changes are assumed for the default path.

The system first validates the runtime identity and invocation, then establishes immutable custody.
It creates the owned relay, observes execution and readiness, and retains ownership through settlement.
Artifact admission is not a substitute for execution, readiness, or settlement evidence.

The design assumes a trusted host kernel and already admitted Flow bootstrap. It does not defend
against an administrator replacing the kernel or compromising the running controller.
Before integration, define how the bootstrap admits the guardian itself and protects the manifest.
A relay checksum must not imply that a mutable guardian launch or the entire Node runtime is qualified.
Candidate-controlled manifests and arbitrary operator-supplied digests are not trusted artifact identities.

## Compare runtime profiles

Each option must close code-loading paths and identify its accepted environment and resolver behavior.
None can both accept arbitrary runtime code injection and claim a fixed executable dependency set.

| Option | Benefit | Cost and compatibility constraint |
| --- | --- | --- |
| RC-A: Frozen dynamic runtime | Retains the selected glibc-based relay and can preserve a specific existing resolver profile. | Requires immutable executable, loader, libraries, and runtime-loaded modules. Must constrain all lookup paths and account for configuration and external resolver services. Highest implementation complexity without privileged provisioning. |
| RC-B: Packaged static relay, recommended for qualification | Reduces the code dependency set and permits descriptor-based execution of a sealed artifact. No administrator-managed image is assumed. | A static-musl build creates a distinct observer profile. It needs explicit resolver and environment constraints, reproducible builds, source notices, and compatibility qualification. It is not equivalent to arbitrary system `socat`. |
| RC-C: Administrator-provisioned verified runtime image | Can bind a larger glibc runtime and its paths to an identified image. | Requires image maintenance and host provisioning. External services and writable mounts still need boundaries. This adds operator burden and does not follow from Linux CI availability. |

Recommendation: approve RC-B for a restricted observer host-relay profile and staged qualification.
Preserve ordinary execution and proxy policy. Do not infer production admission from this selection.
If preserving a specific host NSS setup is essential, prefer RC-A and identify that setup first.
NSS means the Name Service Switch, which selects glibc name-service backends.
RC-C is an alternative for managed installations, not an automatic fallback.

The deciding tradeoff is explicit compatibility versus implementation and operator complexity.
The recommendation is an engineering judgment, not a claim that static linking guarantees safety.

## Evidence that challenges the recommendation

An open descriptor identifies a file object but does not freeze its contents. Linux
[file seals](https://man7.org/linux/man-pages/man2/F_ADD_SEALS.2const.html) can prohibit writes and
size changes. `F_SEAL_FUTURE_WRITE` is insufficient because existing writable shared mappings can
still change the file. A read-only bind mount of mutable backing storage is not an immutable copy.

Dynamic dependencies extend beyond a first dependency listing. The
[dynamic loader](https://man7.org/linux/man-pages/man8/ld.so.8.html) consults configured paths,
environment variables, its cache, and default directories. Glibc's
[hardening guidance](https://sourceware.org/glibc/manual/2.40/html_node/Dynamic-Linker-Hardening.html)
also identifies indirect code loading through NSS. A static ELF without `PT_INTERP` or `DT_NEEDED`
does not alone prove the absence of later code loading.

Musl documents [resolver differences from glibc](https://wiki.musl-libc.org/functional-differences-from-glibc.html).
Its [resolver implementation](https://git.musl-libc.org/cgit/musl/tree/src/network/lookup_name.c)
tries hosts-file lookup and then DNS for nonnumeric names. That moving source is research evidence,
not a release pin. `localhost` cannot be treated as an automatically equivalent numeric address.
Neither replacing it with `127.0.0.1` nor changing resolver configuration is authorized by RL-A alone.

Executable memory-backed files also have a host-policy boundary. The kernel's
[executable-memory-file policy](https://cdn.kernel.org/doc/html/latest/userspace-api/mfd_noexec.html)
can reject executable creation. A supported profile must use explicit flags and fail closed when
the host prohibits them. Flow must not weaken the host setting or use a mutable-path fallback.

For RC-C, [dm-verity](https://docs.kernel.org/admin-guide/device-mapper/verity.html) verifies a
read-only block device against a cryptographic root. It does not automatically authenticate that
root, close other executable paths, or include external services. Image custody still needs design.

## Proposed RC-B qualification sequence

These steps are pending the compatibility decision. They are not implementation claims.

1. Define the observer host-relay profile. Preserve exact arguments, working directory, identity,
   and host network. Enumerate accepted environment and resolver inputs. Reject unsupported inputs
   instead of silently removing them. Review both SRT relay roles before any later shared change.

   Define custody for configuration bytes and trust boundaries for external resolver services.
   Enumerating those inputs does not prove that they remain unchanged.

2. Select exact relay and libc sources after reviewing upstream fixes and distribution patches.
   Record source hashes, build options, licenses, dependency inventory, and resulting identities.
   Do not choose unpatched `1.8.0.0` solely because its behavior was inspected.
3. Audit the selected fixed-command code path and linked implementation for runtime code loading,
   extra execution, process-group changes, and ancestry changes. Inspect build outputs and link maps.
   Repeat this review when an admitted source or build option changes.
4. Specify and test the bootstrap-to-guardian admission boundary. Separate its trusted assumptions
   from the guardian-to-relay byte-custody mechanism. Protect manifest authority before consuming it.
5. Copy bounded artifact bytes into a private executable memory-backed file. Apply and verify
   write, growth, shrink, and seal-set protection. Bind executable-mode protection explicitly.
   Hash the sealed bytes and compare them with the trusted manifest before execution.
6. Execute the admitted ELF through
   [`execveat` with `AT_EMPTY_PATH`](https://man7.org/linux/man-pages/man2/execveat.2.html).
   Reject scripts and dynamic executables for this profile. Keep the descriptor close-on-exec.
   Do not introduce a script interpreter, PATH lookup, or fallback execution path.
7. Qualify mutation and wrong-artifact rejection with real owned files and processes. Include
   pathname replacement, same-inode modification, seal failure, unsupported host policy, and
   incorrect dependency metadata. Calibrate weak decisions before testing the actual admission rule.
8. Qualify actual forwarding and lifecycle behavior on Linux x64. Cover accepted IPv4 and IPv6
   configurations, held and concurrent connections, partial startup, cancellation, and owner loss.
   Compare the selected supported profile with the existing relay using the same traffic assertions.
9. Complete independent code and test review. Record source-specific evidence and update the
   architecture before manager integration. Keep separate stage 3 and stage 4 gates open.

Sealing before hashing binds the digest to stable bytes. It does not authenticate those bytes without
a trusted expected identity. Runtime tracing can corroborate reviewed code-loading paths, but one
successful trace cannot prove that all possible paths are closed.

## Failure handling and non-goals

Apply these outcomes to every proposed profile:

| Failure | Required behavior |
| --- | --- |
| Missing identity, invalid input, or unsupported profile | Reject before relay admission; do not substitute another executable or environment. |
| Copy, hash, seal, or executable-policy failure | Close owned descriptors and report unsupported infrastructure; do not start the relay. |
| Timeout, cancellation, or partial startup | Retain created ownership handles and use bounded cleanup. Unknown settlement remains unconfirmed. |
| Resolver or proxy unavailable | Report infrastructure failure, not a candidate defect eligible for repair. |
| Memory or descriptor exhaustion | Stop admission and preserve uncertainty about already created effects. |
| Owner loss or invalid private receipt | Reject settlement; later test-environment disposal cannot upgrade guardian evidence. |

This proposal does not qualify arbitrary candidate programs, the inner relay, or the entire host
runtime. It does not promise arbitrary NSS compatibility or containment of an escaping executable.
It does not replace the existing proxy implementation, authorize credential work or model calls,
enable repairs, or authorize a merge or release.
