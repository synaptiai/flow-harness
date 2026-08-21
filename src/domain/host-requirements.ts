export const FLOW_MINIMUM_NODE_VERSION = "26.7.0" as const;
export const FLOW_SUPPORTED_PLATFORMS = Object.freeze(["darwin", "linux"] as const);

const MINIMUM_NODE_VERSION = Object.freeze([26, 7, 0] as const);

export function isFlowHostSupported(input: {
  readonly platform: string;
  readonly nodeVersion: string;
}): boolean {
  if (!(FLOW_SUPPORTED_PLATFORMS as readonly string[]).includes(input.platform)) {
    return false;
  }
  const nodeVersion = parseNodeVersion(input.nodeVersion);
  return nodeVersion !== undefined && compareVersion(nodeVersion, MINIMUM_NODE_VERSION) >= 0;
}

function parseNodeVersion(source: string): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(source);
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
