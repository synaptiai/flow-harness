import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { LocalPrimeImageBuilder } from "../dist/infrastructure/oci/local-prime-image-builder.js";

const execute = promisify(execFile);
const repositoryRoot = await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const outputPath = parseOutputPath(process.argv.slice(2));
const dockerExecutable = await resolveDockerExecutable();
const dockerBuildxExecutable = await resolveDockerBuildxExecutable();
const builder = new LocalPrimeImageBuilder({
  packageRoot: repositoryRoot,
  dockerExecutable,
  dockerBuildxExecutable,
});
const first = await builder.build(1);
const second = await builder.build(2);

assert.deepEqual(second, first, "Prime clean builds produced different identities");
const result = `${JSON.stringify(first)}\n`;
if (outputPath !== undefined) {
  await writeFile(outputPath, result, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
process.stdout.write(result);

function parseOutputPath(args) {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length !== 2 || args[0] !== "--output" || !isAbsolute(args[1])) {
    throw new Error("Prime image verification accepts only one absolute --output path");
  }
  return args[1];
}

async function resolveDockerExecutable() {
  const candidates = [
    process.env.FLOW_DOCKER_EXECUTABLE,
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(resolve(candidate));
      await access(canonical, constants.X_OK);
      await execute(canonical, ["version", "--format", "{{.Client.Version}}"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      return canonical;
    } catch {}
  }
  throw new Error("Prime image verification requires one available Docker executable");
}

async function resolveDockerBuildxExecutable() {
  const candidates = [
    process.env.FLOW_DOCKER_BUILDX_EXECUTABLE,
    "/usr/libexec/docker/cli-plugins/docker-buildx",
    "/usr/lib/docker/cli-plugins/docker-buildx",
    "/usr/local/lib/docker/cli-plugins/docker-buildx",
    "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(resolve(candidate));
      await access(canonical, constants.X_OK);
      return canonical;
    } catch {}
  }
  throw new Error("Prime image verification requires one available Docker Buildx executable");
}
