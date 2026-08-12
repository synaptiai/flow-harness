import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { admitLocalEvaluationPlan } from "../../../src/infrastructure/fs/local-evaluation-plan.js";
import { primeExternalHarnessIdentity } from "../../fixtures/evaluation/prime-external-harness-identity.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Prime Agent package boundary", () => {
  it("ships the complete allowlisted OCI build context", async () => {
    const packageManifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly files?: readonly string[] };

    expect(packageManifest.files).toContain("prime-container");
    for (const path of [
      "prime-container/Dockerfile",
      "prime-container/build-inputs.json",
      "prime-container/go.mod",
      "prime-container/image-probe.mjs",
      "prime-container/package.json",
      "prime-container/package-lock.json",
      "prime-container/python-requirements.in",
      "prime-container/python-requirements.lock",
      "prime-container/seccomp.json",
      "prime-container/cmd/flow-prime-kernel-proxy/main.go",
      "prime-container/cmd/flow-prime-python/main.go",
      "prime-container/cmd/flow-prime-supervisor/main.go",
      "examples/evaluation/native-prime-agent-comparison.evaluation.yaml",
    ]) {
      await expect(access(resolve(repositoryRoot, path))).resolves.toBeUndefined();
    }
  });

  it("ships a default-deny seccomp policy with bounded socket authority", async () => {
    const profile = JSON.parse(
      await readFile(resolve(repositoryRoot, "prime-container/seccomp.json"), "utf8"),
    ) as {
      readonly defaultAction?: string;
      readonly defaultErrnoRet?: number;
      readonly archMap?: readonly {
        readonly architecture?: string;
        readonly subArchitectures?: readonly string[];
      }[];
      readonly syscalls?: readonly {
        readonly names?: readonly string[];
        readonly action?: string;
        readonly args?: readonly {
          readonly index?: number;
          readonly value?: number;
          readonly op?: string;
        }[];
      }[];
    };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(profile.defaultErrnoRet).toBe(1);
    expect(profile.archMap).toEqual([
      {
        architecture: "SCMP_ARCH_X86_64",
        subArchitectures: ["SCMP_ARCH_X86", "SCMP_ARCH_X32"],
      },
    ]);

    const allowedRules = (profile.syscalls ?? []).filter(
      (rule) => rule.action === "SCMP_ACT_ALLOW",
    );
    const allowedNames = allowedRules.flatMap((rule) => rule.names ?? []);
    const repeatedAllowedNames = allowedNames.filter((name, index) => {
      return allowedNames.indexOf(name) !== index;
    });
    expect(new Set(repeatedAllowedNames)).toEqual(new Set(["socket"]));

    for (const prohibited of [
      "bpf",
      "clone3",
      "delete_module",
      "finit_module",
      "init_module",
      "ioperm",
      "iopl",
      "kcmp",
      "keyctl",
      "mount",
      "open_by_handle_at",
      "perf_event_open",
      "pidfd_getfd",
      "process_madvise",
      "process_vm_readv",
      "process_vm_writev",
      "ptrace",
      "reboot",
      "setns",
      "unshare",
    ]) {
      expect(allowedNames, prohibited).not.toContain(prohibited);
    }

    const socketRules = allowedRules.filter((rule) => rule.names?.includes("socket"));
    expect(socketRules).toHaveLength(3);
    expect(
      socketRules
        .map((rule) => rule.args)
        .sort((left, right) => {
          return (left?.[0]?.value ?? 0) - (right?.[0]?.value ?? 0);
        }),
    ).toEqual([1, 2, 10].map((domain) => [{ index: 0, value: domain, op: "SCMP_CMP_EQ" }]));
  });

  it("binds the fixed dependency and seccomp inputs", async () => {
    const inputs = JSON.parse(
      await readFile(resolve(repositoryRoot, "prime-container/build-inputs.json"), "utf8"),
    ) as {
      readonly primeAgent?: {
        readonly version?: string;
        readonly url?: string;
        readonly sha256?: string;
        readonly integrity?: string;
      };
      readonly locks?: {
        readonly nodeSha256?: string;
        readonly pythonSha256?: string;
      };
      readonly seccomp?: {
        readonly sha256?: string;
        readonly base?: string;
      };
    };
    expect(inputs.primeAgent).toEqual({
      version: "0.7.1",
      url: "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.1/prime-agent-0.7.1.tgz",
      sha256: "d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb",
      integrity:
        "sha512-BOT+mqCYeDpKYabk3HVP5T7HomlBUWiQOXZGnX/DYZwT4xvdQSeF7itt/tCU8nv82/30N7VJw5YdXssEyD3qGQ==",
    });
    expect(inputs.locks).toEqual({
      nodeSha256: "9337bd288359dfb5f5722859cec2b3ac98fdf1d707337da25fa16bd02347d364",
      pythonSha256: "b681f2b4beb29bdef7ce4a0b7fef2cf6f24a0ab5e9974614d46bb72ea8ae9376",
    });
    expect(inputs.seccomp).toEqual({
      base: "moby/profiles seccomp/v0.2.1",
      sha256: "208652fe94e2b103095c48ffe5d9c3e8066680d4d9581eaf94943d06e216324f",
    });

    const dockerfile = await readFile(
      resolve(repositoryRoot, "prime-container/Dockerfile"),
      "utf8",
    );
    const sourceDateEpoch = ["$", "{SOURCE_DATE_EPOCH}"].join("");
    expect(dockerfile).toMatch(
      /^# syntax=docker\/dockerfile:1\.17\.1@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05$/m,
    );
    expect(dockerfile).toContain(
      "COPY --from=node-build /opt/flow/node/node_modules/prime-agent/dist/prime-agent-runtime /tmp/prime-agent-runtime",
    );
    expect(dockerfile).toContain(
      "pip install --no-deps --no-build-isolation /tmp/prime-agent-runtime",
    );
    expect(dockerfile).toContain("python -m venv --copies /opt/flow/python");
    expect(dockerfile).toMatch(
      /FROM \$\{PYTHON_IMAGE\} AS python-build\nARG SOURCE_DATE_EPOCH\nENV [^\n]*PYTHONHASHSEED=0 [^\n]*SOURCE_DATE_EPOCH=\$\{SOURCE_DATE_EPOCH\}/,
    );
    expect(dockerfile).toContain(
      `touch --date="@${sourceDateEpoch}" /out/flow-prime-supervisor /out/flow-prime-kernel-proxy /out/flow-prime-python`,
    );
    expect(dockerfile).toContain(
      `find /opt/flow/node -xdev -exec touch --date="@${sourceDateEpoch}" {} +`,
    );
    expect(dockerfile).toContain("rm -rf /opt/flow/node/node_modules/@mistralai/mistralai/tests");
    expect(dockerfile).toContain(
      `find /opt/flow/python -xdev -exec touch --date="@${sourceDateEpoch}" {} +`,
    );
    expect(dockerfile).toContain(
      "rm -rf /opt/flow/python/lib/python3.11/site-packages/tornado/test",
    );
    expect(dockerfile).toContain("--no-log-init");
    expect(dockerfile).toContain(
      [
        'touch --date="@',
        "$",
        '{SOURCE_DATE_EPOCH}" /etc/passwd /etc/group /etc/shadow /etc/gshadow',
      ].join(""),
    );
  });

  it("publishes one local command for each Prime release gate", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };

    expect(packageJson.scripts).toMatchObject({
      "prime:image:verify": "npm run build && node scripts/verify-prime-image.mjs",
      "docs:ste": "node scripts/check-docs-ste.mjs --changed",
      "ci:local": "node scripts/ci-local.mjs",
    });
  });

  it("does not embed the synthetic secret canary in the scanned production closure", async () => {
    const scannerSource = await readFile(
      resolve(repositoryRoot, "src/infrastructure/oci/prime-image-archive.ts"),
      "utf8",
    );
    const canary = `${["FLOW", "PRIME", "FORBIDDEN", "SECRET"].join("_")}_`;

    expect(scannerSource).not.toContain(canary);
    expect(scannerSource).toContain('["FLOW", "PRIME", "FORBIDDEN", "SECRET"].join("_")');
  });

  it("admits the public Prime comparison through the fixed profile", async () => {
    const admitted = await admitLocalEvaluationPlan(
      resolve(repositoryRoot, "examples/evaluation/native-prime-agent-comparison.evaluation.yaml"),
      {
        resolveExternalHarnessIdentity: async () => primeExternalHarnessIdentity(),
      },
    );

    expect(admitted.profiles.map((profile) => profile.adapter)).toEqual([
      "flow-workflow-v1",
      "prime-agent-native-v1",
    ]);
    expect(admitted.schedule).toHaveLength(4);
  });

  it("checks the public Prime example through the packed CLI", async () => {
    const verifier = await readFile(resolve(repositoryRoot, "scripts/verify-package.mjs"), "utf8");

    expect(verifier).toContain("native-prime-agent-comparison.evaluation.yaml");
    expect(verifier).toContain('["eval", "validate"');
  });

  it("pins the Docker toolchain and runs the shared local CI command", async () => {
    const workflow = await readFile(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const localCi = await readFile(resolve(repositoryRoot, "scripts/ci-local.mjs"), "utf8");
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
    const workflowCorePatternWrite = workflow.indexOf(
      "sudo sysctl --write kernel.core_pattern=core",
    );
    const workflowCorePatternCheck = workflow.indexOf(
      'test "$(cat /proc/sys/kernel/core_pattern)" = core',
    );
    const workflowReleaseGate = workflow.indexOf("run: npm run ci:local");
    const workflowDockerDiagnostic = workflow.indexOf("name: Diagnose Prime Docker availability");
    const readmeCorePatternWrite = readme.indexOf("sudo sysctl --write kernel.core_pattern=core");
    const readmePreparation = readme.indexOf("node dist/cli/main.js runtime prepare prime-agent");

    expect(workflow).toContain("docker_version='5:28.3.3-1~ubuntu.24.04~noble'");
    expect(workflow).toContain("containerd.io='1.7.27-1'");
    expect(workflow).toContain("docker-buildx-plugin='0.26.1-1~ubuntu.24.04~noble'");
    expect(workflow).toContain("{{.Server.APIVersion}}')\" = '1.51'");
    expect(workflow).toContain("{{.Server.Version}}')\" = '28.3.3'");
    expect(workflow).not.toContain("docker/setup-buildx-action");
    expect(workflowReleaseGate).toBeGreaterThan(-1);
    expect(workflow).toContain("ExecStart=/usr/bin/dockerd --host=unix:///var/run/docker.sock");
    expect(workflow).toContain("systemctl stop docker.service docker.socket containerd.service");
    expect(workflow).toContain("systemctl mask containerd.service");
    expect(workflow).toContain("rm --force -- /run/containerd/containerd.sock");
    expect(workflow).toContain("chmod 0711 /run/docker /run/docker/containerd");
    expect(workflowCorePatternWrite).toBeGreaterThan(-1);
    expect(workflowCorePatternCheck).toBeGreaterThan(workflowCorePatternWrite);
    expect(workflowReleaseGate).toBeGreaterThan(workflowCorePatternCheck);
    expect(workflowDockerDiagnostic).toBeGreaterThan(workflowReleaseGate);
    expect(workflow).toContain(
      "      - name: Diagnose Prime Docker availability\n        if: failure()",
    );
    expect(workflow).toContain("DOCKER_SERVICE_ACTIVE=%s");
    expect(workflow).toContain("DOCKER_PID_ALIVE=%s");
    expect(workflow).toContain("CONTAINERD_PID_ALIVE=%s");
    expect(workflow).toContain("DOCKER_SOCKET_PRESENT=%s");
    expect(workflow).toContain("DOCKER_VERSION_QUERY_SUCCEEDED=%s");
    expect(workflow).toContain("DOCKER_INFO_QUERY_SUCCEEDED=%s");
    expect(workflow).toContain(
      "if timeout --signal=KILL 10s docker version --format '{{json .}}' > /dev/null 2>&1; then",
    );
    expect(workflow).toContain(
      "if timeout --signal=KILL 10s docker info --format '{{json .}}' > /dev/null 2>&1; then",
    );
    expect(workflow).toContain('docker_pid="$(sudo cat /run/docker.pid 2>/dev/null)" &&');
    expect(workflow).toContain(
      'containerd_pid="$(sudo cat /run/docker/containerd/containerd.pid 2>/dev/null)" &&',
    );
    expect(workflow).toContain('[[ "$docker_pid" =~ ^[1-9][0-9]*$ ]] &&');
    expect(workflow).toContain('[[ "$containerd_pid" =~ ^[1-9][0-9]*$ ]] &&');
    expect(workflow).toContain("/run/flow-prime-runtime-v1.json");
    expect(workflow).toContain('ps --no-headers --pid "$containerd_pid" --format ppid');
    expect(workflow).not.toContain('ps --no-headers --ppid "$docker_pid" --format pid');
    expect(workflow).toContain('"default-runtime":"flow-prime-runc"');
    expect(workflow).toContain('"flow-prime-runc":{"path":$path,"runtimeArgs":[]}');
    expect(workflow).not.toContain("-H fd://");
    expect(localCi).toContain('[compiledCliPath, "runtime", "prepare", "prime-agent"]');
    expect(localCi).toContain("FLOW_PRIME_PREPARED_ATTESTATION");
    expect(workflow).toContain("useradd --create-home --groups docker flow-prime-peer");
    expect(workflow).toContain("FLOW_PRIME_TEST_SECOND_USER=flow-prime-peer");
    expect(readme).toContain("dedicated, reprovisionable Prime runner");
    expect(readme).toContain("chmod 0711 /run/docker /run/docker/containerd");
    expect(readmeCorePatternWrite).toBeGreaterThan(-1);
    expect(readmePreparation).toBeGreaterThan(readmeCorePatternWrite);
    expect(readme).toContain("non-piped host core pattern");
    expect(readme).toContain("/run/flow-prime-runtime-v1.json");
    expect(readme).toContain('ps --no-headers --pid "$containerd_pid" --format ppid');
    expect(readme).not.toContain('ps --no-headers --ppid "$docker_pid" --format pid');
    expect(readme).toMatch(
      /Do not use this setup on a\s+shared development host or on a host that serves Kubernetes or other `containerd` clients/,
    );
    expect(readme).toContain("recreate the runner from its trusted base image");
  });
});
