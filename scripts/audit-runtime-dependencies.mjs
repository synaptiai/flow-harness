import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateRuntimeAudit } from "./runtime-audit-policy.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const allowances = JSON.parse(
  await readFile(join(repositoryRoot, "scripts", "runtime-audit-allowances.json"), "utf8"),
);
const stdout = await new Promise((resolve, reject) => {
  execFile(
    "npm",
    ["audit", "--omit=dev", "--json"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16_777_216, timeout: 120_000 },
    (error, output) => {
      // npm audit exits 1 when it reports findings; the JSON report decides the outcome.
      if (error !== null && (error.killed || typeof error.code !== "number" || error.code > 1)) {
        reject(error);
        return;
      }
      resolve(output);
    },
  );
});

const result = evaluateRuntimeAudit(
  JSON.parse(stdout),
  allowances,
  new Date().toISOString().slice(0, 10),
);
for (const entry of result.accepted) process.stdout.write(`Allowed: ${entry}\n`);
if (!result.ok) {
  for (const failure of result.failures) process.stderr.write(`Runtime audit failed: ${failure}\n`);
  process.exit(1);
}
process.stdout.write("Runtime dependency audit passed.\n");
