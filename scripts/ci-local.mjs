import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preliminaryGates = [
  ["npm", ["run", "format:check"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "build"]],
];
const verifiedGates = [
  ["node", ["scripts/audit-prime-dependencies.mjs"]],
  ["npm", ["run", "test:coverage"]],
  ["npm", ["run", "test:runtime"]],
  ["node", ["scripts/smoke-compiled.mjs"]],
  ["npm", ["run", "docs:ste"]],
  ["npm", ["run", "pack:check"]],
  ["npm", ["audit", "--omit=dev", "--audit-level=low"]],
];
const baseEnvironment = { ...process.env };
delete baseEnvironment.FLOW_PRIME_PREPARED_ATTESTATION;
delete baseEnvironment.FLOW_PRIME_TEST_IMAGE_ID;
delete baseEnvironment.FLOW_PRIME_TEST_IMAGE_RESULT;

for (const [command, args] of preliminaryGates) {
  await run(command, args, baseEnvironment);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-prime-ci-"));
try {
  const imageResultPath = join(temporaryRoot, "image-result.json");
  const compiledCliPath = join(process.cwd(), "dist", "cli", "main.js");
  await run("node", [compiledCliPath, "init", "."], baseEnvironment, temporaryRoot);
  await run(
    "node",
    [compiledCliPath, "runtime", "prepare", "prime-agent"],
    baseEnvironment,
    temporaryRoot,
  );
  const generatedAttestation = join(
    temporaryRoot,
    ".flow",
    "runtime",
    "prime-agent",
    "oci-attestation.json",
  );
  const source = await readFile(generatedAttestation, "utf8");
  parseImageId(source);
  await writeFile(imageResultPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const imageId = parseImageId(await readFile(imageResultPath, "utf8"));
  const verifiedEnvironment = {
    ...baseEnvironment,
    FLOW_PRIME_TEST_IMAGE_ID: imageId,
    FLOW_PRIME_TEST_IMAGE_RESULT: imageResultPath,
  };
  for (const [command, args] of verifiedGates) {
    await run(command, args, verifiedEnvironment);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, env, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, cwd });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? String(code)}`));
    });
  });
}

function parseImageId(source) {
  const value = JSON.parse(source);
  const imageId = value?.image?.id;
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error("Prime image verification returned an invalid image ID");
  }
  return imageId;
}
