import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
    expect(dockerfile).toMatch(
      /^# syntax=docker\/dockerfile:1\.17\.1@sha256:38387523653efa0039f8e1c89bb74a30504e76ee9f565e25c9a09841f9427b05$/m,
    );
    expect(dockerfile).toContain(
      "COPY --from=node-build /opt/flow/node/node_modules/prime-agent/dist/prime-agent-runtime /tmp/prime-agent-runtime",
    );
    expect(dockerfile).toContain(
      "pip install --no-deps --no-build-isolation /tmp/prime-agent-runtime",
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
});
