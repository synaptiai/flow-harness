import { spawn } from "node:child_process";

const gates = [
  ["npm", ["run", "format:check"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "test:coverage"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "test:runtime"]],
  ["node", ["scripts/smoke-compiled.mjs"]],
  ["npm", ["run", "docs:ste"]],
  ["npm", ["run", "prime:image:verify"]],
  ["npm", ["run", "pack:check"]],
  ["npm", ["audit", "--omit=dev", "--audit-level=low"]],
];

for (const [command, args] of gates) {
  await run(command, args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
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
