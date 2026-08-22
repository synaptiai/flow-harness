import { z } from "zod";

export const runEvidenceIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const runEvidenceLocatorSchema = z
  .object({
    runId: runEvidenceIdentifierSchema,
    nodeId: runEvidenceIdentifierSchema,
    attempt: z.number().int().positive().safe(),
  })
  .strict();

export const runEvidenceReferenceSchema = runEvidenceLocatorSchema
  .extend({
    sequence: z.number().int().positive().safe(),
    eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export interface RunEvidenceLocator {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface RunEvidenceReference extends RunEvidenceLocator {
  readonly sequence: number;
  readonly eventDigest: string;
}

export function runEvidenceLocatorKey(locator: RunEvidenceLocator): string {
  return `${locator.runId}\0${locator.nodeId}\0${locator.attempt}`;
}

export function compareRunEvidenceReferences(
  left: RunEvidenceReference,
  right: RunEvidenceReference,
): number {
  const leftKey = runEvidenceLocatorKey(left);
  const rightKey = runEvidenceLocatorKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
