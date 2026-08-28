import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import type {
  CommandSandbox,
  CommandSandboxRequest,
} from "../../../../src/application/command-sandbox.js";
import { calculateFrozenIssueVerificationCommandDigest } from "../../../../src/application/frozen-issue-command.js";
import type { IssueLifecycleStore } from "../../../../src/application/issue-lifecycle-store.js";
import type { IssueGitWorkspace } from "../../../../src/application/issue-local-git-port.js";
import type { IssueVerificationResult } from "../../../../src/application/issue-verification.js";
import type { GitHubIssuePlan } from "../../../../src/domain/issue-lifecycle/plan.js";
import {
  calculateIssueBudgetDigest,
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  type IssuePrivateBlobInput,
  type IssuePrivateBlobReference,
  parseIssuePrivateManifest,
} from "../../../../src/domain/issue-lifecycle/private-manifest.js";
import { pinGitHubIssueHostExecutable } from "../../../../src/infrastructure/git/fixed-host-executables.js";
import { LocalGitIssueEffects } from "../../../../src/infrastructure/git/local-git-issue-effects.js";
import {
  LocalIssueReviewEvidence,
  LocalIssueReviewEvidenceError,
} from "../../../../src/infrastructure/git/local-issue-review-evidence.js";
import {
  LocalIssueVerification,
  LocalIssueVerificationError,
} from "../../../../src/infrastructure/git/local-issue-verification.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const RUN_ID = "issue-run-197-verification";
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalIssueVerification", { timeout: 30_000 }, () => {
  it("runs the exact negative control and every frozen check against proven Git trees", async () => {
    const fixture = await createFixture();
    const sandbox = new RecordingProcessSandbox();
    const store = new MemoryPrivateStore(fixture.planBlob);
    const verifier = createVerifier(fixture, sandbox, store);
    const qualityCommand = fixture.plan.verification.find(({ id }) => id === "quality")?.command;
    if (qualityCommand === undefined) throw new Error("quality command fixture is absent");

    const result = await verifier.verify(request(fixture));

    expect(result).toMatchObject({
      negativeControl: {
        baseCommit: fixture.base,
        baseOutcome: "failed",
        candidateHead: fixture.candidateHead,
        candidateOutcome: "passed",
      },
      deterministic: [
        {
          id: "quality",
          commandDigest: calculateFrozenIssueVerificationCommandDigest(qualityCommand),
          headCommit: fixture.candidateHead,
        },
      ],
      candidateDelta: {
        baseCommit: fixture.base,
        candidateHead: fixture.candidateHead,
        pathCount: 1,
        logicalBytes: Buffer.byteLength("candidate\n"),
        relevant: true,
      },
    });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("private-command-output");
    expect(store.blobs.some((blob) => decode(blob).includes("private-command-output"))).toBe(true);
    expect(store.blobs.length).toBeGreaterThanOrEqual(7);
    expect(sandbox.requests.map(({ cwd }) => cwd)).toEqual([
      fixture.workspace.verificationRoot,
      fixture.workspace.verificationRoot,
      fixture.workspace.verificationRoot,
    ]);
    expect(sandbox.requests[0]?.protectedPaths).toContain(fixture.workspace.root);
    expect(sandbox.requests[1]?.protectedPaths).toContain(fixture.workspace.sourceRoot);
    expect(
      sandbox.requests.every(({ runtimeEnvironment }) => runtimeEnvironment === undefined),
    ).toBe(true);
    expect(sandbox.requests[0]?.protectedPaths).toContain(fixture.workspace.sourceRoot);
    expect(sandbox.requests[1]?.protectedPaths).toContain(fixture.workspace.root);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects a substituted frozen command before starting a process", async () => {
    const fixture = await createFixture();
    const sandbox = new RecordingProcessSandbox();
    const store = new MemoryPrivateStore(fixture.planBlob);
    const manifest = parseIssuePrivateManifest({
      ...fixture.manifest,
      holdout: { ...fixture.manifest.holdout, commandDigest: "0".repeat(64) },
    });

    await expect(
      createVerifier(fixture, sandbox, store).verify(request(fixture, { manifest })),
    ).rejects.toMatchObject({ code: "frozen_input_mismatch" });
    expect(sandbox.requests).toHaveLength(0);
  });

  it("rejects a substituted frozen contract digest before starting a process", async () => {
    const fixture = await createFixture();
    const sandbox = new RecordingProcessSandbox();

    await expect(
      createVerifier(fixture, sandbox).verify(
        request(fixture, { frozenContractDigest: "0".repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: "frozen_input_mismatch" });
    expect(sandbox.requests).toHaveLength(0);
  });

  it("preserves cancellation while resolving the owned workspace", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const sandbox = new RecordingProcessSandbox();
    const verifier = new LocalIssueVerification({
      git: fixture.effects,
      workspaceProvider: {
        readWorkspace: async () => {
          controller.abort("operator cancelled");
          throw new Error("cancelled workspace read");
        },
      },
      privateStore: new MemoryPrivateStore(fixture.planBlob),
      sandbox,
    });

    await expect(
      verifier.verify(request(fixture, { signal: controller.signal })),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(sandbox.requests).toHaveLength(0);
  });

  it("fails closed when a command mutates tracked verification-snapshot content", async () => {
    const fixture = await createFixture({
      verificationCommand: nodeCommand(
        `require("node:fs").writeFileSync("feature.txt", "mutated\\n");`,
      ),
    });

    await expect(createVerifier(fixture).verify(request(fixture))).rejects.toMatchObject({
      code: "candidate_drift",
    });
    expect(await readFile(join(fixture.workspace.verificationRoot, "feature.txt"), "utf8")).toBe(
      "mutated\n",
    );
    expect(await readFile(join(fixture.workspace.root, "feature.txt"), "utf8")).toBe("candidate\n");
  });

  it("allows ignored command output but removes it before the next check", async () => {
    const fixture = await createFixture({
      holdoutCommand: nodeCommand(
        `require("node:fs").writeFileSync("cache.log", "discard me\\n"); process.exit(require("node:fs").existsSync("feature.txt") ? 0 : 7);`,
      ),
      verificationCommand: nodeCommand(
        `process.exit(require("node:fs").existsSync("cache.log") ? 9 : 0);`,
      ),
    });

    await expect(createVerifier(fixture).verify(request(fixture))).resolves.toMatchObject({
      candidateDelta: { candidateHead: fixture.candidateHead },
    });
    await expect(
      lstat(join(fixture.workspace.verificationRoot, "cache.log")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not execute against model-created ignored candidate state", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspace.root, "cache.log"), "candidate-only state\n");
    const sandbox = new RecordingProcessSandbox();

    await expect(createVerifier(fixture, sandbox).verify(request(fixture))).resolves.toMatchObject({
      candidateDelta: { candidateHead: fixture.candidateHead },
    });
    expect(sandbox.requests.every(({ cwd }) => cwd === fixture.workspace.verificationRoot)).toBe(
      true,
    );
    expect(await readFile(join(fixture.workspace.root, "cache.log"), "utf8")).toBe(
      "candidate-only state\n",
    );
  });

  it("recovers the exact remote candidate into a disposable snapshot on a fresh clone", async () => {
    const fixture = await createFixture();
    await fixture.effects.pushCandidate({
      workspace: fixture.workspace,
      branch: fixture.workspace.branch,
      candidateHead: fixture.candidateHead,
      expectedRemoteHead: null,
    });
    const restored = await restoreFixture(fixture);
    const sandbox = new RecordingProcessSandbox();

    await expect(
      createVerifier(restored, sandbox).verify(request(restored)),
    ).resolves.toMatchObject({
      candidateDelta: { candidateHead: fixture.candidateHead, pathCount: 1 },
    });
    expect(await git(restored.workspace.root, "rev-parse", "HEAD")).toBe(restored.base);
    expect(await git(restored.workspace.verificationRoot, "rev-parse", "HEAD")).toBe(
      restored.candidateHead,
    );
    expect(sandbox.requests.every(({ cwd }) => cwd === restored.workspace.verificationRoot)).toBe(
      true,
    );
  });

  it("contains a mutating base holdout outside the operator source checkout", async () => {
    const fixture = await createFixture({
      holdoutCommand: nodeCommand(
        `require("node:fs").writeFileSync("base-mutation.txt", "must stay isolated\\n"); process.exit(7);`,
      ),
    });

    await expect(createVerifier(fixture).verify(request(fixture))).rejects.toMatchObject({
      code: "base_drift",
    });
    await expect(
      readFile(join(fixture.workspace.sourceRoot, "base-mutation.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(fixture.workspace.verificationRoot, "base-mutation.txt"), "utf8"),
    ).toBe("must stay isolated\n");
  });

  it("fails closed when a command moves the candidate branch ref", async () => {
    const fixture = await createFixture();
    const refPath = join(
      fixture.workspace.commonGitDirectory,
      "refs",
      "heads",
      ...fixture.workspace.branch.split("/"),
    );
    const drifted = await createFixture({
      verificationCommand: nodeCommand(
        `require("node:fs").writeFileSync(${JSON.stringify(refPath)}, ${JSON.stringify(
          `${fixture.base}\n`,
        )});`,
      ),
      fixture,
    });

    await expect(createVerifier(drifted).verify(request(drifted))).rejects.toMatchObject({
      code: "candidate_drift",
    });
  });

  it("rejects output truncation without disclosing output", async () => {
    const fixture = await createFixture({
      verificationCommand: nodeCommand(`process.stdout.write("private-output-".repeat(200));`),
    });
    const verifier = createVerifier(
      fixture,
      new RecordingProcessSandbox(),
      new MemoryPrivateStore(fixture.planBlob),
      { maxOutputBytes: 128 },
    );

    const error = await rejected(verifier.verify(request(fixture)));
    expect(error).toMatchObject({ code: "command_output_limit" });
    expect(error.message).not.toContain("private-output");
  });

  it("fails closed on timeout, signal, and cancellation", async () => {
    const timeoutFixture = await createFixture({
      verificationCommand: nodeCommand("setInterval(() => undefined, 1000);", 30),
    });
    await expect(
      createVerifier(timeoutFixture, undefined, undefined, {
        terminationGraceMs: 5,
        terminationConfirmationMs: 100,
      }).verify(request(timeoutFixture)),
    ).rejects.toMatchObject({ code: "command_timeout" });

    const signalFixture = await createFixture({
      verificationCommand: nodeCommand(`process.kill(process.pid, "SIGTERM");`),
    });
    await expect(
      createVerifier(signalFixture).verify(request(signalFixture)),
    ).rejects.toMatchObject({
      code: "command_signaled",
    });

    const cancellationFixture = await createFixture();
    const controller = new AbortController();
    const sandbox = new RecordingProcessSandbox(() => controller.abort("operator cancelled"), 3);
    await expect(
      createVerifier(cancellationFixture, sandbox).verify(
        request(cancellationFixture, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "operation_cancelled" });
  }, 20_000);

  it("replays safely after private evidence publication loses its result", async () => {
    const fixture = await createFixture();
    const sandbox = new RecordingProcessSandbox();
    const store = new MemoryPrivateStore(fixture.planBlob, 2);
    const verifier = createVerifier(fixture, sandbox, store);

    await expect(verifier.verify(request(fixture))).rejects.toMatchObject({
      code: "evidence_store_failed",
    });
    store.failPutNumber = undefined;
    const replay = await verifier.verify(request(fixture));

    expect(replay.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(sandbox.requests).toHaveLength(4);
    expect(await git(fixture.workspace.root, "rev-parse", "HEAD")).toBe(fixture.candidateHead);
  }, 20_000);
});

describe("LocalIssueReviewEvidence", { timeout: 30_000 }, () => {
  it("captures one exact bounded private diff and returns content-free review evidence", async () => {
    const fixture = await createFixture();
    const store = new MemoryPrivateStore(fixture.planBlob);
    const verification = await createVerifier(fixture, undefined, store).verify(request(fixture));
    const logPath = join(fixture.root, "review-git.jsonl");
    const executable = await writeGitWrapper(logPath);
    const adapter = new LocalIssueReviewEvidence({
      git: fixture.effects,
      gitExecutable: await pinGitHubIssueHostExecutable(executable, fixture.root),
      privateStore: store,
      verification: provider(verification),
    });
    await writeFile(
      join(fixture.workspace.verificationRoot, "review-cache.log"),
      "must not reach reviewer\n",
    );

    const evidence = await adapter.read({
      runId: RUN_ID,
      manifest: fixture.manifest,
      candidateHead: fixture.candidateHead,
      workspace: fixture.workspace,
    });

    expect(evidence).toMatchObject({
      version: 1,
      baseCommit: fixture.base,
      candidateHead: fixture.candidateHead,
      workspaceIdentityDigest: fixture.workspace.workspaceIdentityDigest,
      changedPaths: ["feature.txt"],
      logicalBytes: Buffer.byteLength("candidate\n"),
      verification,
    });
    expect(evidence.candidateTree).toBe(
      await git(fixture.workspace.root, "rev-parse", `${fixture.candidateHead}^{tree}`),
    );
    expect(evidence.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.diffBlob.mediaType).toBe("text/x-diff; charset=utf-8");
    await expect(
      lstat(join(fixture.workspace.verificationRoot, "review-cache.log")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await git(fixture.workspace.verificationRoot, "status", "--porcelain", "--ignored"),
    ).toBe("");
    expect(JSON.stringify(evidence)).not.toContain("candidate fixture");
    const diff = store.blobs.find(
      (blob) => createIssuePrivateBlobReference(blob).digest === evidence.diffBlob.digest,
    );
    expect(diff === undefined ? "" : decode(diff)).toContain("+candidate");
    const invocation = JSON.parse((await readFile(logPath, "utf8")).trim()) as {
      readonly args: readonly string[];
      readonly environmentNames: readonly string[];
    };
    expect(invocation.args).toEqual([
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-c",
      "diff.external=",
      "-c",
      "diff.noprefix=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "-c",
      "diff.algorithm=myers",
      "-c",
      "diff.indentHeuristic=false",
      "-c",
      "core.attributesFile=/dev/null",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--full-index",
      "--binary",
      fixture.base,
      fixture.candidateHead,
      "--",
    ]);
    expect(invocation.args).not.toContain("--force");
    expect(invocation.args.join(" ")).not.toContain("protocol.file");
    expect(invocation.environmentNames).not.toContain("OPENAI_API_KEY");
  }, 20_000);

  it("rejects bounded-output overflow and candidate mutation after diff capture", async () => {
    const fixture = await createFixture();
    const store = new MemoryPrivateStore(fixture.planBlob);
    const verification = await createVerifier(fixture, undefined, store).verify(request(fixture));
    const executable = await pinGitHubIssueHostExecutable(await gitPath(), fixture.root);
    const bounded = new LocalIssueReviewEvidence({
      git: fixture.effects,
      gitExecutable: executable,
      privateStore: store,
      verification: provider(verification),
      maxDiffBytes: 32,
    });
    await expect(
      bounded.read({
        runId: RUN_ID,
        manifest: fixture.manifest,
        candidateHead: fixture.candidateHead,
        workspace: fixture.workspace,
      }),
    ).rejects.toMatchObject({ code: "diff_output_limit" });

    const mutating = new LocalIssueReviewEvidence({
      git: fixture.effects,
      gitExecutable: executable,
      privateStore: store,
      verification: provider(verification),
      testOnlyAfterDiffCapture: async () => {
        await writeFile(
          join(fixture.workspace.verificationRoot, "feature.txt"),
          "review mutation\n",
        );
      },
    });
    await expect(
      mutating.read({
        runId: RUN_ID,
        manifest: fixture.manifest,
        candidateHead: fixture.candidateHead,
        workspace: fixture.workspace,
      }),
    ).rejects.toMatchObject({ code: "candidate_drift" });
  }, 60_000);

  it("rejects substituted verification evidence before diff capture", async () => {
    const fixture = await createFixture();
    const store = new MemoryPrivateStore(fixture.planBlob);
    const verification = await createVerifier(fixture, undefined, store).verify(request(fixture));
    const substituted = {
      ...verification,
      deterministic: verification.deterministic.map((result) => ({
        ...result,
        headCommit: "0".repeat(40),
      })),
    } as IssueVerificationResult;
    const logPath = join(fixture.root, "must-not-run.jsonl");
    const adapter = new LocalIssueReviewEvidence({
      git: fixture.effects,
      gitExecutable: await pinGitHubIssueHostExecutable(
        await writeGitWrapper(logPath),
        fixture.root,
      ),
      privateStore: store,
      verification: provider(substituted),
    });

    const error = await rejectedReview(
      adapter.read({
        runId: RUN_ID,
        manifest: fixture.manifest,
        candidateHead: fixture.candidateHead,
        workspace: fixture.workspace,
      }),
    );
    expect(error).toMatchObject({ code: "verification_mismatch" });
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface Fixture {
  readonly root: string;
  readonly remote: string;
  readonly source: string;
  readonly workspace: IssueGitWorkspace;
  readonly effects: LocalGitIssueEffects;
  readonly base: string;
  readonly candidateHead: string;
  readonly plan: GitHubIssuePlan;
  readonly planBlob: IssuePrivateBlobInput;
  readonly manifest: ReturnType<typeof parseIssuePrivateManifest>;
}

interface FixtureOptions {
  readonly verificationCommand?: GitHubIssuePlan["verification"][number]["command"];
  readonly holdoutCommand?: GitHubIssuePlan["holdout"]["command"];
  readonly fixture?: Fixture;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  if (options.fixture !== undefined) {
    return withPlan(options.fixture, options.verificationCommand, options.holdoutCommand);
  }
  const root = await temporaryDirectory("flow-issue-verification-");
  const seed = join(root, "seed");
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const privateRoot = join(root, "private");
  const candidate = join(root, "candidate");
  const verificationWorktree = join(root, "verification");
  await mkdir(seed);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.email", "flow@example.test");
  await git(seed, "config", "user.name", "Flow Test");
  await writeFile(join(seed, "README.md"), "# fixture\n");
  await writeFile(join(seed, ".gitignore"), "*.log\n");
  await git(seed, "add", "README.md", ".gitignore");
  await git(seed, "commit", "--quiet", "-m", "base fixture");
  await execFile(await gitPath(), ["clone", "--quiet", "--bare", seed, remote]);
  await execFile(await gitPath(), ["clone", "--quiet", remote, source]);
  await mkdir(privateRoot);
  const base = await git(source, "rev-parse", "HEAD");
  const effects = new LocalGitIssueEffects({
    gitExecutable: await pinGitHubIssueHostExecutable(await gitPath(), root),
    privateRoot,
    testOnlyLocalRemotePath: remote,
  });
  const workspace = await effects.prepareWorkspace({
    ownershipId: "issue-197-verification",
    sourceRoot: source,
    workspaceRoot: candidate,
    verificationRoot: verificationWorktree,
    repositoryIdentity: "example/project",
    baseBranch: "main",
    baseCommit: base,
    branch: "codex/issue-197-verification",
  });
  await writeFile(join(candidate, "feature.txt"), "candidate\n");
  const observation = await effects.inspectCandidate({
    workspace,
    baseCommit: base,
    allowedWritePrefixes: ["feature.txt"],
  });
  const commit = await effects.commitCandidate({
    workspace,
    parentCommit: base,
    candidateTree: observation.tree,
    allowedWritePrefixes: ["feature.txt"],
    message: "candidate fixture\n",
    identity: {
      name: "Flow Controller",
      email: "flow@example.test",
      timestamp: "2026-08-28T12:00:00.000Z",
    },
  });
  return withPlan(
    {
      root,
      remote,
      source,
      workspace,
      effects,
      base,
      candidateHead: commit.candidateHead,
    } as Omit<Fixture, "plan" | "planBlob" | "manifest">,
    options.verificationCommand,
    options.holdoutCommand,
  );
}

async function restoreFixture(fixture: Fixture): Promise<Fixture> {
  const root = await temporaryDirectory("flow-issue-verification-restored-");
  const source = join(root, "source");
  const privateRoot = join(root, "private");
  const candidate = join(root, "candidate");
  const verificationRoot = join(root, "verification");
  await execFile(await gitPath(), ["clone", "--quiet", fixture.remote, source]);
  await mkdir(privateRoot);
  const effects = new LocalGitIssueEffects({
    gitExecutable: await pinGitHubIssueHostExecutable(await gitPath(), root),
    privateRoot,
    testOnlyLocalRemotePath: fixture.remote,
  });
  const workspace = await effects.prepareWorkspace({
    ownershipId: "issue-197-verification",
    sourceRoot: source,
    workspaceRoot: candidate,
    verificationRoot,
    repositoryIdentity: "example/project",
    baseBranch: "main",
    baseCommit: fixture.base,
    branch: fixture.workspace.branch,
  });
  return { ...fixture, root, source, workspace, effects };
}

function withPlan(
  fixture: Omit<Fixture, "plan" | "planBlob" | "manifest">,
  verificationCommand = nodeCommand(
    `process.stdout.write("private-command-output"); process.exit(require("node:fs").existsSync("feature.txt") ? 0 : 7);`,
  ),
  holdout = nodeCommand(
    `process.stderr.write("private-command-output"); process.exit(require("node:fs").existsSync("feature.txt") ? 0 : 7);`,
  ),
): Fixture {
  const plan = {
    apiVersion: "flow.synapti.ai/v1alpha1" as const,
    kind: "GitHubIssuePlan" as const,
    repository: { expected: "example/project", baseBranch: "main" },
    branch: { prefix: "codex/issue-" },
    candidate: { allowedPathPrefixes: ["feature.txt"] },
    implementation: { workflow: "workflows/implementation.workflow.yaml" },
    holdout: { command: holdout },
    verification: [{ id: "quality", command: verificationCommand }],
    hostedChecks: {
      required: [{ name: "test", sourceApp: { id: 15_368, slug: "github-actions" } }],
    },
    review: {
      workflow: "workflows/review.workflow.yaml",
      resultNode: "review-result",
      blockingSeverities: ["P1", "P2", "P3"] as const,
    },
    merge: { method: "squash" as const, deleteBranch: true },
  } satisfies GitHubIssuePlan;
  const planBlob = {
    mediaType: "application/vnd.flow.github-issue-plan+yaml",
    bytes: Buffer.from(stringify(plan), "utf8"),
  };
  const manifest = parseIssuePrivateManifest({
    version: 1,
    runId: RUN_ID,
    initialCommandId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-08-28T12:00:00.000Z",
    repository: {
      host: "github.com",
      identity: "example/project",
      nodeId: "R_example_project",
      canonicalUrl: "https://github.com/example/project",
    },
    issue: {
      number: 197,
      nodeId: "I_example_197",
      state: "open",
      updatedAt: "2026-08-28T11:00:00.000Z",
      canonicalUrl: "https://github.com/example/project/issues/197",
      contentDigest: "1".repeat(64),
    },
    base: { branch: "main", commit: fixture.base, remoteRef: "refs/heads/main" },
    branch: { prefix: "codex/issue-", name: fixture.workspace.branch },
    planDigest: "2".repeat(64),
    implementationWorkflow: workflow("3"),
    reviewWorkflow: { ...workflow("4"), resultNodeId: "review-result" },
    acceptanceCriteria: ["candidate-is-verified"],
    allowedWritePrefixes: ["feature.txt"],
    holdout: {
      commandDigest: calculateFrozenIssueVerificationCommandDigest(holdout),
      timeoutMs: holdout.timeoutMs,
    },
    verification: [
      {
        id: "quality",
        commandDigest: calculateFrozenIssueVerificationCommandDigest(verificationCommand),
        timeoutMs: verificationCommand.timeoutMs,
      },
    ],
    hostedChecks: [{ name: "test", sourceApp: { id: 15_368, slug: "github-actions" } }],
    merge: { method: "squash", deleteBranch: true },
    budgets: {
      implementation: budget(1),
      review: budget(2),
      holdout: { timeoutMs: holdout.timeoutMs },
      verification: [{ id: "quality", timeoutMs: verificationCommand.timeoutMs }],
      controller: [{ id: "git-read", timeoutMs: 30_000 }],
    },
    budgetDigest: budgetDigest(holdout.timeoutMs, verificationCommand.timeoutMs),
    artifacts: {
      issue: blob("application/vnd.flow.github-issue+json", "issue"),
      plan: createIssuePrivateBlobReference(planBlob),
      implementationWorkflow: blob("application/vnd.flow.workflow+yaml", "implementation"),
      reviewWorkflow: blob("application/vnd.flow.workflow+yaml", "review"),
    },
  });
  return { ...fixture, plan, planBlob, manifest };
}

function createVerifier(
  fixture: Fixture,
  sandbox: RecordingProcessSandbox = new RecordingProcessSandbox(),
  store: MemoryPrivateStore = new MemoryPrivateStore(fixture.planBlob),
  limits: {
    readonly maxOutputBytes?: number;
    readonly terminationGraceMs?: number;
    readonly terminationConfirmationMs?: number;
  } = {},
) {
  return new LocalIssueVerification({
    git: fixture.effects,
    workspaceProvider: { readWorkspace: async () => fixture.workspace },
    privateStore: store,
    sandbox,
    clock: () => "2026-08-28T12:01:00.000Z",
    ...limits,
  });
}

function request(
  fixture: Fixture,
  overrides: Partial<Parameters<LocalIssueVerification["verify"]>[0]> = {},
) {
  return {
    runId: RUN_ID,
    manifest: fixture.manifest,
    frozenContractDigest: calculateIssuePrivateManifestDigest(fixture.manifest),
    candidateHead: fixture.candidateHead,
    pollCancellation: async () => undefined,
    ...overrides,
  };
}

class RecordingProcessSandbox implements CommandSandbox {
  readonly requests: CommandSandboxRequest[] = [];

  constructor(
    private readonly beforeLaunch?: () => void,
    private readonly beforeLaunchNumber = 1,
  ) {}

  async prepare(request: CommandSandboxRequest) {
    this.requests.push(request);
    const launchNumber = this.requests.length;
    return {
      processContainment: "process-group" as const,
      launch: {
        executable: request.executable,
        args: request.args,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", CI: "1" },
      },
      evidence: {
        backend: "test-process",
        backendVersion: "1",
        policyDigest: "a".repeat(64),
        profile: "workspace-write-network-deny-v1",
      },
      ...(this.beforeLaunch === undefined || launchNumber !== this.beforeLaunchNumber
        ? {}
        : { beforeLaunch: async () => this.beforeLaunch?.() }),
      release: async () => undefined,
    };
  }
}

class MemoryPrivateStore implements Pick<IssueLifecycleStore, "readBlob" | "putBlob"> {
  readonly blobs: IssuePrivateBlobInput[] = [];
  failPutNumber: number | undefined;
  #putCount = 0;

  constructor(
    private readonly planBlob: IssuePrivateBlobInput,
    failPutNumber?: number,
  ) {
    this.failPutNumber = failPutNumber;
  }

  async readBlob(_runId: string, reference: IssuePrivateBlobReference) {
    expect(reference).toEqual(createIssuePrivateBlobReference(this.planBlob));
    return this.planBlob;
  }

  async putBlob(_runId: string, input: IssuePrivateBlobInput) {
    this.#putCount += 1;
    if (this.#putCount === this.failPutNumber) throw new Error("lost publication result");
    const reference = createIssuePrivateBlobReference(input);
    if (
      !this.blobs.some((blob) => createIssuePrivateBlobReference(blob).digest === reference.digest)
    ) {
      this.blobs.push(input);
    }
    return reference;
  }
}

function nodeCommand(source: string, timeoutMs = 2_000): GitHubIssuePlan["holdout"]["command"] {
  return { executable: process.execPath, args: ["-e", source], timeoutMs };
}

function workflow(digit: string) {
  return {
    sourceDigest: digit.repeat(64),
    templateWorkflowDigest: digit.repeat(64),
    model: { provider: "openai", id: "gpt-5.6" },
  };
}

function budget(multiplier: number) {
  return {
    maxNodeStarts: multiplier,
    maxModelTokens: multiplier,
    maxCostUsdMicros: multiplier,
    maxExecutionMs: multiplier,
    maxArtifactBytes: multiplier,
  };
}

function budgetDigest(holdoutTimeoutMs: number, verificationTimeoutMs: number): string {
  const budgetInput = {
    implementation: budget(1),
    review: budget(2),
    holdout: { timeoutMs: holdoutTimeoutMs },
    verification: [{ id: "quality", timeoutMs: verificationTimeoutMs }],
    controller: [{ id: "git-read", timeoutMs: 30_000 }],
  };
  return calculateIssueBudgetDigest(budgetInput);
}

function blob(mediaType: string, value: string) {
  return createIssuePrivateBlobReference({ mediaType, bytes: Buffer.from(value) });
}

function decode(blob: IssuePrivateBlobInput): string {
  return Buffer.from(blob.bytes).toString("utf8");
}

async function rejected(promise: Promise<unknown>): Promise<LocalIssueVerificationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LocalIssueVerificationError);
    return error as LocalIssueVerificationError;
  }
  throw new Error("expected verification rejection");
}

async function rejectedReview(promise: Promise<unknown>): Promise<LocalIssueReviewEvidenceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LocalIssueReviewEvidenceError);
    return error as LocalIssueReviewEvidenceError;
  }
  throw new Error("expected review-evidence rejection");
}

function provider(verification: IssueVerificationResult) {
  return { verify: async () => verification };
}

async function writeGitWrapper(logPath: string): Promise<string> {
  const root = await temporaryDirectory("flow-review-git-wrapper-");
  const wrapper = join(root, "git");
  const source = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, environmentNames: Object.keys(process.env).sort() }) + "\\n");
const result = spawnSync(${JSON.stringify(await gitPath())}, args, { env: process.env, maxBuffer: 2 * 1024 * 1024 });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 127);
`;
  await writeFile(wrapper, source, { encoding: "utf8", mode: 0o700 });
  return wrapper;
}

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
  const result = await execFile(await gitPath(), ["-C", cwd, ...arguments_], {
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "Flow Test",
      GIT_AUTHOR_EMAIL: "flow@example.test",
      GIT_COMMITTER_NAME: "Flow Test",
      GIT_COMMITTER_EMAIL: "flow@example.test",
    },
  });
  return result.stdout.trim();
}

let resolvedGitPath: string | undefined;
async function gitPath(): Promise<string> {
  resolvedGitPath ??= (await execFile("/usr/bin/env", ["which", "git"])).stdout.trim();
  return resolvedGitPath;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
