import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  primeAssistantText,
  primeAssistantToolCall,
  runVerifiedPrimeSession,
} from "../fixtures/prime/verified-prime-session.js";

const linux = process.platform === "linux" && process.arch === "x64";

describe.skipIf(!linux)("Prime OCI network boundary", () => {
  it("keeps kernel loopback private and denies host and external network", async () => {
    const session = await runVerifiedPrimeSession({
      instruction: "Test the fixed network boundary and write RESULT.json.",
      responses: [
        primeAssistantToolCall(
          "network-probe",
          [
            "import json, socket",
            "def connected(host, port):",
            "    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
            "    probe.settimeout(0.2)",
            "    try:",
            "        probe.connect((host, port))",
            "        return True",
            "    except OSError:",
            "        return False",
            "    finally:",
            "        probe.close()",
            "result = {'host_loopback': connected('127.0.0.1', 2375), 'external': connected('1.1.1.1', 53)}",
            "open('RESULT.json', 'w', encoding='utf-8').write(json.dumps(result, sort_keys=True))",
            "result",
          ].join("\n"),
          1,
        ),
        primeAssistantText("The network test is complete.", 2),
      ],
    });
    try {
      expect(JSON.parse(await readFile(`${session.workspace}/RESULT.json`, "utf8"))).toEqual({
        external: false,
        host_loopback: false,
      });
      expect(session.evidence.settlement).toMatchObject({ kernelRequests: 1 });
    } finally {
      await session.dispose();
    }
  }, 120_000);
});
