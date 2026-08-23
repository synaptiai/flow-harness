import {
  type AcpAgentUsageSupport,
  createAcpAgentRuntimeSnapshot,
} from "../../src/domain/capability/acp-agent.js";
import {
  type CapabilitySnapshot,
  calculateCapabilitySnapshotDigest,
  validateCapabilitySnapshot,
} from "../../src/domain/capability/agent-skills.js";

export function acpAgentCapabilitySnapshot(
  seed = "a",
  usage: AcpAgentUsageSupport = { modelTokens: "complete", costUsd: "unavailable" },
): CapabilitySnapshot {
  if (!/^[a-f]$/.test(seed)) {
    throw new Error("ACP agent fixture seed must be one lowercase hexadecimal character");
  }
  const executable = `/opt/flow/acp/opencode-${seed}`;
  const executableSha256 = seed.repeat(64);
  const acpAgent = createAcpAgentRuntimeSnapshot({
    provenance: ".flow/acp-agents/opencode.json",
    manifest: Buffer.from(
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "AcpAgent",
        metadata: { name: "opencode" },
        spec: {
          protocol: "acp-v1",
          compatibilityProfile: "prompt-only-v1",
          launch: {
            kind: "binary",
            executable,
            executableSha256,
            args: ["--stdio"],
          },
          modelMappings: [
            {
              provider: "openai",
              model: "gpt-5.6-codex",
              agentModel: "gpt-5.6-codex",
            },
          ],
          providerAuthorities: [
            {
              provider: "openai",
              domain: "api.openai.com",
              credentialEnv: "OPENAI_API_KEY",
            },
          ],
          containmentProfile: "acp-prompt-only-v1",
          usage,
          configuration: {
            assignments: [
              { configId: "model", source: "model" },
              {
                configId: "thinking",
                source: "thinking",
                mappings: [
                  { thinking: "off", value: "off" },
                  { thinking: "medium", value: "medium" },
                  { thinking: "high", value: "high" },
                ],
              },
            ],
          },
        },
      }),
    ),
    launch: {
      kind: "binary",
      executable: {
        path: executable,
        sha256: executableSha256,
        bytes: 123_456,
        device: "16777234",
        inode: seed === "a" ? "9071" : "9072",
      },
    },
  });
  return validateCapabilitySnapshot({
    version: 1,
    packages: [],
    acpAgent,
    digest: calculateCapabilitySnapshotDigest([], [], undefined, undefined, undefined, acpAgent),
  });
}
