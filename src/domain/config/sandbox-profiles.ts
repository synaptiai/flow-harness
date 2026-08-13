export const FLOW_SANDBOX_PROFILES = ["native", "container"] as const;
export type FlowSandboxProfile = (typeof FLOW_SANDBOX_PROFILES)[number];
