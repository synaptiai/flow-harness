import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createProductionCommandSandbox } from "../../../dist/infrastructure/runtime/production-node-executor.js";

const [projectRoot, readyPath] = process.argv.slice(2);
if (projectRoot === undefined || readyPath === undefined) {
  throw new Error("container command crash worker arguments are invalid");
}

const sandbox = createProductionCommandSandbox("container", projectRoot);
const prepared = await sandbox.prepare({
  executable: "/usr/local/bin/node",
  args: ["-e", "setInterval(() => {}, 1000)"],
  cwd: projectRoot,
  projectRoot,
  protectedPaths: [join(projectRoot, ".flow")],
});
await prepared.beforeLaunch?.();
const child = spawn(prepared.launch.executable, [...prepared.launch.args], {
  cwd: projectRoot,
  env: prepared.launch.env,
  detached: true,
  stdio: "ignore",
});
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  throw new Error(
    `container command crash worker launcher exited early: ${signal ?? String(code)}`,
  );
});
await new Promise((resolveReady) => child.once("spawn", resolveReady));
await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
await writeFile(readyPath, "ready\n", { flag: "wx", mode: 0o600 });
setInterval(() => {}, 1_000);
