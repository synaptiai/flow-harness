import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  primeAssistantText,
  primeAssistantToolCall,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const linux = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!linux)("Prime OCI private data boundary", () => {
  it("denies private reads and non-workspace writes while workspace writes pass", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Test the file and IPC boundary. Write RESULT.json.",
      responses: [
        primeAssistantToolCall(
          "private-boundary",
          [
            "import ctypes, json, os",
            "def can_read(path):",
            "    try:",
            "        return len(open(path, 'rb').read(1)) > 0",
            "    except OSError:",
            "        return False",
            "def can_write(path):",
            "    try:",
            "        open(path, 'wb').write(b'x')",
            "        return True",
            "    except OSError:",
            "        return False",
            "def can_list(path):",
            "    try:",
            "        return len(os.listdir(path)) > 0",
            "    except OSError:",
            "        return False",
            "libc = ctypes.CDLL(None, use_errno=True)",
            "shared_memory_id = libc.shmget(0, 1, 0o600)",
            "message_queue_id = libc.msgget(0, 0o600)",
            "result = {",
            "    'host_secret_read': can_read('/run/secrets/flow-host-secret'),",
            "    'host_temp_read': can_read('/tmp/flow-host-private'),",
            "    'host_boot_id_read': can_read('/proc/sys/kernel/random/boot_id'),",
            "    'host_cmdline_read': can_read('/proc/cmdline'),",
            "    'host_core_pattern_read': can_read('/proc/sys/kernel/core_pattern'),",
            "    'host_dmi_alias_read': can_read('/sys/class/dmi/id/product_uuid'),",
            "    'host_dmi_read': can_read('/sys/devices/virtual/dmi/id/product_uuid'),",
            "    'host_sys_block_list': can_list('/sys/block'),",
            "    'host_sys_class_block_list': can_list('/sys/class/block'),",
            "    'workspace_write': can_write('workspace-output.txt'),",
            "    'image_write': can_write('/opt/flow/forbidden.txt'),",
            "    'node_runtime_write': can_write('/run/flow-node/forbidden.txt'),",
            "    'supervisor_runtime_write': can_write('/run/flow-supervisor/forbidden.txt'),",
            "    'system_write': can_write('/etc/forbidden.txt'),",
            "    'shared_memory': shared_memory_id >= 0,",
            "    'message_queue': message_queue_id >= 0,",
            "}",
            "if shared_memory_id >= 0: libc.shmctl(shared_memory_id, 0, None)",
            "if message_queue_id >= 0: libc.msgctl(message_queue_id, 0, None)",
            "open('RESULT.json', 'w', encoding='utf-8').write(json.dumps(result, sort_keys=True))",
            "result",
          ].join("\n"),
          1,
        ),
        primeAssistantText("The boundary test is complete.", 2),
      ],
    });
    try {
      expect(JSON.parse(await readFile(`${session.workspace}/RESULT.json`, "utf8"))).toEqual({
        host_boot_id_read: false,
        host_cmdline_read: false,
        host_core_pattern_read: false,
        host_dmi_alias_read: false,
        host_dmi_read: false,
        host_sys_block_list: false,
        host_sys_class_block_list: false,
        host_secret_read: false,
        host_temp_read: false,
        image_write: false,
        message_queue: false,
        node_runtime_write: false,
        shared_memory: false,
        supervisor_runtime_write: false,
        system_write: false,
        workspace_write: true,
      });
      await expect(readFile(`${session.workspace}/workspace-output.txt`, "utf8")).resolves.toBe(
        "x",
      );
    } finally {
      await session.dispose();
    }
  }, 120_000);

  it("keeps reserved workspace data out of the published result", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Use the private runtime path. Write RESULT.md.",
      responses: [
        primeAssistantToolCall(
          "reserved-workspace-data",
          [
            "from pathlib import Path",
            "private = Path('.flow-prime/home/private-state.txt')",
            "private.write_text('PRIVATE_RUNTIME_STATE', encoding='utf-8')",
            "Path('RESULT.md').write_text(private.read_text(encoding='utf-8'), encoding='utf-8')",
            "private.exists()",
          ].join("\n"),
          1,
        ),
        primeAssistantText("The reserved path test is complete.", 2),
      ],
    });
    try {
      await expect(readFile(`${session.workspace}/RESULT.md`, "utf8")).resolves.toBe(
        "PRIVATE_RUNTIME_STATE",
      );
      await expect(access(`${session.workspace}/.flow-prime`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
