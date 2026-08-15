export type CapabilityMetadataChannelStage =
  | "validate metadata channel URL"
  | "resolve metadata channel"
  | "open metadata channel"
  | "validate metadata channel response"
  | "bound metadata channel response"
  | "read metadata channel response";

export class CapabilityMetadataChannelError extends Error {
  override readonly name = "CapabilityMetadataChannelError";
  readonly code = "capability_metadata_channel_failed" as const;

  constructor(readonly stage: CapabilityMetadataChannelStage) {
    super(`Capability metadata channel failed during ${stage}`);
  }
}

export interface CapabilityMetadataChannel {
  read(source: string, signal?: AbortSignal): Promise<Buffer>;
}
