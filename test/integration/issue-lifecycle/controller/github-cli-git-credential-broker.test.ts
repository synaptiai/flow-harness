import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import {
  GitHubCliGitCredentialBroker,
  GitHubCliGitCredentialBrokerError,
} from "../../../../src/infrastructure/github/github-cli-git-credential-broker.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("GitHub CLI Git credential broker", () => {
  it("uses the pinned gh process and returns one in-memory Basic header", async () => {
    const fixture = await createFixture('process.stdout.write("github_pat_canary-token\\n");');
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });

    await expect(broker.authorizationHeader()).resolves.toBe(
      `Authorization: Basic ${Buffer.from(
        "x-access-token:github_pat_canary-token",
        "utf8",
      ).toString("base64")}`,
    );
  });

  it("rejects multiline token output", async () => {
    const fixture = await createFixture('process.stdout.write("first\\nsecond\\n");');
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });

    const error = await captureError(async () => await broker.authorizationHeader());

    expect(error).toBeInstanceOf(GitHubCliGitCredentialBrokerError);
    expect(error).toMatchObject({ code: "token_invalid" });
    expect(String(error)).not.toContain("first");
    expect(String(error)).not.toContain("second");
  });

  it.each([
    ["empty", 'process.stdout.write("");'],
    ["carriage return", 'process.stdout.write("token\\r\\n");'],
    ["leading whitespace", 'process.stdout.write(" token\\n");'],
    ["control character", 'process.stdout.write("tok\\u0007en\\n");'],
  ])("rejects %s token output without disclosure", async (_label, body) => {
    const fixture = await createFixture(body);
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });

    const error = await captureError(async () => await broker.authorizationHeader());

    expect(error).toMatchObject({ code: "token_invalid" });
    expect(String(error)).toBe(
      "GitHubCliGitCredentialBrokerError: GitHub CLI Git credential admission failed: token_invalid",
    );
  });

  it("normalizes oversized token output as authentication failure", async () => {
    const fixture = await createFixture('process.stdout.write("x".repeat(8193));');
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });

    await expect(broker.authorizationHeader()).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  it("honors cancellation before credential process launch", async () => {
    const fixture = await createFixture('process.stdout.write("must-not-run\\n");');
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });
    const controller = new AbortController();
    controller.abort();

    await expect(broker.authorizationHeader(controller.signal)).rejects.toMatchObject({
      code: "operation_aborted",
    });
  });

  it("rejects a credential executable replaced after pinning", async () => {
    const fixture = await createFixture('process.stdout.write("original\\n");');
    await writeFile(
      fixture.path,
      `#!${process.execPath}\nprocess.stdout.write("replacement\\n");\n`,
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });

    await expect(broker.authorizationHeader()).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  it("rejects a failed GitHub CLI credential read", async () => {
    const fixture = await createFixture("process.exit(23);");
    const broker = new GitHubCliGitCredentialBroker({ ghExecutable: fixture.executable });

    await expect(broker.authorizationHeader()).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });
});

async function createFixture(body: string) {
  const root = await mkdtemp(join(tmpdir(), "flow-gh-credential-"));
  temporaryRoots.push(root);
  const projectRoot = join(root, "project");
  const binaryRoot = join(root, "bin");
  await Promise.all([mkdir(projectRoot, { mode: 0o700 }), mkdir(binaryRoot, { mode: 0o700 })]);
  const path = join(binaryRoot, "gh");
  await writeFile(
    path,
    `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["auth", "token", "--hostname", "github.com"])) process.exit(97);\n${body}\n`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(path, 0o700);
  return Object.freeze({
    executable: await pinGitHubIssueHostExecutable(path, projectRoot),
    path,
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}
