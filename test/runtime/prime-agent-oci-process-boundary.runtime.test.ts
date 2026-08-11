import { chmod, lstat, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  primeAssistantText,
  primeAssistantToolCall,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const linux = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!linux)("Prime OCI process boundary", () => {
  it("keeps the broker secret and outer stream outside Python authority", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Test the process boundary. Write RESULT.json and mode-zero.txt.",
      responses: [
        primeAssistantToolCall(
          "process-boundary",
          [
            "import json, os",
            "def read_bytes(path):",
            "    try:",
            "        return open(path, 'rb', buffering=0).read(64)",
            "    except OSError:",
            "        return None",
            "node_pid = None",
            "for candidate in os.listdir('/proc'):",
            "    if not candidate.isdigit():",
            "        continue",
            "    status = read_bytes(f'/proc/{candidate}/status')",
            "    try:",
            "        full_status = open(f'/proc/{candidate}/status', encoding='utf-8').read()",
            "    except OSError:",
            "        continue",
            "    if '\\nUid:\\t10001\\t' in full_status:",
            "        node_pid = int(candidate)",
            "        break",
            "signal_allowed = False",
            "fd_list_allowed = False",
            "environment_allowed = False",
            "memory_allowed = False",
            "if node_pid is not None:",
            "    try:",
            "        os.kill(node_pid, 0)",
            "        signal_allowed = True",
            "    except OSError:",
            "        pass",
            "    try:",
            "        os.listdir(f'/proc/{node_pid}/fd')",
            "        fd_list_allowed = True",
            "    except OSError:",
            "        pass",
            "    environment_allowed = read_bytes(f'/proc/{node_pid}/environ') is not None",
            "    memory_allowed = read_bytes(f'/proc/{node_pid}/mem') is not None",
            "for descriptor in (0, 1, 2):",
            "    try:",
            "        os.write(descriptor, b'FORGED_OUTER_FRAME')",
            "    except OSError:",
            "        pass",
            "open('mode-zero.txt', 'w', encoding='utf-8').write('MODE_ZERO')",
            "os.chmod('mode-zero.txt', 0)",
            "result = {",
            "    'node_found': node_pid is not None,",
            "    'signal_allowed': signal_allowed,",
            "    'fd_list_allowed': fd_list_allowed,",
            "    'environment_allowed': environment_allowed,",
            "    'memory_allowed': memory_allowed,",
            "}",
            "open('RESULT.json', 'w', encoding='utf-8').write(json.dumps(result, sort_keys=True))",
            "result",
          ].join("\n"),
          1,
        ),
        primeAssistantText("The process test is complete.", 2),
      ],
    });
    try {
      expect(JSON.parse(await readFile(`${session.workspace}/RESULT.json`, "utf8"))).toEqual({
        environment_allowed: false,
        fd_list_allowed: false,
        memory_allowed: false,
        node_found: true,
        signal_allowed: false,
      });
      const modeZeroPath = `${session.workspace}/mode-zero.txt`;
      expect((await lstat(modeZeroPath)).mode & 0o777).toBe(0);
      await chmod(modeZeroPath, 0o600);
      await expect(readFile(modeZeroPath, "utf8")).resolves.toBe("MODE_ZERO");
      expect(session.evidence.harness.outcome).toBe("completed");
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
