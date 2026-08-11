import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { auditPrimePythonLock } from "../dist/infrastructure/oci/prime-dependency-audit.js";

const executeFile = promisify(execFile);
const repositoryRoot = await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const environmentRoot = await realpath(await mkdtemp(join(tmpdir(), "flow-prime-audit-")));
try {
  await executeFile(
    "npm",
    [
      "audit",
      "--prefix",
      join(repositoryRoot, "prime-container"),
      "--omit=dev",
      "--audit-level=low",
      "--package-lock-only",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 1_048_576,
      timeout: 60_000,
      env: {
        HOME: environmentRoot,
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        npm_config_cache: join(environmentRoot, "npm-cache"),
        npm_config_userconfig: "/dev/null",
      },
    },
  );
  const result = await auditPrimePythonLock({
    lockPath: await realpath(join(repositoryRoot, "prime-container", "python-requirements.lock")),
  });
  process.stdout.write(
    `Prime dependency audit passed for the Node lock and ${result.packages} Python packages.\n`,
  );
} finally {
  await rm(environmentRoot, { recursive: true, force: true });
}
