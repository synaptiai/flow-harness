#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderPublicCapabilityReference } from "../application/public-capability-reference.js";
import {
  type PublicCapabilityCatalog,
  PublicCapabilityCatalogValidationError,
} from "../domain/capability/public-capability-reference.js";
import {
  PublicCapabilityReferenceDriftError,
  PublicCapabilityReferenceFileSafetyError,
  verifyPublicCapabilityReferenceFiles,
  writePublicCapabilityReferenceFiles,
} from "../infrastructure/fs/public-capability-reference-files.js";
import { createProductionPublicCapabilityCatalog } from "../infrastructure/runtime/production-public-capability-reference.js";

export interface PublicCapabilityReferenceCliOptions {
  readonly cwd?: string;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly createCatalog?: () => PublicCapabilityCatalog;
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

  try {
    const rendered = renderPublicCapabilityReference(
      (options.createCatalog ?? createProductionPublicCapabilityCatalog)(),
    );
    if (args[0] === "--write") {
      await writePublicCapabilityReferenceFiles(options.cwd ?? process.cwd(), rendered);
      stdout("Generated the public capability reference.\n");
    } else {
      await verifyPublicCapabilityReferenceFiles(options.cwd ?? process.cwd(), rendered);
      stdout("The public capability reference is current.\n");
    }
    return 0;
  } catch (error) {
    stderr(`${publicErrorMessage(error)}\n`);
    return 1;
  }
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof PublicCapabilityCatalogValidationError) {
    return `${error.code} at ${error.location}`;
  }
  if (
    error instanceof PublicCapabilityReferenceDriftError ||
    error instanceof PublicCapabilityReferenceFileSafetyError
  ) {
    return error.message;
  }
  if (error instanceof TypeError) {
    return "public capability reference is invalid";
  }
  if (isNodeError(error)) {
    return "public capability reference file operation failed";
  }
  return "public capability reference generation failed";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
