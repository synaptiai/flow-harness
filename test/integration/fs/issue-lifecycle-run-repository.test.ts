import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  IssueLifecycleCommandRecordInput,
  IssueLifecycleCommandSettlement,
  IssueLifecycleRunInitialization,
} from "../../../src/application/issue-lifecycle-store.js";
import { parseIssueLifecycleCommand } from "../../../src/domain/issue-lifecycle/commands.js";
import type { IssueLifecycleEvent } from "../../../src/domain/issue-lifecycle/events.js";
import {
  calculateIssueBudgetDigest,
  calculateIssuePrivateManifestDigest,
  createIssuePrivateBlobReference,
  type IssuePrivateBlobInput,
  parseIssuePrivateManifest,
} from "../../../src/domain/issue-lifecycle/private-manifest.js";
import {
  IssueLifecycleStoreError,
  type IssueLifecycleStorePublicationPoint,
  JsonlIssueLifecycleStore,
} from "../../../src/infrastructure/fs/jsonl-issue-lifecycle-store.js";

const temporaryDirectories: string[] = [];
const RUN_ID = "issue-run-197-aabbccdd";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonlIssueLifecycleStore aggregate repository", () => {
  it("publishes the manifest, initial blobs, snapshot, command, and owner atomically", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    const initialization = aggregateInitialization();

    await store.initialize(initialization);

    await expect(store.readManifest(RUN_ID)).resolves.toEqual(initialization.manifest);
    await expect(store.read(RUN_ID)).resolves.toEqual([initialization.snapshot]);
    const initialCommand = await store.readCommand(
      RUN_ID,
      initialization.manifest.initialCommandId,
    );
    expect(initialCommand).toMatchObject({
      command: initialization.command.command,
      recordedAt: initialization.command.recordedAt,
    });
    expect(initialCommand.settlement).toBeUndefined();
    for (const blob of initialization.initialBlobs) {
      const reference = createIssuePrivateBlobReference(blob);
      await expect(store.readBlob(RUN_ID, reference)).resolves.toEqual(blob);
    }
    await expect(store.append(workspacePrepared())).resolves.toBeUndefined();

    const runMetadata = await lstat(join(root, RUN_ID));
    const manifestMetadata = await lstat(join(root, RUN_ID, "private", "frozen-v1.json"));
    expect(runMetadata.mode & 0o777).toBe(0o700);
    expect(manifestMetadata.mode & 0o777).toBe(0o600);
    if (process.getuid !== undefined) {
      expect(runMetadata.uid).toBe(process.getuid());
      expect(manifestMetadata.uid).toBe(process.getuid());
    }
  });

  it("keeps legacy sequence-one initialization ledger-only with a stable manifest error", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);

    await store.append(aggregateInitialization().snapshot);

    await expect(store.readManifest(RUN_ID)).rejects.toMatchObject({ code: "manifest_missing" });
  });

  it("requires lifecycle ownership for blob writes but permits immutable deduplication", async () => {
    const root = await createTemporaryDirectory();
    const owner = new JsonlIssueLifecycleStore(root);
    const peer = new JsonlIssueLifecycleStore(root);
    const initialization = aggregateInitialization();
    const blob = privateBlob("text/plain; charset=utf-8", "later evidence");

    await owner.initialize(initialization);
    await expect(peer.putBlob(RUN_ID, blob)).rejects.toMatchObject({ code: "not_owner" });
    const first = await owner.putBlob(RUN_ID, blob);
    await expect(owner.putBlob(RUN_ID, blob)).resolves.toEqual(first);
    await expect(owner.readBlob(RUN_ID, first)).resolves.toEqual(blob);
  });

  it("revalidates blob metadata, byte length, digest, links, and private modes on every read", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    const blob = privateBlob("text/plain; charset=utf-8", "later evidence");
    const reference = await store.putBlob(RUN_ID, blob);
    const blobDirectory = join(root, RUN_ID, "private", "blobs", "sha256", reference.digest);

    await writeFile(join(blobDirectory, "data"), "changed", { mode: 0o600 });
    await expect(store.readBlob(RUN_ID, reference)).rejects.toMatchObject({ code: "corrupt" });

    await writeFile(join(blobDirectory, "data"), blob.bytes, { mode: 0o600 });
    await chmod(join(blobDirectory, "metadata.json"), 0o644);
    await expect(store.readBlob(RUN_ID, reference)).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("records UUID commands idempotently and rejects changed-input replay", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    const command = cancelCommand("2026-08-28T12:10:00.000Z");

    const first = await store.recordCommand(command);
    await expect(
      store.recordCommand({ ...structuredClone(command), recordedAt: "2026-08-28T12:20:00.000Z" }),
    ).resolves.toEqual(first);
    await expect(
      store.recordCommand({
        ...command,
        command: {
          ...parseIssueLifecycleCommand(command.command),
          reason: "different request",
        },
      }),
    ).rejects.toMatchObject({ code: "command_conflict" });
  });

  it("rejects a second run command instead of journaling a new initialization", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    const initialization = aggregateInitialization();
    await store.initialize(initialization);

    await expect(
      store.recordCommand({
        ...initialization.command,
        command: {
          ...parseIssueLifecycleCommand(initialization.command.command),
          commandId: "623e4567-e89b-42d3-a456-426614174000",
        },
      }),
    ).rejects.toMatchObject({ code: "command_conflict" });
  });

  it("settles commands once and replays the original settlement", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    const input = cancelCommand("2026-08-28T12:10:00.000Z");
    const command = await store.recordCommand(input);
    const settlement = commandSettlement(command.commandDigest);

    const first = await store.settleCommand(RUN_ID, command.command.commandId, settlement);
    await expect(
      store.settleCommand(RUN_ID, command.command.commandId, structuredClone(settlement)),
    ).resolves.toEqual(first);
    await expect(store.readCommand(RUN_ID, command.command.commandId)).resolves.toMatchObject({
      settlement,
    });
    await expect(
      store.settleCommand(RUN_ID, command.command.commandId, {
        ...settlement,
        outcome: "failed",
        code: "cancel_failed",
      }),
    ).rejects.toMatchObject({ code: "command_conflict" });
  });

  it("rejects command and settlement timestamps that precede their durable parent", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    await expect(
      store.recordCommand(cancelCommand("2026-08-28T11:59:59.999Z")),
    ).rejects.toMatchObject({ code: "corrupt" });

    const command = await store.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z"));
    await expect(
      store.settleCommand(RUN_ID, command.command.commandId, {
        ...commandSettlement(command.commandDigest),
        settledAt: "2026-08-28T12:09:59.999Z",
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("selects the oldest unsettled cancellation independently of lifecycle ownership", async () => {
    const root = await createTemporaryDirectory();
    const owner = new JsonlIssueLifecycleStore(root);
    const operator = new JsonlIssueLifecycleStore(root);
    await owner.initialize(aggregateInitialization());
    const later = await operator.recordCommand(cancelCommand("2026-08-28T12:12:00.000Z", "5"));
    const earlier = await operator.recordCommand(cancelCommand("2026-08-28T12:11:00.000Z", "4"));

    await expect(owner.readPendingCancellation(RUN_ID)).resolves.toEqual(earlier);
    await operator.settleCommand(
      RUN_ID,
      earlier.command.commandId,
      commandSettlement(earlier.commandDigest),
    );
    await expect(owner.readPendingCancellation(RUN_ID)).resolves.toEqual(later);
    await operator.settleCommand(
      RUN_ID,
      later.command.commandId,
      commandSettlement(later.commandDigest),
    );
    await expect(owner.readPendingCancellation(RUN_ID)).resolves.toBeUndefined();
  });

  it.each([
    "initialize_before_publish",
    "initialize_after_publish",
  ] satisfies readonly IssueLifecycleStorePublicationPoint[])(
    "recovers deterministically from %s injection",
    async (failurePoint) => {
      const root = await createTemporaryDirectory();
      const store = new JsonlIssueLifecycleStore(root, {
        publicationHook: async (point) => {
          if (point === failurePoint) throw new Error(`injected ${point}`);
        },
      });

      await expect(store.initialize(aggregateInitialization())).rejects.toBeInstanceOf(
        IssueLifecycleStoreError,
      );
      if (failurePoint === "initialize_before_publish") {
        await expect(store.exists(RUN_ID)).resolves.toBe(false);
      } else {
        await expect(store.exists(RUN_ID)).resolves.toBe(true);
        await expect(store.readManifest(RUN_ID)).resolves.toEqual(
          aggregateInitialization().manifest,
        );
      }
    },
  );

  it.each([
    ["blob_before_publish", false],
    ["blob_after_publish", true],
    ["command_reservation_before_publish", false],
    ["command_reservation_after_publish", false],
    ["command_before_publish", false],
    ["command_after_publish", true],
    ["settlement_before_publish", false],
    ["settlement_after_publish", true],
  ] satisfies readonly [IssueLifecycleStorePublicationPoint, boolean][])(
    "leaves an atomic result after %s injection",
    async (failurePoint, published) => {
      const root = await createTemporaryDirectory();
      const initialization = aggregateInitialization();
      const store = new JsonlIssueLifecycleStore(root);
      await store.initialize(initialization);
      await store.release(RUN_ID);
      let armed = true;
      const faulting = new JsonlIssueLifecycleStore(root, {
        publicationHook: async (point) => {
          if (armed && point === failurePoint) throw new Error(`injected ${point}`);
        },
      });
      await faulting.claim(RUN_ID);
      const blob = privateBlob("text/plain; charset=utf-8", "atomic evidence");
      const cancel = cancelCommand("2026-08-28T12:10:00.000Z");
      const operation = failurePoint.startsWith("blob")
        ? faulting.putBlob(RUN_ID, blob)
        : failurePoint.startsWith("command")
          ? faulting.recordCommand(cancel)
          : faulting
              .recordCommand(cancel)
              .then(
                async (record) =>
                  await faulting.settleCommand(
                    RUN_ID,
                    record.command.commandId,
                    commandSettlement(record.commandDigest),
                  ),
              );

      await expect(operation).rejects.toBeInstanceOf(IssueLifecycleStoreError);
      armed = false;
      if (failurePoint.startsWith("blob")) {
        const reference = createIssuePrivateBlobReference(blob);
        if (published) await expect(faulting.readBlob(RUN_ID, reference)).resolves.toEqual(blob);
        else
          await expect(faulting.readBlob(RUN_ID, reference)).rejects.toMatchObject({
            code: "not_found",
          });
        await expect(faulting.putBlob(RUN_ID, blob)).resolves.toEqual(reference);
      } else {
        const replay = await faulting.recordCommand(cancel);
        if (failurePoint.startsWith("settlement") && published) {
          expect(replay.settlement).toEqual(commandSettlement(replay.commandDigest));
        }
      }
    },
  );

  it("enforces the command-count ceiling when independent writers race", async () => {
    const root = await createTemporaryDirectory();
    const owner = new JsonlIssueLifecycleStore(root, { maxCommands: 2 });
    await owner.initialize(aggregateInitialization());
    const left = new JsonlIssueLifecycleStore(root, { maxCommands: 2 });
    const right = new JsonlIssueLifecycleStore(root, { maxCommands: 2 });

    const results = await Promise.allSettled([
      left.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z", "4")),
      right.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z", "5")),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "limit" },
    });
  });

  it("allows exactly one winner when two initializations race", async () => {
    const root = await createTemporaryDirectory();
    const left = new JsonlIssueLifecycleStore(root);
    const right = new JsonlIssueLifecycleStore(root);

    const results = await Promise.allSettled([
      left.initialize(aggregateInitialization()),
      right.initialize(aggregateInitialization()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ reason: { code: "run_exists" } });
    await expect(left.readManifest(RUN_ID)).resolves.toEqual(aggregateInitialization().manifest);
  });

  it("enforces manifest, blob, aggregate-private, blob-count, command-size, and command-count bounds", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root, {
      maxManifestBytes: 128,
      maxBlobBytes: 8,
      maxBlobs: 4,
      maxPrivateBytes: 24,
      maxCommandBytes: 256,
      maxCommands: 1,
    });

    await expect(store.initialize(aggregateInitialization())).rejects.toMatchObject({
      code: "limit",
    });

    const usable = new JsonlIssueLifecycleStore(await createTemporaryDirectory(), {
      maxCommandBytes: 512,
      maxCommands: 1,
    });
    await usable.initialize(aggregateInitialization());
    await expect(
      usable.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z")),
    ).rejects.toMatchObject({
      code: "limit",
    });
  });

  it.each([
    ["manifest", { maxManifestBytes: 128 }],
    ["blob", { maxBlobBytes: 5 }],
    ["blob count", { maxBlobs: 3 }],
    ["aggregate private bytes", { maxPrivateBytes: 10 }],
    ["command", { maxCommandBytes: 128 }],
  ])("enforces the configured %s initialization ceiling", async (_name, options) => {
    const store = new JsonlIssueLifecycleStore(await createTemporaryDirectory(), options);

    await expect(store.initialize(aggregateInitialization())).rejects.toMatchObject({
      code: "limit",
    });
  });

  it("reports corrupt command reservations with a stable non-retryable code", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    await writeFile(
      join(root, RUN_ID, "private", "command-slots", "0000", "reservation.json"),
      "not-json\n",
      { mode: 0o600 },
    );

    await expect(
      store.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z")),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("does not reuse a missing reservation to exceed the command ceiling", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root, { maxCommands: 1 });
    await store.initialize(aggregateInitialization());
    await rm(join(root, RUN_ID, "private", "command-slots", "0000"), { recursive: true });

    await expect(
      store.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z")),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects a symbolic pending command entry instead of bypassing path validation", async () => {
    const root = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    await symlink(outside, join(root, RUN_ID, "private", "commands", ".evil.pending"));

    await expect(store.readPendingCancellation(RUN_ID)).rejects.toMatchObject({
      code: "unsafe_path",
    });
  });

  it("rejects unsafe private manifest paths without exposing file contents", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    const manifestPath = join(root, RUN_ID, "private", "frozen-v1.json");
    await chmod(manifestPath, 0o644);

    const error = await store.readManifest(RUN_ID).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "unsafe_path",
      message: "Issue lifecycle store failed: unsafe_path",
    });
    expect(String(error)).not.toContain(await readFile(manifestPath, "utf8"));
  });

  it("distinguishes a readable manifest from corruption in another required private directory", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    const initialization = aggregateInitialization();
    await store.initialize(initialization);
    await rm(join(root, RUN_ID, "private", "command-slots"), { recursive: true });

    await expect(store.readManifest(RUN_ID)).resolves.toEqual(initialization.manifest);
    await expect(
      store.recordCommand(cancelCommand("2026-08-28T12:10:00.000Z")),
    ).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("rejects later blob writes when an existing content-addressed blob is corrupt", async () => {
    const root = await createTemporaryDirectory();
    const store = new JsonlIssueLifecycleStore(root);
    await store.initialize(aggregateInitialization());
    const first = privateBlob("text/plain; charset=utf-8", "first evidence");
    const reference = await store.putBlob(RUN_ID, first);
    await writeFile(
      join(root, RUN_ID, "private", "blobs", "sha256", reference.digest, "data"),
      "corrupt",
      { mode: 0o600 },
    );

    await expect(
      store.putBlob(RUN_ID, privateBlob("text/plain; charset=utf-8", "second evidence")),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("binds aggregate initialization to configured event limits and the manifest timestamp", async () => {
    const root = await createTemporaryDirectory();
    const tooSmall = new JsonlIssueLifecycleStore(root, { maxEventBytes: 128 });
    await expect(tooSmall.initialize(aggregateInitialization())).rejects.toMatchObject({
      code: "limit",
    });

    const original = aggregateInitialization();
    const changed = {
      ...original,
      snapshot: { ...original.snapshot, at: "2026-08-28T12:00:01.000Z" },
    };
    await expect(
      new JsonlIssueLifecycleStore(await createTemporaryDirectory()).initialize(changed),
    ).rejects.toMatchObject({ code: "corrupt" });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flow-issue-run-repository-"));
  temporaryDirectories.push(directory);
  return directory;
}

function aggregateInitialization(): IssueLifecycleRunInitialization {
  const initialBlobs = [
    privateBlob("application/vnd.flow.github-issue+json", "issue"),
    privateBlob("application/vnd.flow.github-issue-plan+yaml", "plan"),
    privateBlob("application/vnd.flow.workflow+yaml", "implementation"),
    privateBlob("application/vnd.flow.workflow+yaml", "review"),
  ] as const;
  const issue = createIssuePrivateBlobReference(initialBlobs[0]);
  const plan = createIssuePrivateBlobReference(initialBlobs[1]);
  const implementationWorkflow = createIssuePrivateBlobReference(initialBlobs[2]);
  const reviewWorkflow = createIssuePrivateBlobReference(initialBlobs[3]);
  const budgets = {
    implementation: completeBudget(1),
    review: completeBudget(2),
    holdout: { timeoutMs: 120_000 },
    verification: [{ id: "test", timeoutMs: 300_000 }],
    controller: [{ id: "github-read", timeoutMs: 60_000 }],
  };
  const manifest = parseIssuePrivateManifest({
    version: 1,
    runId: RUN_ID,
    initialCommandId: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-08-28T12:00:00.000Z",
    repository: {
      host: "github.com",
      identity: "synaptiai/flow-harness",
      nodeId: "R_kgDOExample",
      canonicalUrl: "https://github.com/synaptiai/flow-harness",
    },
    issue: {
      number: 197,
      nodeId: "I_kwDOExample",
      state: "open",
      updatedAt: "2026-08-28T11:00:00.000Z",
      canonicalUrl: "https://github.com/synaptiai/flow-harness/issues/197",
      contentDigest: issue.digest,
    },
    base: { branch: "main", commit: "a".repeat(40), remoteRef: "refs/heads/main" },
    branch: { prefix: "flow/issue-", name: "flow/issue-197-aabbccdd" },
    planDigest: "2".repeat(64),
    implementationWorkflow: {
      sourceDigest: "3".repeat(64),
      templateWorkflowDigest: "4".repeat(64),
      capabilitySnapshotDigest: "5".repeat(64),
      model: { provider: "openai", id: "gpt-5.6-sol" },
    },
    reviewWorkflow: {
      sourceDigest: "6".repeat(64),
      templateWorkflowDigest: "7".repeat(64),
      capabilitySnapshotDigest: "8".repeat(64),
      model: { provider: "openai", id: "gpt-5.6-sol" },
      resultNodeId: "review-result",
    },
    acceptanceCriteria: [{ id: "criterion-one", description: "The criterion is met." }],
    allowedWritePrefixes: ["src/", "test/"],
    holdout: { commandDigest: "9".repeat(64), timeoutMs: 120_000 },
    verification: [{ id: "test", commandDigest: "b".repeat(64), timeoutMs: 300_000 }],
    hostedChecks: [{ name: "CI / test", sourceApp: { id: 15_368, slug: "github-actions" } }],
    merge: { method: "squash", deleteBranch: true },
    budgets,
    budgetDigest: calculateIssueBudgetDigest(budgets),
    artifacts: { issue, plan, implementationWorkflow, reviewWorkflow },
  });
  const frozenContractDigest = calculateIssuePrivateManifestDigest(manifest);
  return {
    manifest,
    initialBlobs,
    snapshot: {
      version: 1,
      runId: RUN_ID,
      sequence: 1,
      at: manifest.createdAt,
      type: "phase_transitioned",
      from: "preflight",
      to: "issue_frozen",
      receipt: {
        kind: "issue_snapshot",
        repositoryIdentity: manifest.repository.identity,
        issueNumber: manifest.issue.number,
        issueNodeId: manifest.issue.nodeId,
        issueUpdatedAt: manifest.issue.updatedAt,
        baseBranch: manifest.base.branch,
        baseCommit: manifest.base.commit,
        branch: manifest.branch.name,
        issueDigest: manifest.issue.contentDigest,
        frozenContractDigest,
        planDigest: manifest.planDigest,
        implementationTemplateWorkflowDigest:
          manifest.implementationWorkflow.templateWorkflowDigest,
        reviewTemplateWorkflowDigest: manifest.reviewWorkflow.templateWorkflowDigest,
        budgetDigest: manifest.budgetDigest,
        evidenceDigest: "c".repeat(64),
      },
    },
    command: {
      runId: RUN_ID,
      recordedAt: manifest.createdAt,
      command: {
        version: 1,
        kind: "run",
        commandId: manifest.initialCommandId,
        issueUrl: manifest.issue.canonicalUrl,
        repositoryIdentity: manifest.repository.identity,
        planDigest: manifest.planDigest,
        provider: manifest.implementationWorkflow.model.provider,
        model: manifest.implementationWorkflow.model.id,
      },
    },
  };
}

function cancelCommand(recordedAt: string, uuidPrefix = "3"): IssueLifecycleCommandRecordInput {
  return {
    runId: RUN_ID,
    recordedAt,
    command: {
      version: 1,
      kind: "cancel",
      commandId: `${uuidPrefix}23e4567-e89b-42d3-a456-426614174000`,
      runId: RUN_ID,
      actor: "local:operator",
      reason: "operator stopped the run",
    },
  };
}

function commandSettlement(commandDigest: string): IssueLifecycleCommandSettlement {
  return {
    version: 1,
    commandDigest,
    settledAt: "2026-08-28T12:15:00.000Z",
    outcome: "completed",
    resultDigest: "d".repeat(64),
  };
}

function privateBlob(mediaType: string, value: string): IssuePrivateBlobInput {
  return { mediaType, bytes: new TextEncoder().encode(value) };
}

function completeBudget(seed: number) {
  return {
    maxNodeStarts: seed * 10,
    maxModelTokens: seed * 1_000,
    maxCostUsdMicros: seed * 100_000,
    maxExecutionMs: seed * 60_000,
    maxArtifactBytes: seed * 1_024,
  };
}

function workspacePrepared(): IssueLifecycleEvent {
  const operationDigest = "d".repeat(64);
  return {
    version: 1,
    runId: RUN_ID,
    sequence: 2,
    at: "2026-08-28T12:00:02.000Z",
    type: "external_effect_prepared",
    effectId: `effect-workspace-${operationDigest}`,
    effectKind: "workspace",
    operationDigest,
  };
}
