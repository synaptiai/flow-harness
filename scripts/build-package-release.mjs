#!/usr/bin/env node

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const revision = await sourceRevision();
  const { runPackageReleaseCommand } = await import(
    "../dist/infrastructure/release/package-release-command.js"
  );
  const result = await runPackageReleaseCommand(
    process.argv.length === 2
      ? ["--output", "release/package", "--revision", revision]
      : process.argv.slice(2),
    { repositoryRoot },
  );
  process.stdout.write(`Prepared Flow package release artifact (${result.settlement}).\n`);
} catch (error) {
  const message =
    error instanceof Error && /^Package release failed during [a-z ]+$/.test(error.message)
      ? error.message
      : "Package release failed during parse release command";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function sourceRevision() {
  if (process.env.GITHUB_SHA !== undefined) {
    return process.env.GITHUB_SHA;
  }
  try {
    const result = await execute("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1024,
      timeout: 10_000,
    });
    return result.stdout.trim();
  } catch {
    throw new Error("cannot inspect release revision");
  }
}
