#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderPublicCapabilityReference } from "../application/public-capability-reference.js";
import {
  verifyPublicCapabilityReferenceFiles,
  writePublicCapabilityReferenceFiles,
} from "../infrastructure/fs/public-capability-reference-files.js";
import { createProductionPublicCapabilityCatalog } from "../infrastructure/runtime/production-public-capability-reference.js";

export interface PublicCapabilityReferenceCliOptions {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
}

export async function runPublicCapabilityReferenceCli(
  args: readonly string[],
  options: PublicCapabilityReferenceCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((value) => process.stdout.write(value));
  const stderr = options.stderr ?? ((value) => process.stderr.write(value));
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--write")) {
    stderr("Usage: public-capability-reference (--check | --write)\n");
    return 2;
  }

  const rendered = renderPublicCapabilityReference(createProductionPublicCapabilityCatalog());
  try {
    if (args[0] === "--write") {
      await writePublicCapabilityReferenceFiles(options.cwd ?? process.cwd(), rendered);
      stdout("Generated the public capability reference.\n");
    } else {
      await verifyPublicCapabilityReferenceFiles(options.cwd ?? process.cwd(), rendered);
      stdout("The public capability reference is current.\n");
    }
    return 0;
  } catch (error) {
    stderr(`${errorMessage(error)}\n`);
    return 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectEntry(entryPath: string | undefined): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry(process.argv[1])) {
  process.exitCode = await runPublicCapabilityReferenceCli(process.argv.slice(2));
}
