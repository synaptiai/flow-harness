# Operate the Lean proof runtime

Use this runbook to prepare, verify, recover, or replace Flow's optional Lean proof appliance. The
appliance is a fixed Open Container Initiative (OCI) image that contains Lean, Mathlib, kernel
replay, and an independent proof checker. Flow supports this runtime only on Linux x64.

For workflow authoring, human statement approval, proof evidence, and qualification, read
[Verify an exact Lean statement](../guides/lean-proof-verification.md).

## Understand the support boundary

The supported preparation and execution host has these properties:

- Linux on x64 hardware.
- Docker Engine with API 1.51 and the Buildx plugin.
- A cgroup v2 hierarchy that enforces memory, swap, CPU, and process limits.
- At least 8 GiB of memory for the proof container, plus memory for Docker and the host.
- Enough local disk and time for three clean image builds.

Hosted continuous integration (CI) installs Docker Engine 28.3.3, containerd 1.7.27, and Buildx
0.26.1 on Ubuntu 24.04 x64. The checked-in BuildKit image is also pinned by digest. This combination
is the reference preparation environment.

Don't use macOS Docker emulation or Linux arm64 to make a supported runtime claim. You can author
and validate a proof workflow on macOS, but proof preparation and execution fail before proof work.
The appliance is container isolation on a shared Linux kernel, not a virtual-machine boundary for
hostile or multi-tenant workloads.

## Review the fixed build inputs

[`proof-container/build-inputs.json`](../../proof-container/build-inputs.json) is the authoritative
input manifest. It pins the platform, source archives, source revisions, archive hashes, base-image
digests, BuildKit image, seccomp profile, and reproducible timestamp.

The first profile contains these proof components:

| Component | Role | Fixed identity |
| --- | --- | --- |
| Lean | Compiles the target statement and submitted proof | 4.33.1 |
| Mathlib | Supplies the only admitted import, `Mathlib` | Commit `0df444a360eaa60ab8c11dca51a86af692955474` |
| Leanstral SafeVerify | Replays the compiled declaration and reports axioms | Commit `fb9c583eb0ea96426d94625f89b7842c9dc1c313` |
| lean4export | Exports the complete checked environment | Commit `15f6055e299ad5b89345e533cc2192f4cc00f659` |
| Nanoda | Independently checks the exported environment | Commit `68d5ca9db226849b41a6fff59d796ff19d0a8840` |

The source archive hash and built artifact hash are separate controls. The build checks the source
hash before extraction. The final image labels bind the actual supervisor, SafeVerify,
lean4export, Nanoda, and Mathlib manifest hashes.

SafeVerify's fixed revision targets Lean 4.29.1. Flow applies the digest-pinned
[`leanstral-safe-verify-lean-4.33.1.patch`](../../proof-container/patches/leanstral-safe-verify-lean-4.33.1.patch)
before it builds SafeVerify with Lean 4.33.1. The patch preserves SafeVerify's statement-name
skip list and axiom traversal while replacing a collector API that Lean no longer exports. The
input manifest binds the patch path and SHA-256 digest, and preparation refuses a changed patch.

## Prepare the appliance

Prepare the runtime from the Flow project that will use it:

```sh
flow runtime prepare lean-proof
```

Preparation performs these actions:

1. It verifies the local input manifest, profile, and seccomp digest.

2. It rejects a Docker host that isn't Linux x64.

3. It creates a digest-pinned BuildKit builder and makes a clean discovery build. The discovery
   build measures the actual proof-tool artifact hashes. Flow then runs one fixed theorem through
   the exact production containment, compiler, SafeVerify, Nanoda, and cleanup path.

4. It removes the discovery builder and image. It then makes two clean final builds with the
   measured artifact hashes in their labels.

5. It requires both final builds to produce the same immutable image ID.

6. It probes the image without network or Linux capabilities. The probe reports exact tool,
   dependency, profile, and artifact identities.

7. It writes `.flow/proof-runtime/attestation.json` with owner-only permissions after all checks
   pass.

The command returns the descriptor path, image digest, attestation digest, dependency-manifest
digest, profile digest, and local content-addressed image tag. Keep the attestation with the Flow
project. Don't copy an attestation from another image or edit its fields.

Preparation downloads public, digest-checked build inputs. Proof execution has no network and
receives no provider credential. Preparation is the only networked part of this profile.

## Verify a prepared identity

The verifier rechecks the attestation and installed image before every proof attempt. For an
explicit operator check in the source repository, use:

```sh
npm run proof:prepare:verify
```

Verification requires all of these identities to agree:

- The attestation digest and closed schema.
- The immutable Linux amd64 image ID.
- The profile and dependency-manifest digests.
- The Lean, Mathlib, SafeVerify, lean4export, and Nanoda identities.
- The built artifact hashes stored in image labels and returned by the probe.
- The two-clean-build reproducibility result.

A missing image, changed label, stale component, malformed attestation, or identity mismatch stops
the attempt before Flow creates a proof container.

## Understand effective containment

Flow asks Docker for the fixed policy in
[`proof-container/profile.json`](../../proof-container/profile.json). The supervisor then checks
the effective Linux state before it reads a proof request.

| Boundary | Effective policy |
| --- | --- |
| Network | Docker network mode `none`; only the loopback interface can exist |
| Filesystem | Read-only image root; no host bind mounts; sensitive kernel paths masked; `/proc/sys` and other standard system paths readable but read-only; disposable root-owned `/workspace` tmpfs with `nosuid`, `nodev`, and `noexec` |
| Credentials | Fixed environment, separate compiler homes, root-only checker home, and rejection of credential-like environment names |
| Namespaces | Private PID, interprocess communication, and cgroup namespaces |
| Privileges | `no-new-privileges`, seccomp filtering, all capabilities dropped except supervisor `CAP_KILL` and `CAP_SETUID` |
| Memory | 4,294,967,296 bytes; no additional swap |
| CPU | Two CPUs through a 200,000/100,000 microsecond quota and period |
| Processes | 128 cgroup processes and 128 user processes |
| Files | 512 open files, 268,435,456-byte file limit, no core dumps, and a 536,870,912-byte workspace |

The supervisor starts as UID 0 and GID 10001. It retains only `CAP_SETUID`, to enter the unprivileged
proof identity, and `CAP_KILL`, to terminate that identity's process group. It starts each compiler as
UID and GID 10001. The workspace root permits group traversal but not group writes. At first, only the
target tree exists. The supervisor compiles and locks that tree, then copies the target artifact into
a root-only verifier directory.

Only then does it create the separate submission tree and home. It locks and freezes that tree
after compilation. SafeVerify and Nanoda read only the frozen artifacts. The proof phase can't
change the frozen target. Neither compiler receives a project mount or the source specification.

The image assembles fixed, read-only module and shared-library search trees from the admitted
Mathlib dependency graph. At runtime, the supervisor calls the pinned Lean, SafeVerify, and
lean4export executables directly with explicit `LEAN_PATH` and `LD_LIBRARY_PATH` values. It doesn't
ask Lake to load or rebuild a project while it verifies a proof.

Every compiler and checker command gets a new process group. The supervisor kills the complete
group and reaps exited descendants before it freezes artifacts or starts the next checker. An
unconfirmed process-group removal fails the attempt.

The supervisor exits without structured proof evidence when any kernel check fails. Flow treats
that exit as a non-success and still attempts cleanup.

## Recover an interrupted attempt

Flow writes a durable lease before it asks Docker to create a container. The lease binds the run,
workflow, node, attempt, request, image, profile, container name, and full container ID when known.

When the same attempt resumes, Flow performs these actions:

1. It reopens the owner-private lease without following symbolic links.

2. It inspects the container by full ID or deterministic name.

3. It checks the image, labels, profile, request, identity, and effective host policy.

4. It stops and removes the exact container, then confirms that Docker reports it absent.

5. It removes the lease only after confirmed reconciliation.

Flow blocks automatic proof retry after it reconciles a prior effect. Start a new workflow attempt
only after you inspect the non-success evidence and decide that a new proof attempt is safe. An
unknown container identity, changed label, or unconfirmed removal remains blocked.

## Diagnose preparation and execution failures

Use this table to select the next action.

| Failure | Meaning | Action |
| --- | --- | --- |
| `requires one Linux x64 Docker Engine` | The Docker server platform is unsupported | Move preparation to a native Linux x64 host. |
| Two clean image IDs differ | The build isn't reproducible under the fixed inputs | Keep the prior attestation. Inspect timestamps, downloaded inputs, and BuildKit output; don't publish the new image. |
| Image labels contradict build inputs | A measured artifact or manifest changed | Remove the candidate image and review every changed input before updating the manifest. |
| Image probe contradicts the runtime | A tool, dependency, axiom policy, or artifact differs | Reject the image and rebuild from reviewed inputs. |
| Discovery runtime fails with a compiler category | The first clean image can't compile the fixed theorem under production containment | Use the content-free category to inspect module paths, shared libraries, filesystem access, or resources. Raw compiler output and proof text remain private. |
| Container inspection contradicts identity or policy | Docker didn't preserve the admitted lease or policy | Don't start proof work. Inspect the exact container, Docker daemon, and lease. |
| Supervisor fails closed | An effective kernel, source, compiler, or checker precondition failed | Inspect the private run evidence and hosted-runtime diagnostics. Don't infer proof rejection from an unstructured exit. |
| Cleanup is unconfirmed | Flow can't prove that the proof container is absent | Stop automatic retry. Reconcile the exact full container ID and retain the lease until absence is confirmed. |

Don't delete `.flow/proof-runtime/leases` to bypass recovery. A missing lease can remove the only
durable identity for an uncertain effect.

## Replace the runtime safely

Treat every toolchain, dependency, source-policy, seccomp, or resource-policy change as a new proof
profile:

1. Pin the new source revision, archive hash, base-image digest, and BuildKit digest.

2. Update the profile and its public support boundary.

3. Run Go supervisor tests, TypeScript contract tests, package checks, and documentation checks.

4. Let hosted Linux x64 CI build the image twice and run accepted, rejected, authority, recovery,
   cancellation, and cleanup cases.

5. Review the new image, attestation, checker agreement, and third-party notices before use.

Never reuse an old attestation or qualification report for a changed profile or image.
