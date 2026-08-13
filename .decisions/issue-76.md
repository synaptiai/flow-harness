# Decision Journal: Issue #76 — Evaluate Prime Agent RLM through the controlled external harness boundary

**Issue**: #76 | **Branch**: `codex/issue-76-prime-agent-adapter` | **Started**: 2026-08-10

---

## Research snapshot

The repository audit found no older open pull request. Issue #74 and pull request #75 are merged.
The delivery roadmap names Prime Agent as the next external harness target.

The research used these upstream states:

- Prime Agent release `0.7.1`, tag `v0.7.1`, commit
  `95afd31`, published on 2026-08-08.
- Prime Agent release archive SHA-256
  `d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb`.
- Prime Agent main commit `d698b4b7029d8445fd9e3be33603b7b31418481b`, inspected on 2026-08-10.
- Flow main commit `dbebabce34cb62c0e117d5002101f9cc416440a4`.

Prime Agent is based on Pi. Its product center is a persistent IPython Recursive Language Model
loop. It also includes recursive agents, daemon control, schedules, goals, and continual
refinement.

Prime Agent provides RPC, JSON, and TypeScript SDK surfaces. Its SDK can create an in-memory
session with an exact model, tool allowlist, resource loader, and recursion limit.

Prime Agent starts a Python kernel as a child process. The kernel needs IPython, ZeroMQ, and the
Prime Agent Python runtime. Its normal bootstrap can use the network. A Flow evaluation cannot use
that bootstrap.

Prime Agent states that its worker and kernel processes are lifecycle boundaries. They are not an
operating-system sandbox. Flow must supply the sandbox and process-tree boundary.

## Design question

How can Flow evaluate the real Prime Agent IPython loop while Flow keeps model, network, process,
workspace, evidence, and replay authority?

## Approaches

### A. Run the normal Prime Agent RPC command

Flow could start the standard Prime Agent RPC process and use its public message stream.

Advantages:

- The RPC interface is public.
- Prime Agent owns its normal lifecycle.
- Flow would need little Prime-specific driver code.

Problems:

- Normal provider calls need credentials in the child process.
- Normal startup can load ambient settings, resources, goals, extensions, and durable state.
- The daemon and kernel authority is wider than one isolated evaluation trial.
- Task-network denial prevents normal provider calls and runtime bootstrap.

Decision: reject this approach for the first adapter.

### B. Load Prime Agent in the Flow host process

Flow could import the Prime Agent SDK in the process that owns the evaluation.

Advantages:

- The SDK provides typed session control.
- Flow can set the model and tool list directly.
- Provider translation is simple.

Problems:

- Prime Agent and its dependency closure would enter the trusted Flow process.
- A defect could read verifier data, evaluation storage, Flow state, or provider credentials.
- Kernel cleanup would not isolate the harness from the evaluation owner.
- Offline commands could load Prime Agent through static imports.

Decision: reject this approach.

### C. Recreate Prime Agent behavior with the existing Pi adapter

Flow could add an IPython-like tool to the native Pi profile.

Advantages:

- Flow would control every line of the new behavior.
- The existing Pi broker and driver need small changes.

Problems:

- The result would not measure Prime Agent.
- Prime Agent session, prompt, tool, kernel, and continuity behavior would be absent.
- A comparison result could not support a Prime Agent claim.

Decision: reject this approach.

### D. Run a Flow-owned Prime driver under the current SRT profile

Flow could start a small Node driver under the same SRT profile as Pi and OMP.

Advantages:

- This reuses the complete Issue #72 process boundary.
- Provider credentials stay in the Flow host.
- The public evaluation plan remains declarative.

Problems:

- Prime needs five private TCP channels between Node and IPython.
- The current SRT profile blocks local binding.
- SRT permits host reads outside its named deny paths.
- SRT has no group PID, memory, CPU, or I/O quota.
- Arbitrary Python can exhaust the host before the deadline runs.

Decision: reject this approach for unrestricted IPython.

### E. Run a Flow-owned Prime driver in a fixed OCI container

Flow can start one immutable image by digest. The image can contain Node, Prime Agent, Python, the
Flow driver, and all native dependencies.

The OCI runtime can use a read-only root. It can use a quota-backed private workspace. It can
enforce private loopback, no external network, and hard resource limits.

Advantages:

- This uses the real Prime Agent session and persistent IPython kernel.

- Private loopback supports the five Jupyter channels.

- Network mode `none` exposes no host or external network.

- A read-only image removes host runtime discovery.

- Container limits cover PIDs, memory, CPU, file descriptors, and file size.

- Provider calls still use the private Flow protocol over standard input and output.

- One image digest binds the complete Node and Python execution closure.

Costs:

- Prime profiles require a supported OCI engine on Linux.
- Flow needs container-specific start, stop, inspection, and crash recovery.
- The image build needs a separate clean-runner gate.
- Recursive child agents still need a later multiplexed protocol.

Decision: select this approach.

### F. Use a hosted code-sandbox service

Flow could run Prime Agent through a hosted container or code-interpreter service.

Advantages:

- The service supplies resource and filesystem isolation.
- The local Flow process needs less sandbox code.

Problems:

- Evaluation would depend on one hosted runtime provider.
- Offline and local-first use would be weaker.
- Service credentials and pricing would enter the harness boundary.

Decision: reject this approach for the built-in profile.

## Selected architecture

### User flow

1. The operator declares `adapter: prime-agent-native-v1` and
   `config: prime-agent-rlm-evaluation-v1`.

2. Validation resolves one built-in Prime Agent identity. The plan cannot declare paths or
   versions.

3. Flow reads one trusted local runtime descriptor that the packaged preparation command created.

4. Flow binds the local engine, image, build, resource policy, driver, protocol, and broker.

5. Flow stores only the strict public identity in the evaluation header.

6. Each trial starts in a fresh private workspace.

7. Flow acquires the one-container global slot after it proves host resource headroom.

8. Flow prepares a bounded fixture transfer and a durable container intent.

9. The engine creates a private quota-backed workspace in the container.

10. Flow checks the created container policy before it starts the container.

11. The container starts with private loopback, no external network, and fixed resource limits.

12. The Node driver creates an in-memory Prime Agent session with no ambient resources.

13. A small supervisor starts the isolated Python kernel under a different user identity.

14. The model uses only `ipython`. Recursive `rlm(...)` calls fail at depth zero.

15. Prime Agent sends model contexts through the signed private control protocol.

16. The Flow host resolves the selected provider and model. It keeps credentials in the host.

17. The driver returns bounded outcome and metric evidence after the kernel stops.

18. Flow receives a bounded result transfer from the private workspace.

19. Flow confirms container exit and removal before it accepts the process result.

20. Flow applies the validated result, runs the verifier, and appends the terminal record.

21. Offline inspection reads only the stored header and trial ledger.

### Authority flow

```text
Evaluation plan
  -> fixed adapter and config selection
  -> trusted adapter registry
  -> exact OCI engine and image identity
  -> controlled process runtime
      -> read-only container and fixed cgroup limits
      -> quota-backed private workspace
      -> private loopback and no external network
      -> Flow-owned supervisor and Node driver
          -> real Prime Agent session
              -> separate-user persistent Python kernel
              -> private trial workspace only
              -> signed inference request -> Flow host broker -> provider
  -> bounded harness result
  -> private verifier
  -> durable evaluation evidence
```

The plan selects a known capability. It does not supply executable authority. The trusted registry
owns runtime resolution. Flow owns model, budget, process, evidence, and verification authority.

### Coupling analysis

The domain layer knows one more external identity and runtime variant. It does not import Prime
Agent, Python, OCI, or provider types.

The application adapter and private control protocol stay common. The production runtime dispatches
to SRT or OCI from the admitted identity.

Only the container driver imports Prime Agent packages. Offline commands use the stored identity.
They do not load Prime Agent or contact the OCI engine.

The npm package includes the runtime build context, locks, policies, launchers, and preparation
command. It does not install Prime Agent in the Flow host process.

A missing image or OCI engine rejects only a Prime profile. Pi, OMP, and Flow profiles do not
contact the OCI engine.

### Recursive-agent decision

Version one sets `rlmMaxDepth` to zero. The current protocol permits one pending inference request.
Prime child agents can produce concurrent requests and extra process authority.

A later protocol can add request identifiers, a bounded child count, and an explicit child budget.
That work is not part of this issue.

### Image delivery and build decision

The installed package provides `flow runtime prepare prime-agent`. This operator command builds the
fixed runtime before evaluation. An evaluation plan cannot invoke the command or change its inputs.

The package includes an allowlisted build context. The Dockerfile uses explicit `COPY` statements.
The context excludes the project, user configuration, credentials, and evaluation data.

The build pins each base image by digest. It uses exact Node and Python lock files. It verifies each
release archive and fetched artifact before an offline final build stage.

The preparation command sets `SOURCE_DATE_EPOCH`. It disables build data that contains host values.
It performs two clean builds and requires the same platform manifest and config digests.
Before build one, the command inspects the runtime and reports only one fixed failure stage. After
build two, it repeats the authoritative inspection and publishes only that later observation.

The build creates an external SBOM from the final image. It scans each saved layer for secret
patterns. A separate release gate audits the locked Node and Python dependencies.

Prime Agent declares `extract-zip` for optional helper installation. This Linux runtime does not
admit ZIP helper installation. The Node lock replaces that package with a local module that always
rejects. The image also removes the unused Prime command-line bundle that contains an embedded
extractor copy.

The AWS access-key check scans standalone 20-character identifiers. It does not classify an
`AKIA` substring inside a longer alphanumeric encoding as an identifier. The check permits only the
[canonical non-working example](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTAuthentication.html)
identifier. It rejects every other standalone match.

The SBOM generator removes timestamps, serial values, and host paths. Both clean builds must produce
the same canonical SBOM digest.

The command writes a strict local runtime descriptor under trusted Flow state. The descriptor binds
the image ID, OCI manifest digest, platform config digest, SBOM digest, build-input digest, and
policy digest.

The final-image probe also hashes the Flow driver closure and each native executable. The protected
descriptor stores these hashes. The host registry does not require container binaries on the host.

The final-image probe imports the exact Prime Agent and AI SDK graphs and requires each binding that
the Flow driver uses. Prime Agent requires its locked ZeroMQ native addon for IPython transport.
The Node driver permits this addon. The read-only image binds its bytes, and each writable mount is
`noexec`. The driver still uses the fixed seccomp profile, capabilities, user, and process-hardening
proof.

The Python closure contains a copied pinned base runtime, a virtual environment, and its non-glibc
shared-library dependencies under one `/opt/flow/python` root. The virtual-environment interpreter
is one closure-internal symbolic link to the base interpreter. The build derives the library set
from the pinned base and locked wheel bytes. It rejects different libraries with the same name.
It removes the unused Tk interface and rejects any other unresolved shared-library dependency.

The final Node image executes this interpreter with one fixed closure-only library path. It imports
the complete admitted Python package set before it creates the runtime users. This probe rejects a
closure that still depends on the Python build image. The image probe hashes the base runtime,
virtual environment, and shared libraries together. It reads the version from the nested virtual
environment.

The command never stores a provider credential. Evaluation uses `--pull=never` and rejects a missing
image. A later release can publish the same image. Version one does not require a registry.

### Immutable runtime decision

Evaluation never runs the Prime network bootstrap. The image build installs one locked Python 3.11
environment before evaluation.

The build verifies the official Prime Agent archive SHA-256. It uses locked Node and Python
dependency inputs. The external SBOM records the final image contents.

The image contains one Flow-owned kernel proxy and one fixed Python launcher. The launcher adds
isolated mode and imports the admitted kernel modules before it accepts the connection file.

The image has no user configuration. Its root is read-only during the trial. One bounded temporary
filesystem supplies the only Python-writable tree.

Docker owns `/etc/hostname`, `/etc/hosts`, and `/etc/resolv.conf`. Flow keeps all three Docker
mounts read-only. The supervisor does not rewrite them. Before it transfers a fixture or secret, it
requires three distinct read-only mounts and three bounded, root-owned, non-writable regular files.

The supervisor validates each mount information record. It selects only the root, three runtime
temporary filesystems, and three Docker system files as authority. Each selected path must occur
once. Repeated unrelated mount points do not change the selected evidence.

The supervisor admits only the Docker 28.3.3 `none`-network hostname and loopback host records. It
admits one closed legacy resolver document with the fixed DNS, search, and option overrides. The
readiness value contains only normalized records. It does not contain the host resolver path or
Docker comments.

The final image declares `HEALTHCHECK NONE`. Flow also creates the container with health checks
disabled. Image and container inspection reject any effective health-check command.

Flow creates the container from the exact image ID with pull policy `never`. It checks the image
directly before create and checks the resulting container before start.

A failed Docker start reports one fixed category for resource, cgroup, seccomp, filesystem,
process, or runtime-task work. Resource categories distinguish block I/O, memory, CPU, PID, and
process limits. Process categories distinguish entrypoint, working-directory, user-identity,
capability, no-new-privileges, AppArmor, and residual process-policy work.

Runtime-task categories distinguish file-descriptor setup, process synchronization, early process
exit, state recording, selected-runtime launch, and runtime-shim launch. They also distinguish stream
opening, stream copying, process-identity reading, execution setup, missing execution objects, a
missing runtime diagnostic, and residual task creation. Pinned runtime-init categories distinguish
init-binary preparation, init-process launch, isolated-device preparation, init policy, and network
defaults.

An unknown response reports only the status. Docker response text stays private. The category does
not change admission, retry, or cleanup.

### Fixed Prime session decision

The driver creates `SettingsManager.inMemory()` with one complete settings object. It disables
compaction, retry, refinement, packages, extensions, skills, prompts, themes, MCP, and built-ins.

The driver uses `SessionManager.inMemory()`. A Flow-owned no-I/O resource loader returns exact empty
values for every Prime resource method. The driver does not call the default loader.

The session starts with built-in tools disabled. The driver registers one custom `ipython`
definition from Prime's exported `createIpythonToolDefinition` function.

The custom definition sets its Python path to the exact kernel proxy. The driver activates only this
definition and disables goals, compact skill, autonomous mode, SDK automatic prewarm, snapshots,
schedules, traces, and recursive children. Before it creates the SDK session, the driver awaits one
startup of the caller-owned provisioner with the operation signal. Both tool calls reuse that
settled kernel. A startup failure closes the provisioner and stops before inference.

The driver sets `PRIME_AGENT_KERNEL_FORKSERVER=0`. No template kernel, fork socket, or forked child
can bypass the supervisor request.

The driver registers one synthetic provider in the Prime-local model registry. The marker is not a
provider credential. It only passes Prime local admission.

The driver replaces the Prime-local agent stream with the signed Flow broker stream. It imports all
Prime types and stream helpers from the nested Prime release closure.

Each broker response sends one terminal event and then ends its Prime event stream. The Prime
prompt does not settle until the stream ends.

The fixed configuration digest covers every option and the no-I/O loader above. A test changes each
ambient feature and requires rejection.

The digest also binds the exact kernel proxy and disabled fork-server value. A test requires one
supervisor kernel request and zero validation, bootstrap, template, or fork-server processes.

### Internal process boundary decision

A Flow-owned native supervisor is process one. It starts the trusted Node driver as user 10001. It
starts each Python kernel as user 10002 after one fixed request from the kernel proxy.

Node and Python use supplemental group 10003. Their separate primary groups and all other group
memberships remain fixed and empty.

The supervisor checks the peer user, executable, arguments, connection-file path, and process count.
Python cannot use the supervisor socket.

The pinned Prime provisioner creates one private directory with the exact name
`prime-agent-kernel-<six ASCII alphanumeric characters>` under `.flow-prime/control`. It creates one
Node-owned `connection.json` file in that directory with mode `0600`. Before sending the request,
the fixed Node-side kernel proxy opens that file without following links, proves the exact Node
owner, group, mode, type, and size. It changes only the file group to the admitted shared group. It
then changes the file mode to `0660`.

The random parent directory remains Node-owned mode `0700`, so Python cannot traverse to the shared
file. The supervisor accepts only that closed path grammar and settled
Node/shared-group file identity. It opens the directory and file with no-follow descriptor
operations and checks the exact owner, group, mode, size, and initial connection schema.

The initial connection record must use loopback TCP, five zero ports, HMAC-SHA-256, the `python3`
kernel name, and one 16-byte hexadecimal key. The supervisor copies that record to one separate
Python-owned file at `.flow-prime/tmp/connection.json` with mode `0600`. The fixed Python launcher
accepts only that path. This private copy lets the pinned Jupyter runtime unlink and recreate its
connection file without giving Python write access to Node's control directory.

The supervisor waits for the Python-owned file under one fixed deadline. It accepts only the same
loopback address, transport, signature scheme, key, and kernel name, plus five distinct nonzero TCP
ports. It writes one canonical resolved record through the already-open Node file descriptor. The
pinned Prime provisioner then reads the resolved ports from its original randomized path.

The workspace root and `.flow-prime` use user 10002, group 10003, and mode `0710`. Node can traverse
the exact control path, but it cannot list either ancestor.

The Python home directory uses user 10002, group 10002, and mode `0700`. The temporary directory
uses trusted supervisor user 0, Python group 10002, and mode `0770`. The supervisor creates the
connection record as owner. Python can replace it through its primary group. Node is not user 0 and
does not have group 10002, so it cannot access this directory. The control directory uses user
10001, group 10003, and mode `0770`.

Node cannot read the Python-owned connection file. Python cannot read the Node-owned connection
directory or file. All other driver state stays private to user 10001. The supervisor removes both
connection files and the randomized Node directory after kernel exit.

The kernel proxy relays only bounded status and error data. The supervisor stops the kernel if its
standard error exceeds the fixed limit.

The final Node process calls `PR_SET_DUMPABLE(0)` after its last execution step. It checks the value
immediately before it reads the protocol secret.

The supervisor sets and verifies `PR_SET_DUMPABLE(0)` before bootstrap. It sets soft and hard
`RLIMIT_CORE` to zero before it reads any fixture or protocol data.

Node and Python inherit the zero core limit. The startup gate checks each process limit. A crash
cannot create a workspace core or send one to the host core handler.

The driver passes an allowlisted environment to Python. That environment has no protocol secret.

Only the supervisor owns the attached container streams. Node standard input reads `/dev/null`.
Node standard output and error use private bounded diagnostic pipes.

Node receives one private supervisor socket for signed inner frames. The supervisor parses that
socket only as `flow-external-harness-jsonl-v1`. Raw outer frames fail.

The signed JSON form sorts object keys. Its strings use the Go JSON escapes for `<`, `>`, `&`,
U+2028, and U+2029. The transmitted JSON can use an equivalent JSON string form. The MAC input
always uses the fixed escaped form.

The Python launcher closes and unshares every inherited descriptor from 3 upward before kernel
startup. Python standard input and output use `/dev/null`.

Python standard error uses one bounded proxy pipe. Jupyter opens its own private loopback sockets
after launch. Python never receives an attached-stream or inner-protocol descriptor.

The fixed seccomp profile denies `ptrace`, cross-process memory calls, `kcmp`, namespace changes,
mounts, and new privilege paths. It also denies unsafe device and kernel operations.

The profile admits Unix, IPv4, IPv6, and route-netlink sockets. Pinned Jupyter and ZeroMQ use the
route-netlink socket only to resolve the container-private loopback interface before kernel bind.
The Python process has no network-administration capability, and network mode `none` supplies no
route to the host or an external network.

Different user identities prevent Python from reading Node memory, environment, or file
descriptors. They also prevent Python from sending signals to the driver.

The runtime tests attack `/proc`, process memory, inherited descriptors, and signals from Python.
Any access to the broker secret fails.

The tests also write forged outer frames through descriptors 0, 1, and 2. No forged byte enters the
supervisor output stream. The Python launcher closes every other inherited descriptor.

### Container resource decision

The fixed OCI profile uses network mode `none`. This mode supplies container-private loopback. It
does not route to the host or an external network.

The profile keeps `SETUID`, `SETGID`, `KILL`, `DAC_READ_SEARCH`, `CHOWN`, and `FOWNER` for the trusted
supervisor. The supervisor clears all capabilities from Node and Python before execution.

The supervisor uses `DAC_READ_SEARCH` only for stable result export. This authority lets it read and
traverse task entries after Python sets mode `000`.

The supervisor uses `CHOWN` and `FOWNER` only on descriptor-bound imported entries and connection
entries. It verifies identity before each ownership or mode change.

Fixture import finishes before secret delivery. The supervisor cannot apply these capabilities to a
path outside its already-open workspace or control roots.

The profile enables no-new-privileges and uses a read-only root filesystem.

The profile sets IPC mode `none`. It does not mount `/dev/shm` or a message-queue filesystem. No
additional anonymous writable mount is available to Python.

The profile sets fixed PID, memory, CPU, file-descriptor, process, file-size, output, and temporary
storage limits.

The profile disables swap through cgroup version two `memory.swap.max`. It applies fixed read-byte
and read-IOPS limits to the image backing whole device. If the Docker root uses a partition, Flow
resolves the canonical sysfs partition parent and verifies its exact block node. Linux `io.max`
rejects a partition device number.

Flow rejects an engine that cannot identify or limit the image backing device. Cached reads remain
bounded by the CPU and memory limits.

The workspace is a temporary filesystem with fixed byte and inode limits. A trusted bounded transfer
imports the fixture and exports the result. No host workspace is mounted.

Python uses `.flow-prime/home` and `.flow-prime/tmp` for its home and temporary paths. Flow rejects
that reserved top-level name in fixtures and omits it from results.

Node and supervisor state use separate protected mounts. Python cannot write those mounts. It cannot
write the read-only image or any container path outside the workspace.

Flow first sends one public attestation challenge. It contains the container, trial, image, identity,
and policy values. It does not contain the protocol secret.

The supervisor measures its effective controls and reports readiness against that challenge before
it starts the driver. Flow then sends one strict file manifest through the attached input stream.
Bounded chunks carry the admitted fixture bytes.

Network readiness reads the kernel interface and route tables with a 65,536-byte limit. It does not
open a netlink socket. The parser reports only normalized interface and route names.

An attached write accepts both Node success values. A non-Error operation or cleanup rejection
becomes one fixed stage error. Rejected private values do not enter that error.

The attached transport bounds container standard error to 65,536 bytes. If the supervisor exits,
Flow maps a recognized supervisor failure to one fixed startup or readiness stage. Unknown or
invalid text before readiness maps to one fixed early-exit stage. Unknown or invalid text after
standard output maps to one fixed runtime-failure stage. The private text and its cause do not enter
the public error.

The Node driver tags failures with one fixed internal stage. Go accepts only an exact stage from the
closed list. The host maps that stage to one fixed public message. Other fixed stages distinguish
driver process setup, hardening proof, diagnostic handling, and early child exit.

After readiness, fixed stages distinguish private-relay closure, kernel-service settlement,
workspace capture, result publication, and settlement publication. A nested operating-system,
workspace, or kernel error stays private.

Relay stages distinguish bootstrap validation and delivery, driver-channel read and write,
driver-frame validation, host-channel read and write, and host-frame validation. A stage does not
change authority, cleanup, or retry behavior. Raw child text does not enter a public error.

After the relay sends an authenticated terminal frame, the supervisor shuts down and closes the
private driver channel before it waits for the driver process. This order lets a driver that has
half-closed its output observe the supervisor close and exit. It prevents the supervisor and driver
from waiting for each other.

After a relay failure, the supervisor gives the failing driver one second to settle its bounded
diagnostic and exit. It then terminates the process group and waits for process settlement. This
grace period does not restart the driver or repeat an operation.

When the private driver channel closes without a fixed diagnostic, the supervisor reports one
fixed process outcome. The outcomes distinguish an ordinary exit, signal termination, and forced
settlement. Forced settlement distinguishes empty and nonempty unclassified diagnostics. A
non-EOF relay failure keeps its exact relay stage. No signal value or child text enters the public
error.

The bounded driver diagnostic can contain other private lines. The supervisor promotes one exact,
complete, allowlisted stage line only when all recognized stage lines agree. Other lines do not
enter the public error.

Readiness measurement stages distinguish process evidence, cgroup mode, PID, memory, CPU, image
block I/O, and process limits. Other stages distinguish filesystem mounts, runtime temporary
filesystems, network interfaces, network routes, and Docker system files. Each stage uses an
anchored supervisor-owned prefix. It does not publish a measured value, path, operating-system
error, or private suffix.

Each file and directory entry includes a normalized mode from `0o000` through `0o777`. Flow rejects
special mode bits.

A directory entry contains path, type, and mode. A regular-file entry also contains size and
SHA-256. Canonical entry values determine the manifest digest.

Manifests do not contain user or group identifiers. The supervisor first creates the workspace root
with temporary supervisor ownership and mode `0700`.

Each imported task entry uses user 10002 and group 10002 in the settled tree.

The supervisor first creates each directory with temporary supervisor ownership and mode `0700`. It
populates and synchronizes the complete subtree before it applies final directory values.

It applies descriptor-bound `fchown` and admitted modes to child directories from leaves to root.
It changes the workspace root to user 10002, group 10003, and mode `0710` last.

The reserved control directory keeps user 10001 and group 10003 as its fixed exception.

The transfer limits are 4,096 entries, 4,095 UTF-8 path bytes, and 255 bytes for one path component.
One file can contain 256 MiB. Each fixture or result can contain at most 256 MiB.

One raw file chunk can contain 64 KiB. Filesystem operations use descriptor-relative paths. They do
not add a staging-directory prefix to an admitted relative path.

A path is a nonempty portable relative path. It cannot start with `/` or contain a backslash or NUL.
It cannot contain an empty, `.` or `..` component. Each limit uses UTF-8 bytes.

The importer resolves each component beneath an already-open root. It uses no-follow operations and
rejects links, mount escapes, changed ancestors, and the reserved top-level name.

The outer protocol uses a one-byte type and a four-byte big-endian payload length. One payload can
contain 1,048,576 bytes. One encoded frame can contain 1,048,581 bytes.

An exact inner signed frame fits as one raw outer payload. File-chunk payloads have a separate
65,536-byte limit. The workspace temporary filesystem has 512 MiB and 8,192 inodes.

One fixture or result transfer can contain 16,385 frames and 304 MiB of encoded data. Signed driver
traffic can contain 512 frames and 132 MiB in each trial.

The transfer can contain at most 8,191 data-chunk frames. This limit includes per-file chunk
rounding under the 4,096-entry and 256 MiB limits.

Each attached stream can contain at most 457,179,136 bytes. The fixed Prime configuration permits
64 model turns and 64 `ipython` calls.

After all Python processes stop, the supervisor walks the stable workspace with no-follow
operations. It rejects links and special files, then sends one bounded result manifest.

The outer supervisor protocol is `flow-prime-container-v1`. It wraps the signed driver lines and the
workspace manifests in distinct strict frames. The fixed limits cover frames, files, paths, and
total bytes.

The strict state sequence is attestation challenge, readiness, fixture start, fixture entries,
fixture completion, and bootstrap. Signed driver frames follow. Terminal, result start, result
entries, result completion, and settlement finish the sequence.

The decoder accepts fragmented headers, fragmented payloads, and multiple frames in one read. It
rejects partial end-of-file, trailing bytes, and every undeclared frame type.

Each entry receives ordered chunks and one end marker. Duplicate paths, non-directory prefixes,
missing parents, inconsistent parents, chunk errors, and out-of-state frames fail before result
application.

The durable identity binds the protocol name, limits, host parser digest, and supervisor digest.
The registry checks both implementation digests before create and before start.

Flow validates every result path, type, count, size, and digest in a private host directory. It
also validates each normalized mode. It applies no result until the complete manifest passes.

Host result files use the current Flow user and group. Container user and group values never enter
the manifest or host result tree.

The result manifest is an authoritative full-tree snapshot. Flow prepares it in a new sibling
directory. It then uses a durable crash-recoverable directory replacement.

Flow never overlays result entries on the fixture. A missing fixture entry is a deletion. Recovery
settles an interrupted replacement before it classifies the trial.

The replacement supports file-to-directory and directory-to-file changes. A failed replacement
restores or retires the complete prior tree. It never exposes a mixed tree to the verifier.

A strict replacement journal stores the trial, target, staged, and retired names. It stores each
directory identity, the old snapshot digest, the result snapshot digest, and one phase.

The phases are `prepared`, `retired`, and `switched`. Flow synchronizes each staged file, then each
staged directory from leaves to root. It synchronizes the staged parent last.

Flow writes and synchronizes `prepared` before the first rename. It renames the target to the retired
name and synchronizes the parent. It then renames the staged tree to the target and synchronizes it.

Flow writes and synchronizes `retired` after the first rename and parent synchronization. It writes
and synchronizes `switched` after the second rename and parent synchronization.

Flow then verifies the new target and applies final modes. It verifies the retired tree before it
removes that tree. It synchronizes the parent after removal.

Recovery compares all names, identities, and digests. A prepared or retired change can roll back.
A complete switched change rolls forward and removes the retired tree.

Recovery runs before verification and before active-attempt classification. It removes the journal
only after final tree and parent synchronization.

The profile forces Docker log type `none`. Flow reads only the attached bounded stream. Docker does
not retain protocol frames or tool output.

The profile uses one packaged seccomp policy. Flow checks each effective mount, namespace, user,
capability, limit, log, restart, terminal, and standard-input value before start.

### Fixed OCI resource values

| Control | Version 1 value |
|---|---|
| `pids.max` | 64 processes |
| `memory.max` | 2 GiB |
| `memory.swap.max` | 0 bytes |
| `cpu.max` | 200,000 microseconds per 100,000-microsecond period |
| image read rate | 64 MiB per second |
| image read operations | 4,096 per second |
| open files | 256 per process |
| user processes | 64 |
| file size | 256 MiB |
| core size | 0 bytes |
| workspace | 512 MiB and 8,192 inodes |
| Node runtime mount | 16 MiB and 256 inodes |
| supervisor runtime mount | 16 MiB and 256 inodes |
| attached stream | 457,179,136 bytes in each direction |
| diagnostic standard error | 65,536 bytes |
| stop grace | 5 seconds |
| cleanup grace | 30 seconds |

### Global Prime admission decision

Version one permits one active Prime container on each local daemon. A durable global lease owns
this slot before any trial writes a container intent.

Flow publishes one fixed-name, non-running daemon lock object with an owner nonce and policy label.
The daemon name makes acquisition exclusive across processes and users.

The controller reconciles the global lease, lock object, private container leases, and daemon state.
A second process cannot create a Prime container while the slot is owned.

Flow removes the lock only when its private lease, full object ID, nonce, and policy match. A foreign
or unverifiable lock causes typed rejection and requires operator recovery.

The Linux CI gate creates a second Docker-authorized user and runs the cross-user race. The gate
fails if it cannot create or authorize that user. It does not skip the assertion.

Before create, Flow computes memory headroom from host `MemAvailable` and every applicable ancestor
cgroup. Each finite ancestor contributes `memory.max - memory.current`.

An ancestor value of `max` does not reduce the result. The minimum effective memory headroom must be
at least 4 GiB.

Flow computes PID headroom from the host process limit and each finite ancestor `pids.max` value. It
subtracts current use at each level. The minimum must contain at least 256 free PIDs.

Flow computes CPU capacity from online CPUs, the effective CPU set, and every ancestor `cpu.max`.
Each finite ancestor contributes quota divided by period.

An unbounded ancestor does not reduce the result. The minimum effective capacity must be at least
four logical CPUs.

Admission performs sixteen bounded Docker API probes before create. The 95th percentile must not
exceed 100 milliseconds.

During execution, the host repeats one bounded Docker API probe every 250 milliseconds. Three
consecutive slow results cause a typed policy termination and cleanup.

The public policy binds the one-container limit and each minimum headroom value. Raw parent-cgroup,
device, and measurement data stays in protected local attestation.

The engine must expose cgroup version two memory, PID, CPU, and I/O controllers. Flow rejects the
Prime profile when the engine cannot enforce and report one value.

### OCI engine decision

Version one uses the canonical local Docker Engine Unix socket. Flow ignores Docker contexts,
`DOCKER_HOST`, TLS, proxy, credential-helper, and client-configuration variables.

The public engine identity binds client and server builds, API version, kernel, containerd, and runc.
The server build includes the reported commit and the canonical live `dockerd` file digest. The
identity also binds cgroups, storage, rootless state, security options, and the policy digest.

Docker must configure `flow-prime-runc` with one canonical `runc` path and no arguments. The fixed
policy binds that runtime name, and Flow hashes the executable. Docker must use the exact canonical
Unix socket and its canonical daemon PID record.

Flow rejects socket activation and authority-moving daemon options. It also rejects those options
in the default daemon configuration. The Docker-managed `containerd` must be a direct daemon child.

The dedicated-runner setup gives non-root Flow traverse-only access to the managed Docker state
directories. Root also publishes `/run/flow-prime-runtime-v1.json` with mode `0444`. This strict file
binds the canonical Docker and containerd PIDs, executable paths, and live executable hashes. Flow
rechecks the PID records, direct-parent relation, file protection, paths, and hashes before use.

Protected local attestation binds the canonical socket identity, owner, mode, daemon ID, cgroup
path, image backing device, and effective engine settings. These values do not enter public records.

Local attestation also reads the host core pattern. Version one rejects a pattern that starts with
`|`. Public identity binds only the fixed reject-piped-core policy.

Flow uses a minimal Docker client environment. It checks the complete engine identity before create
and again before start.

The create command uses `--pull=never`, `--no-healthcheck`, no restart, and no terminal. It uses open
standard input, private namespaces, fixed cgroups, and log type `none`.

The stream policy binds `OpenStdin=true`, `StdinOnce=true`, all three attach values as true, and
`Tty=false`. Attached input closure makes the supervisor stop all children and fail.

Flow inspects the created container. A difference in any image, engine, workspace, health, mount,
limit, namespace, user, capability, seccomp, log, restart, or stream value rejects start.

The supervisor runs a startup gate before fixture transfer or secret delivery. It reports observed
users, capabilities, no-new-privileges, seccomp probes, mounts, quota values, cgroups, namespaces,
network routes, and stream state.

The readiness report also covers health configuration, dumpable state, core limits, swap, image
read I/O, IPC mounts, and each private mount limit.

The host compares every bounded readiness value with the admitted policy. A difference stops and
removes the container before model work starts.

Runtime tests change each reported startup value. They cover users, capabilities, privilege state,
seccomp, mounts, quotas, cgroups, namespaces, routes, and stream state.

### Durable lifecycle decision

Before a container intent, Flow writes and synchronizes a global-slot lease with name, nonce,
policy, daemon endpoint, and state `intent`.

After daemon-side lock creation, Flow records its full object ID and state `owned`. If the response
is lost, recovery resolves only the exact name and verifies the nonce and policy.

Before create, Flow writes and synchronizes one lease. It contains an owner nonce, container name,
labels, image ID, policy digest, fixture digest, and expected engine endpoint.

After create, Flow adds and synchronizes the immutable container ID and inspected policy. Only then
can Flow start the container.

Flow starts and attaches with no terminal. The supervisor waits for fixture transfer and one bounded
bootstrap frame before it starts the driver. The frame carries the protocol secret through standard
input. It does not use the container environment.

The lease schema permits `intent`, `absent`, `created`, `started`, `terminal`, `exported`, `stopped`,
and `removed`. New recovery retains `absent` only for version-one compatibility.

Evaluation recovery owns the lease before it marks the trial crashed or removes its workspace.
Recovery checks the exact ID, nonce, labels, image, and policy before it stops or removes anything.

Container inspection uses strict JSON objects with no prototype. Admission compares exact JSON
keys, value types, values, and array order. It does not use the parser object prototype as Docker
evidence.

An `intent` lease has no container ID. Recovery first resolves only its exact name on the stored
daemon. It verifies a found object's complete durable identity.

One lookup miss cannot prove absence after an interrupted create. Recovery issues one create with
the exact durable name and identity. This operation is a named-create fence.

The fence returns the prior object or creates the exact intended object. Flow records its full ID,
then stops and removes it. An unresolved fence produces a typed unsafe state.

This rule covers a crash after daemon-side create and before Flow receives the response. Recovery
never uses a label-only search.

Each state from `created` through `removed` requires the stored full container ID. A name or label
cannot replace it.

The evaluation store permits one lease owner. Recovery has count and time limits. A spoofed label or
different identity is not enough to authorize removal.

The operation deadline limits identity checks, create, start, model work, kernel work, and export.
Each pending attached-output read races this deadline. A separate fixed cleanup grace covers stop,
kill, inspect, and removal.

Flow does not accept success or start another trial until removal is proved. If cleanup is
uncertain, Flow keeps the lease and stops the evaluation with a typed unsafe-state error.

Flow removes and synchronizes the global daemon lock only after it proves trial-container removal.
A crash in slot removal keeps admission closed until exact recovery completes.

The driver constructs the pinned SDK `IpythonKernelProvisioner` and gives that provisioner to the
custom IPython tool. It awaits the same provisioner's `ensure()` operation before it creates the SDK
session. This preserves one kernel request across all tool calls and prevents a failed lazy startup
from becoming a replacement request.

The driver closes the in-memory SDK session with `dispose()`. It then uses the caller-owned
provisioner `kill()` operation before it sends the terminal frame. The restricted profile has no
snapshot, refinement, or child-session state that needs asynchronous SDK disposal. Version one does
not retain a kernel snapshot across trials. The pinned in-memory authentication storage has no
separate cleanup operation.

The driver sends signed, value-free progress events for prompt entry, inference-response receipt,
prompt settlement, and SDK cleanup. The hosted native fixture admits only that fixed progress set in
its timeout error. Progress does not change protocol authority, inference accounting, terminal
evidence, result publication, retry, or cleanup.

Kernel startup diagnostics distinguish connection preparation, Python launch, connection
resolution, readiness probing, and runtime bootstrap. An unknown startup error uses one fixed
fallback. These labels do not authorize a retry, a second kernel, or a policy change. Private SDK
and kernel text stays inside the driver process.

The supervisor kills and reaps every user 10002 process, including detached process groups. After
the driver settles, the supervisor cancels the active kernel runner before it waits for the kernel
service. The runner kills and reaps its process group. A final user-identity reconciliation rejects
any remaining Python process before export.

The supervisor closes new kernel requests and settles the active request before it walks the stable
workspace. The settlement gives the trusted kernel-request count. A second kernel request fails the
trial. The driver waits for export before it exits.

After export, Flow sends one settlement frame. The driver and supervisor exit. Flow then inspects and
removes the container before it applies the validated result directory.

## Specification

_Captured by specification-capture on 2026-08-10. Source: Issue #76 and upstream research._

### Non-goals

- This issue does not add recursive Prime Agent child agents.

- This issue does not retain memory, kernel state, or refinement state across trials.

- This issue does not start the Prime daemon, schedules, heartbeats, goals, or autonomous mode.

- This issue does not expose Prime RPC or TUI compatibility.

- This issue does not support macOS or Windows external-harness execution.

- This issue does not make OCI the runtime for Pi, OMP, or Flow profiles.

- This issue does not claim that Prime Agent or Flow is superior.

- This issue does not import Prime, Python, OCI, or provider types into durable Flow contracts.

- This issue does not let a plan select runtime paths, packages, models, providers, or endpoints.

- This issue does not protect against a trusted operator who replaces the Flow installation during
  a trial.

### Failure modes

- **Timeouts** — One operation deadline covers identity checks, image checks, container start,
  driver work, host inference, kernel work, and export. A fixed cleanup grace covers settlement.

- **Partial failures** — A started trial produces one terminal record. A crash after durable start
  does not retry the provider. Cleanup uncertainty cannot become success.

- **Invalid input** — Unknown adapters, configurations, identities, frames, metrics, and terminal
  results fail with bounded errors before they become evidence.

- **Missing context** — A missing OCI engine, image digest, cgroup-v2 limit, model, or exact thinking
  level rejects admission or the trial. Flow uses no fallback.

- **Cancellation** — Flow checks cancellation at each preparation boundary. It stops the exact
  container and confirms removal. No later trial starts before settlement.

- **Artifact drift** — Flow checks the admitted image digest directly before container start. A
  difference rejects the trial.

- **Bootstrap attempt** — The read-only container and denied external network prevent dependency
  installation. A bootstrap request fails.

- **Workspace escape** — The container can read its fixed image, private filesystems, and task data.
  Host paths, verifier data, Flow state, and sibling workspaces are absent.

- **Resource exhaustion** — Fixed OCI limits convert PID, memory, CPU, descriptor, output, byte, and
  inode growth into typed harness failures. The host remains responsive.

- **Cleanup uncertainty** — A missing stop or removal proof stops the evaluation. Recovery uses only
  an owned durable lease and exact container identity.

- **Broker-secret attack** — Separate user identities, a non-dumpable signer, and seccomp prevent
  Python from reading or changing the signed protocol channel.

- **Daemon drift** — A changed socket, daemon, low-level runtime, or effective policy rejects create
  or start. Ambient Docker configuration cannot select another daemon.

- **Output logging** — Docker log type `none` prevents daemon retention. The host still enforces the
  protocol and diagnostic byte limits on the attached stream.

- **Unavailable telemetry** — A metric that Prime Agent cannot prove is `null`. Flow does not infer
  zero.

### Interface contracts

- `EvaluationProfileSource` adds only
  `{ adapter: "prime-agent-native-v1", harness: { config: "prime-agent-rlm-evaluation-v1" } }`.

- `ExternalHarnessIdentity` adds one strict version 1 variant. It binds protocol, adapter contract,
  OCI runtime, resource policy, trusted image, and broker.

- The OCI runtime variant binds Docker builds, API, kernel, and low-level runtimes. It also binds
  cgroups, storage, rootless state, security options, and the complete policy digest.

- Protected local attestation binds the Docker executable, socket, daemon ID, backing device,
  cgroup path, and exact lease target. Public identity and evidence omit these raw values.

- The Prime image identity binds its image ID, OCI manifest digest, platform config digest,
  build-input digest, and software-bill-of-materials digest.

- The image build binds package `prime-agent`, version `0.7.1`, and the official release archive
  SHA-256.

- The image also binds Node, Python, IPython, pyzmq, Prime runtime, and native libraries. It binds
  the supervisor, kernel proxy, isolated Python launcher, no-I/O resource loader, and Flow driver.

- The fixed resource policy binds PID, memory, swap, CPU, image I/O, descriptors, and processes. It
  also binds file size, core size, workspace quotas, output, users, health, IPC, seccomp, logs, and network.

- The driver configuration digest binds every empty service and disabled ambient feature. It also
  binds model registration, session options, the IPython-only tool setting, and the turn limit.

- The driver uses `flow-external-harness-jsonl-v1`. No Prime RPC or SDK type becomes a durable Flow
  type.

- The host broker uses a closed assistant-message envelope. It preserves only bounded context,
  usage, continuity, and tool-call fields.

- The outer protocol identity binds `flow-prime-container-v1`, all transfer limits, the host parser
  digest, and the supervisor digest.

- Fixture and result manifests bind normalized modes for each regular file and directory. Flow
  rejects links, special files, duplicate paths, file prefixes, and inconsistent parents.

- The top-level path `.flow-prime` is reserved. Fixture admission and result application reject
  this name and each descendant.

- Runtime evidence records adapter `prime-agent-native-v1`, OCI containment, redacted engine status,
  image identity, policy digest, exit state, recovery outcome, and confirmed removal.

- `EvaluationAttempt` adds one optional strict OCI lease. Recovery settles this lease before it
  records a crash or removes the isolated evaluation workspace.

- The installed package includes the complete Prime image build context and lock files. The
  evaluation command never builds, pulls, or updates the image.

- Version 1 tuning-evidence export still rejects every external profile.

### Prime metric mapping

| Metric | Exact evidence rule | Missing evidence rule |
|---|---|---|
| `costUsdMicros` | Host broker applies `ceil(usd * 1,000,000)` to each response, then uses checked addition. | A response without complete cost evidence is malformed. |
| `inputTokens` | Host broker uses checked addition for the class across all completed responses. | A response without this class is malformed. |
| `cacheReadTokens` | Host broker uses checked addition for the class across all completed responses. | A response without this class is malformed. |
| `cacheWriteTokens` | Host broker uses checked addition for the class across all completed responses. | A response without this class is malformed. |
| `outputTokens` | Host broker uses checked addition for the class across all completed responses. | A response without this class is malformed. |
| `turns` | Count completed broker assistant responses. | `null` if the signed transcript is incomplete. |
| `toolCalls` | Count accepted `ipython` calls in the signed transcript. | `null` if the transcript is incomplete. |
| `toolErrors` | Count `ipython` results marked as error or aborted. | `null` if the transcript is incomplete. |
| `wallTimeMs` | Host starts before global admission and ends after container and slot settlement. It applies `ceil(end - start)`. | `null` if either timestamp is unavailable. |
| `activeTimeMs` | Version one does not retain a settled cgroup CPU source. | Always `null`. |
| `interventions` | Count cancellation, timeout stop, and policy termination events once during a live trial. | `null` for recovered attempts or an incomplete live ledger. |
| `policyViolations` | Version one cannot prove complete denial telemetry. | Always `null`. |
| `recoveryAttempts` | A new live trial has zero recovery attempts. | `null` for an attempt that required recovery. |
| `recoveryOutcome` | A new live trial has `not_attempted`. | `null` for an attempt that required recovery. |

Prime session totals do not prove availability. The adapter does not use a Prime zero when the
broker or runtime did not supply the source evidence.

All numeric sources must be finite, nonnegative, and within the safe-integer result range. Invalid
input or checked-addition overflow is a typed malformed-evidence failure.

An explicit complete zero stays zero. Tests cover fractional microdollars, per-response rounding,
fractional milliseconds, multiple responses, unsafe values, missing values, and every metric field.

Admission checks, slot operations, broker traffic, normal terminal stop, normal removal, and verifier
work are not interventions. Metric tests cover live conversion, explicit zero, and unavailable data.

## Acceptance criterion verification map

Native runtime rows require one shared Linux setup. The setup must succeed before any native row is
accepted as evidence. A platform skip is not evidence.

```sh
test "$(uname -s)" = Linux
export FLOW_PRIME_TEST_SECOND_USER=flow-prime-peer
FLOW_PRIME_TEST_RESULT_DIR="$(mktemp -d /tmp/flow-prime-image-result.XXXXXX)"
export FLOW_PRIME_TEST_IMAGE_RESULT="$FLOW_PRIME_TEST_RESULT_DIR/result.json"
trap 'rm -f "$FLOW_PRIME_TEST_IMAGE_RESULT"; rmdir "$FLOW_PRIME_TEST_RESULT_DIR"' EXIT
npm run prime:image:verify -- --output "$FLOW_PRIME_TEST_IMAGE_RESULT"
```

The named second user must already exist and have Docker socket authority. Clean CI creates that
user before it runs the setup.

| Criterion | Type | Verification command | Expected evidence | Does not promise |
|---|---|---|---|---|
| Admit the fixed Prime profile | Contract | `npx vitest run test/unit/evaluation/plan.test.ts test/unit/infrastructure/fs/local-evaluation-plan.test.ts` | Fixed config passes. Unknown config and authority fields fail. | Prime availability on all hosts |
| Bind the Prime OCI identity | Contract | `npx vitest run test/unit/infrastructure/prime/native-prime-harness-registry.test.ts test/unit/infrastructure/oci/local-prime-oci-runtime-inspector.test.ts test/unit/infrastructure/oci/prime-oci-image-device.test.ts test/unit/infrastructure/oci/local-prime-oci-currentness.test.ts test/unit/infrastructure/oci/local-prime-oci-attestation.test.ts test/unit/infrastructure/oci/prime-oci-preparation.test.ts` | Prepared identity binds engine, image, build, package, policy, and the exact image device. Fixed-stage preflight rejects before builds. Local adapter, host OCI, attestation, and admitted-identity drift reject. | Host signatures or hostile engine protection |
| Build the exact Prime image | Supply chain | `npx vitest run test/unit/infrastructure/oci/prime-image-archive.test.ts test/integration/package/prime-image-probe.test.ts && npm run prime:image:verify` | Exact archive and probe bounds and secret cases pass. The probe imports each required SDK binding, including the IPython provisioner and the pinned native addon graph. The pinned container build runs the Go tests. Its final Node stage executes the nested Python base, virtual environment, and derived shared-library closure. It imports every admitted Python package. These tests prove that the supervisor settles the workspace root last and admits only the fixed Docker system files. Two clean builds match. Archive, lock, layer, SBOM, and secret gates pass. | Registry publication |
| Diagnose Docker and Prime process failure | Contract | `npx vitest run test/unit/infrastructure/oci/docker-unix-api-client.test.ts test/unit/infrastructure/oci/attached-prime-oci-operator.test.ts test/unit/infrastructure/prime/native-prime-evaluation-driver.test.ts && (cd prime-container && go test ./internal/kernelcontract ./internal/supervisor ./internal/containerprotocol ./cmd/flow-prime-supervisor ./cmd/flow-prime-kernel-proxy ./cmd/flow-prime-python)` | Each admitted start-failure category is fixed. Pinned runtime-init diagnostics distinguish init-binary, init-process, isolated-device, init-policy, and network-default phases. Docker response text does not enter the public error. Attached writes accept both Node success callback values and reject an Error. A pending attached-output read settles on cancellation. Each Prime broker stream ends after its terminal event. Signed driver progress distinguishes inference receipt, prompt settlement, and SDK cleanup without private values. The driver starts its caller-owned IPython provisioner once, before SDK session creation, with the operation signal. Startup diagnostics distinguish connection preparation, Python launch, connection resolution, readiness probing, runtime bootstrap, and one closed fallback. Startup failure stops before inference and closes the provisioner. The driver synchronously closes the state-free in-memory SDK session and forcefully closes its caller-owned IPython provisioner. It does not wait for unused snapshot cleanup or call an unsupported authentication-storage cleanup. The supervisor closes the completed private relay channel before it waits for the driver process. It names fixed private-relay, kernel-settlement, workspace-capture, result-publication, and settlement-publication failures. Kernel service diagnostics distinguish request acceptance, repeated requests, peer validation, request reading, and result return before their closed fallback. The supervisor cancels and reaps the active kernel before it waits for the kernel service. It reconciles every Python process before export. The kernel proxy accepts only the pinned provisioner's randomized path grammar, validates the original Node-only connection inode, and settles only that file to the exact shared group and mode before the request. The supervisor admits that settled Node/shared-group zero-port record, bridges it to one private Python file, and copies back only the matching resolved identity with five distinct ports. An early Python exit wins over the live-process port deadline after one final validated connection read. Its bounded private diagnostic selects only a closed public startup stage. Bounded supervisor, readiness measurement, Docker system-file, driver-process, relay-boundary, and package-specific driver-SDK failures use closed fixed stages without private text. The driver gets one bounded settlement grace before process-group termination. Closed-channel exit, signal, and forced-settlement outcomes are distinct. Forced settlement distinguishes empty and nonempty unclassified diagnostics. One unique complete allowlisted stage line wins over other private lines. Non-EOF relay stages keep priority. | Recovery from an incompatible host |
| Audit locked runtime dependencies | Supply chain | `npm run build && node scripts/audit-prime-dependencies.mjs && npx vitest run test/integration/package/prime-agent-package.test.ts` | The exact Prime Node and Python locks pass the fixed audit policy. ZIP extraction stays disabled and absent from the final command-line closure. | Future dependency versions |
| Run a real persistent IPython session | Integration | `npx vitest run test/integration/prime/native-prime-agent-evaluation.test.ts` | One session keeps state across two turns. It uses one accepted kernel request. The caller-owned SDK provisioner settles before the driver exits. The supervisor settles the real Python process before export. The verified session publishes the validated result tree before it returns the host workspace. | Live provider quality |
| Exchange signed process frames | Integration | `npx vitest run test/unit/evaluation/external-harness-protocol.test.ts test/integration/prime/native-prime-agent-driver-protocol.test.ts && (cd prime-container && go test ./internal/containerprotocol)` | TypeScript and Go use the same fixed string escapes for signed frames. The compiled driver completes one signed tool exchange through fake inference. | Provider quality |
| Translate host inference | Contract | `npx vitest run test/unit/infrastructure/prime/native-prime-host-inference-broker.test.ts` | The broker preserves bounded Prime continuity and rejects unsupported fields. | New provider authority |
| Disable ambient Prime features | Security | `npx vitest run test/integration/prime/native-prime-agent-ambient.test.ts` | Each resource, service, session, recursion, retry, compaction, goal, and refinement input stays disabled. | General Prime compatibility |
| Protect the signed broker channel | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-process-boundary.runtime.test.ts` | Python cannot reach Node secrets or outer streams. Raw standard-descriptor injection fails. Mode `000` entries export. | Host-kernel compromise |
| Keep private data out of the child | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci.runtime.test.ts` | Private reads fail. Workspace writes pass. Writes to each other mount fail. Shared memory and message queues are absent. | Host-user isolation |
| Keep internal data out of results | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci.runtime.test.ts -t "reserved workspace data"` | Python can use reserved runtime paths. No reserved entry enters the validated result tree. | Retention of Prime runtime state |
| Deny external network and keep private loopback | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-network.runtime.test.ts` | Jupyter loopback works. Host loopback and external network fail. | Unsupported platforms |
| Reconcile effective controls | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-startup.runtime.test.ts && npx vitest run test/unit/infrastructure/oci/attached-prime-oci-operator.test.ts` | Each readiness group matches policy. Native startup proves that Docker system files stay read-only and match the normalized readiness contract. Changed readiness rejects before fixture and secret transfer. Non-Error operation and cleanup rejections become fixed stage errors. | Host-kernel compromise |
| Enforce global admission | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-admission.runtime.test.ts` | Independent processes and two required Docker-authorized users share one daemon slot. Setup failure fails the gate. | Multi-host cluster quotas |
| Reserve host headroom | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-admission.runtime.test.ts -t "host headroom"` | Exact and one-under host and ancestor memory, PID, and CPU cases follow policy. The three-sample latency case also passes. | Multi-host cluster quotas |
| Enforce hard resource limits | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-limits.runtime.test.ts` | Cgroup-v2 PID, memory, swap, CPU, I/O, descriptor, file, core, byte, and inode boundaries match. | Multi-host cluster quotas |
| Enforce transfer limits | Boundary | `npx vitest run test/unit/infrastructure/oci/prime-container-protocol.test.ts` | Path-component, file, frame, encoded-transfer-byte, and driver-byte checks follow policy. The 16,385-frame distribution passes. | Larger workspaces |
| Suppress daemon logs | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-logging.runtime.test.ts` | A noisy trial has log type `none`. Docker stores no protocol or tool bytes. | Host process tracing |
| Enforce the outer protocol | Contract | `npx vitest run test/unit/infrastructure/oci/prime-container-protocol.test.ts` | Nested trees pass. File prefixes, frame order, path, mode, digest, and bound mutations fail. | Protocol version two |
| Import and replace exact trees | Integration | `npx vitest run test/integration/oci/prime-container-workspace.test.ts` | Nested read-only trees import. Edit, delete, rename, ownership, mode, and type changes stay exact. | General archive compatibility |
| Recover result replacement | Recovery | `npm run build && npm run test:runtime -- test/runtime/prime-result-replacement.runtime.test.ts` | Crashes at six named replacement checkpoints recover one exact tree. | Recovery of foreign trees |
| Reconcile health and core controls | Security | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-startup.runtime.test.ts` | Startup readiness proves no health check, zero core limits, and non-dumpable trusted processes. | Host process tracing |
| Reject replay identity drift | Data | `npx vitest run test/unit/infrastructure/fs/local-evaluation-store-prime.test.ts` | Every Prime and OCI identity leaf and each adapter mismatch fails after re-digest. | Signed evidence |
| Fail closed on OCI runtime faults | Error handling | `npx vitest run test/unit/infrastructure/oci/local-prime-oci-harness-runtime.test.ts test/unit/infrastructure/oci/prime-container-lifecycle.test.ts test/unit/infrastructure/oci/local-docker-prime-oci-engine.test.ts test/unit/application/run-evaluation.test.ts` | Runtime, lifecycle, engine, timeout, cancellation, and cleanup faults fail closed. | Provider uptime |
| Settle native timeout and cancellation | Recovery | `npx vitest run test/unit/infrastructure/oci/local-prime-oci-harness-runtime.test.ts test/integration/prime/prime-container-runtime-helper.test.ts && npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-settlement.runtime.test.ts` | Unit evidence classifies timeout and cancellation. A timeout reports only the inference request count and the last allowlisted driver progress stage. Native elapsed deadline and operator cancellation remove the container. | Recovery of foreign containers |
| Recover every container transition | Recovery | `npm run build && npm run test:runtime -- test/runtime/prime-agent-oci-recovery.runtime.test.ts test/runtime/prime-agent-oci-admission.runtime.test.ts` | Crashes around global lock and container transitions settle exact leases. Create-response loss uses the exact name. | Recovery of foreign containers |
| Record honest metrics | Data | `npx vitest run test/unit/infrastructure/prime/prime-evaluation-metrics.test.ts test/unit/infrastructure/oci/attached-prime-oci-operator.test.ts test/integration/prime/native-prime-agent-evaluation.test.ts` | Each live field and conversion passes. Unavailable active-time and recovery data stay `null`. | Metrics that Prime does not expose |
| Keep inspect and export offline | Offline | `npx vitest run test/integration/cli/evaluation-offline-prime.test.ts` | Offline commands pass with runtime imports blocked. Unique socket, daemon, device, container, and lease markers stay private. | Offline trial execution |
| Publish clear docs and example | Documentation | `npx vitest run test/integration/package/prime-agent-package.test.ts test/scaffold/community-files.test.ts && npm run docs:ste && npm run pack:check` | Packed CLI checks the example. Public docs cover authority, limits, recovery, and offline audit. Changed prose passes STE. | Cleanup of old prose debt |
| Preserve existing adapters | Regression | `npx vitest run test/integration/cli/evaluation.test.ts test/integration/pi/native-pi-evaluation.test.ts test/integration/omp/native-omp-evaluation.test.ts` | Flow, Pi, and OMP integrations pass without changed authority. | Cross-profile quality equality |
| Pass all release gates | Release | `npm run ci:local` | The command matches clean CI, compiled smoke tests, image checks, package checks, and audit thresholds. | Future platform support |

## Implementation order

1. Add RED tests for the strict plan and identity union.

2. Add the Prime profile to durable plan, record, replay, and adapter contracts.

3. Add RED tests for the OCI engine, image, policy, and drift checks.

4. Implement the trusted Prime registry and adjacent image assertion.

5. Add RED tests for the host inference translation.

6. Implement the Prime host broker with the existing provider-neutral broker port.

7. Add RED tests for the real persistent IPython driver.

8. Implement the driver with an in-memory session and the fixed feature set.

9. Add RED tests for OCI create, inspect, start, attach, export, stop, removal, and recovery.

10. Implement the OCI runtime, fixed image build, resource policy, cleanup, and recovery.

11. Add offline loading, replay mutation, cancellation, and container-removal tests.

12. Add the public example and update all affected documentation.

13. Run focused gates, full CI, coverage, package checks, runtime tests, and adversarial review.

## Sources

- Prime Agent repository: <https://github.com/PrimeIntellect-ai/prime-agent>

- Prime Agent v0.7.1 release:
  <https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.7.1>

- Prime Agent architecture:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.1/packages/coding-agent/docs/architecture.md>

- Prime Agent RLM model:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.1/packages/coding-agent/docs/rlm.md>

- Prime Agent SDK:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.1/packages/coding-agent/src/core/sdk.ts>

- Prime Agent kernel bootstrap:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.1/packages/coding-agent/src/core/kernel/bootstrap.ts>

- Prime Agent package manifest:
  <https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.7.1/packages/coding-agent/package.json>

- Docker none network driver: <https://docs.docker.com/engine/network/drivers/none/>

- Docker container run reference: <https://docs.docker.com/reference/cli/docker/container/run/>

- Docker container copy limits: <https://docs.docker.com/reference/cli/docker/container/cp/>

- Flow OMP design: `.decisions/issue-74.md`
