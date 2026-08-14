import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  primeAssistantText,
  primeAssistantToolCall,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const linux = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!linux)("Prime OCI hard resource limits", () => {
  it("matches cgroup, rlimit, I/O, byte, and inode controls", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Inspect the effective hard limits and write RESULT.json.",
      responses: [
        primeAssistantToolCall(
          "limit-probe",
          [
            "import json, os, resource, subprocess, sys",
            "def text(path):",
            "    return open(path, encoding='utf-8').read().strip()",
            "stats = os.statvfs('/workspace')",
            "file_probe = subprocess.run([sys.executable, '-I', '-c', \"f=open('/workspace/fsize-probe','wb',buffering=0); f.seek(268435456); f.write(b'x')\"], capture_output=True)",
            "try: os.unlink('/workspace/fsize-probe')",
            "except OSError: pass",
            "descriptors = []",
            "try:",
            "    while True: descriptors.append(os.open('/dev/null', os.O_RDONLY))",
            "except OSError:",
            "    pass",
            "finally:",
            "    for descriptor in descriptors: os.close(descriptor)",
            "result = {",
            "    'memory_max': text('/sys/fs/cgroup/memory.max'),",
            "    'memory_swap_max': text('/sys/fs/cgroup/memory.swap.max'),",
            "    'pids_max': text('/sys/fs/cgroup/pids.max'),",
            "    'cpu_max': text('/sys/fs/cgroup/cpu.max'),",
            "    'io_max': text('/sys/fs/cgroup/io.max'),",
            "    'nofile': list(resource.getrlimit(resource.RLIMIT_NOFILE)),",
            "    'nproc': list(resource.getrlimit(resource.RLIMIT_NPROC)),",
            "    'fsize': list(resource.getrlimit(resource.RLIMIT_FSIZE)),",
            "    'core': list(resource.getrlimit(resource.RLIMIT_CORE)),",
            "    'workspace_bytes': stats.f_blocks * stats.f_frsize,",
            "    'workspace_inodes': stats.f_files,",
            "    'open_descriptor_count': len(descriptors),",
            "    'one_over_file_failed': file_probe.returncode != 0,",
            "}",
            "open('RESULT.json', 'w', encoding='utf-8').write(json.dumps(result, sort_keys=True))",
            "result",
          ].join("\n"),
          1,
        ),
        primeAssistantText("The resource test is complete.", 2),
      ],
    });
    try {
      const result = JSON.parse(await readFile(`${session.workspace}/RESULT.json`, "utf8")) as {
        readonly memory_max: string;
        readonly memory_swap_max: string;
        readonly pids_max: string;
        readonly cpu_max: string;
        readonly io_max: string;
        readonly nofile: readonly number[];
        readonly nproc: readonly number[];
        readonly fsize: readonly number[];
        readonly core: readonly number[];
        readonly workspace_bytes: number;
        readonly workspace_inodes: number;
        readonly open_descriptor_count: number;
        readonly one_over_file_failed: boolean;
      };
      expect(result).toMatchObject({
        memory_max: "2147483648",
        memory_swap_max: "0",
        pids_max: "64",
        cpu_max: "200000 100000",
        nofile: [256, 256],
        nproc: [64, 64],
        fsize: [268435456, 268435456],
        core: [0, 0],
        workspace_bytes: 536870912,
        workspace_inodes: 8192,
        one_over_file_failed: true,
      });
      expect(result.io_max).toMatch(/\brbps=67108864\b/);
      expect(result.io_max).toMatch(/\briops=4096\b/);
      expect(result.open_descriptor_count).toBeLessThanOrEqual(256);
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
