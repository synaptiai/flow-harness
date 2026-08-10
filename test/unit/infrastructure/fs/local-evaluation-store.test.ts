import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ExternalHarnessIdentity } from "../../../../src/domain/evaluation/external-harness.js";

import {
  calculateEvaluationPlanDigest,
  createEvaluationSchedule,
  type EvaluationPlanIdentity,
} from "../../../../src/domain/evaluation/plan.js";
import {
  createEvaluationTrialRecord,
  unavailableEvaluationMetrics,
} from "../../../../src/domain/evaluation/records.js";
import { admitLocalEvaluationPlan } from "../../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  EvaluationStoreError,
  LocalEvaluationStore,
  type PublicEvaluationHeader,
} from "../../../../src/infrastructure/fs/local-evaluation-store.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local evaluation store", () => {
  it("atomically stores a strict public header without workflow source or private assertions", async () => {
    const { root, admitted } = await admittedEvaluation();
    const store = new LocalEvaluationStore(join(root, "evaluations"));
    const header = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );

    await store.create(header);
    const reopened = await store.read("evaluation-run");
    const durableHeader = await readFile(
      join(root, "evaluations", "evaluation-run", "plan.json"),
      "utf8",
    );

    expect(reopened.header).toEqual(header);
    expect(reopened.records).toEqual([]);
    expect(durableHeader).not.toContain("RESULT.md");
    expect(durableHeader).not.toContain("Follow TASK.md exactly");
    expect(durableHeader).toContain(admitted.suite.tasks[0]?.verifier.digest);
  });

  it("enforces one owner and appends only the exact next digest-chained trial", async () => {
    const { root, admitted } = await admittedEvaluation();
    const stores = [
      new LocalEvaluationStore(join(root, "evaluations")),
      new LocalEvaluationStore(join(root, "evaluations")),
    ] as const;
    const header = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );
    await stores[0].create(header);
    const claimed = await stores[0].claim("evaluation-run", admitted.planDigest);

    expect(claimed.records).toEqual([]);
    await expect(stores[1].claim("evaluation-run", admitted.planDigest)).rejects.toThrow(/owned/i);
    const first = trialRecord(admitted, 0, null);
    await stores[0].append("evaluation-run", first);
    await expect(stores[0].append("evaluation-run", first)).rejects.toThrow(/next|sequence/i);
    await stores[0].release("evaluation-run");

    await expect(stores[0].read("evaluation-run")).resolves.toMatchObject({ records: [first] });
  });

  it("persists an unresolved adapter start across ownership changes", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const firstStore = new LocalEvaluationStore(evaluations);
    await firstStore.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await firstStore.claim("evaluation-run", admitted.planDigest);
    const attempt = trialAttempt(admitted, 0);
    await firstStore.beginAttempt("evaluation-run", attempt);
    await firstStore.release("evaluation-run");

    await expect(firstStore.read("evaluation-run")).resolves.toMatchObject({
      records: [],
      activeAttempt: attempt,
    });

    const resumedStore = new LocalEvaluationStore(evaluations);
    await expect(resumedStore.claim("evaluation-run", admitted.planDigest)).resolves.toMatchObject({
      records: [],
      activeAttempt: attempt,
    });
    await resumedStore.release("evaluation-run");
  });

  it("atomically persists monotonic Prime OCI lease states", async () => {
    const { root, admitted } = await admittedExternalEvaluation(primeExternalHarnessIdentity());
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await store.claim("evaluation-run", admitted.planDigest);
    const first = trialRecord(admitted, 0, null);
    await store.append("evaluation-run", first);
    const attempt = trialAttempt(admitted, 1);
    await store.beginAttempt("evaluation-run", attempt);
    const intent = primeOciLease(attempt.trialId, "intent");
    const withIntent = Object.freeze({ ...attempt, ociLease: intent });

    await store.updateAttempt("evaluation-run", withIntent);
    const created = Object.freeze({
      ...intent,
      state: "created" as const,
      containerId: "f".repeat(64),
      inspectedPolicyDigest: intent.policyDigest,
    });
    const withCreated = Object.freeze({ ...attempt, ociLease: created });
    await store.updateAttempt("evaluation-run", withCreated);
    await expect(store.updateAttempt("evaluation-run", withIntent)).rejects.toThrow(
      /transition|state|regress/i,
    );
    await expect(
      store.updateAttempt("evaluation-run", {
        ...attempt,
        ociLease: {
          ...created,
          imageId: `sha256:${"e".repeat(64)}`,
          labels: { ...created.labels, imageId: `sha256:${"e".repeat(64)}` },
        },
      }),
    ).rejects.toThrow(/identity|immutable|lease/i);
    await store.release("evaluation-run");

    await expect(
      new LocalEvaluationStore(evaluations).read("evaluation-run"),
    ).resolves.toMatchObject({
      activeAttempt: withCreated,
    });
  });

  it("removes an unpublished adapter-start temporary before recovery", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    const directory = join(evaluations, "evaluation-run");
    const temporaryName = `.active-attempt.${"1".repeat(8)}-${"1".repeat(4)}-4${"1".repeat(3)}-8${"1".repeat(3)}-${"1".repeat(12)}.tmp`;
    await writeFile(join(directory, temporaryName), '{"version":1', { mode: 0o600 });

    await expect(store.claim("evaluation-run", admitted.planDigest)).resolves.toMatchObject({
      records: [],
      activeAttempt: null,
    });
    expect(await readdir(directory)).not.toContain(temporaryName);
    await store.release("evaluation-run");
  });

  it("retires a completed adapter start before it returns a resumed claim", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const firstStore = new LocalEvaluationStore(evaluations);
    await firstStore.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await firstStore.claim("evaluation-run", admitted.planDigest);
    const attempt = trialAttempt(admitted, 0);
    const first = trialRecord(admitted, 0, null);
    await firstStore.beginAttempt("evaluation-run", attempt);
    await firstStore.append("evaluation-run", first);
    await firstStore.release("evaluation-run");

    const resumedStore = new LocalEvaluationStore(evaluations);
    await expect(resumedStore.claim("evaluation-run", admitted.planDigest)).resolves.toMatchObject({
      records: [first],
      activeAttempt: null,
    });
    await expect(
      readFile(join(evaluations, "evaluation-run", "active-attempt.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await resumedStore.release("evaluation-run");
  });

  it("rejects an adapter start that contradicts the next scheduled trial", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await store.claim("evaluation-run", admitted.planDigest);
    await store.beginAttempt("evaluation-run", trialAttempt(admitted, 0));
    await store.release("evaluation-run");
    const attemptPath = join(evaluations, "evaluation-run", "active-attempt.json");
    const invalid = JSON.parse(await readFile(attemptPath, "utf8")) as Record<string, unknown>;
    invalid.profileId = "candidate";
    await writeFile(attemptPath, `${JSON.stringify(invalid)}\n`);

    await expect(store.read("evaluation-run")).rejects.toThrow(/attempt|corrupt|schedule/i);
  });

  it("ignores and repairs a torn tail, then rejects committed tampering", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await store.claim("evaluation-run", admitted.planDigest);
    const first = trialRecord(admitted, 0, null);
    await store.append("evaluation-run", first);
    await store.release("evaluation-run");
    const ledgerPath = join(evaluations, "evaluation-run", "trials.jsonl");
    await appendFile(ledgerPath, '{"torn":');

    await expect(store.read("evaluation-run")).resolves.toMatchObject({ records: [first] });
    await store.claim("evaluation-run", admitted.planDigest);
    const second = trialRecord(admitted, 1, first.recordDigest);
    await store.append("evaluation-run", second);
    await store.release("evaluation-run");
    await expect(store.read("evaluation-run")).resolves.toMatchObject({
      records: [first, second],
    });

    const committed = await readFile(ledgerPath, "utf8");
    await writeFile(ledgerPath, committed.replace('"profileId":"baseline"', '"profileId":"wrong"'));
    await expect(store.read("evaluation-run")).rejects.toThrow(/invalid|corrupt|digest|schedule/i);
  });

  it("refuses a ledger swapped for a symbolic link after ownership without touching its target", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await store.claim("evaluation-run", admitted.planDigest);
    const external = join(root, "external.txt");
    await writeFile(external, "must remain unchanged");
    const ledger = join(evaluations, "evaluation-run", "trials.jsonl");
    await unlink(ledger);
    await symlink(external, ledger);

    await expect(store.append("evaluation-run", trialRecord(admitted, 0, null))).rejects.toThrow(
      /append|symbolic|invalid|io/i,
    );
    await expect(readFile(external, "utf8")).resolves.toBe("must remain unchanged");
  });

  it("preserves the corruption code when the ledger changes after ownership", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await store.claim("evaluation-run", admitted.planDigest);
    await appendFile(join(evaluations, "evaluation-run", "trials.jsonl"), "uncommitted");

    await expect(
      store.append("evaluation-run", trialRecord(admitted, 0, null)),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("rejects a static symbolic-link substitution for the evaluation directory", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    const original = join(evaluations, "evaluation-run");
    const relocated = join(root, "relocated-evaluation");
    await rename(original, relocated);
    const targetHeader = await readFile(join(relocated, "plan.json"));
    await symlink(relocated, original, "dir");

    await expect(store.read("evaluation-run")).rejects.toBeInstanceOf(EvaluationStoreError);
    await expect(readFile(join(relocated, "plan.json"))).resolves.toEqual(targetHeader);
  });

  it("rejects invalid UTF-8 in headers, ledgers, and owner metadata before JSON parsing", async () => {
    const headerFixture = await admittedEvaluation();
    const headerRoot = join(headerFixture.root, "evaluations");
    const headerStore = new LocalEvaluationStore(headerRoot);
    await headerStore.create(
      createPublicEvaluationHeader(
        headerFixture.admitted,
        "evaluation-run",
        "2026-08-09T10:00:00.000Z",
      ),
    );
    const headerPath = join(headerRoot, "evaluation-run", "plan.json");
    await writeFile(headerPath, invalidUtf8At(await readFile(headerPath), '"createdAt":"'));
    await expect(headerStore.read("evaluation-run")).rejects.toThrow(/utf-?8/i);

    const ledgerFixture = await admittedEvaluation();
    const ledgerRoot = join(ledgerFixture.root, "evaluations");
    const ledgerStore = new LocalEvaluationStore(ledgerRoot);
    await ledgerStore.create(
      createPublicEvaluationHeader(
        ledgerFixture.admitted,
        "evaluation-run",
        "2026-08-09T10:00:00.000Z",
      ),
    );
    await ledgerStore.claim("evaluation-run", ledgerFixture.admitted.planDigest);
    await ledgerStore.append("evaluation-run", trialRecord(ledgerFixture.admitted, 0, null));
    const ownerPath = join(ledgerRoot, "evaluation-run", ".owner", "owner.json");
    await writeFile(ownerPath, invalidUtf8At(await readFile(ownerPath), '"acquiredAt":"'));
    await expect(ledgerStore.release("evaluation-run")).rejects.toThrow(/utf-?8/i);

    const ledgerPath = join(ledgerRoot, "evaluation-run", "trials.jsonl");
    await writeFile(ledgerPath, invalidUtf8At(await readFile(ledgerPath), '"startedAt":"'));
    await expect(new LocalEvaluationStore(ledgerRoot).read("evaluation-run")).rejects.toThrow(
      /utf-?8/i,
    );
  });

  it("rejects an exact-schedule record carrying another verifier identity", async () => {
    const { root, admitted } = await admittedEvaluation();
    const store = new LocalEvaluationStore(join(root, "evaluations"));
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await store.claim("evaluation-run", admitted.planDigest);

    await expect(
      store.append("evaluation-run", trialRecord(admitted, 0, null, "f".repeat(64))),
    ).rejects.toThrow(/verifier|sequence/i);
  });

  it("rejects a public header whose evaluation id does not match its directory", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    await store.create(
      createPublicEvaluationHeader(admitted, "evaluation-run", "2026-08-09T10:00:00.000Z"),
    );
    await rename(join(evaluations, "evaluation-run"), join(evaluations, "different-run"));

    await expect(store.read("different-run")).rejects.toThrow(/identity|header|evaluation id/i);
  });

  it("rejects a redigested header that moves candidate provenance off the comparison candidate", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    const header = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );
    await store.create(header);
    const headerBaseline = flowProfile(header.profiles[0]);

    const misplacedIdentityWithoutDigest = {
      version: 1 as const,
      id: "misplaced-candidate",
      candidateVersion: "1.0.0",
      scope: { kind: "workflow" as const, workflowId: "benchmark-profile" },
      manifest: {
        provenance: "candidate.prompt-candidate.yaml",
        sourceSha256: "a".repeat(64),
      },
      baseline: {
        provenance: headerBaseline.workflow.provenance,
        sourceSha256: headerBaseline.workflow.sourceSha256,
        workflowDigest: headerBaseline.workflow.workflowDigest,
      },
      evidence: [
        {
          provenance: "tuning-evidence.json",
          sourceSha256: "d".repeat(64),
          evidenceDigest: "e".repeat(64),
          planDigest: "f".repeat(64),
        },
      ],
      changes: [
        {
          nodeId: "implement",
          beforeSha256: "1".repeat(64),
          afterSha256: "2".repeat(64),
        },
      ],
      projectedWorkflow: {
        sourceSha256: headerBaseline.workflow.sourceSha256,
        workflowDigest: headerBaseline.workflow.workflowDigest,
      },
    };
    const candidate = {
      provenance: "candidate.prompt-candidate.yaml",
      identity: {
        ...misplacedIdentityWithoutDigest,
        candidateDigest: sha256Canonical(misplacedIdentityWithoutDigest),
      },
    };
    const profiles = flowProfiles(header).map((profile, index) => ({
      id: profile.id,
      adapter: profile.adapter,
      workflow: {
        provenance: profile.workflow.provenance,
        sourceSha256: profile.workflow.sourceSha256,
        workflowDigest: profile.workflow.workflowDigest,
        ...(index === 0
          ? { sourceKind: "prompt-candidate-projection" as const }
          : profile.workflow.sourceKind === undefined
            ? {}
            : { sourceKind: profile.workflow.sourceKind }),
      },
      ...(index === 0
        ? { candidate }
        : profile.candidate === undefined
          ? {}
          : { candidate: profile.candidate }),
    }));
    const identity: EvaluationPlanIdentity = {
      version: 1,
      apiVersion: header.apiVersion,
      id: header.planId,
      suite: header.suite,
      profiles,
      controls: header.controls,
      seeds: header.seeds,
      order: header.order,
      comparison: header.comparison,
    };
    const planDigest = calculateEvaluationPlanDigest(identity);
    const tamperedHeader = {
      ...header,
      planDigest,
      profiles,
      schedule: createEvaluationSchedule(
        planDigest,
        header.suite.tasks.map((task) => task.id),
        profiles.map((profile) => profile.id),
        header.seeds,
      ),
    };
    await writeFile(
      join(evaluations, "evaluation-run", "plan.json"),
      `${JSON.stringify(tamperedHeader)}\n`,
    );

    await expect(store.read("evaluation-run")).rejects.toThrow(/corrupt|header/i);
  });

  it("claims a legacy direct-workflow header with the currently admitted unchanged plan", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    const current = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );
    const profiles = flowProfiles(current).map((profile) => ({
      id: profile.id,
      adapter: profile.adapter,
      workflow: {
        provenance: profile.workflow.provenance,
        sourceSha256: profile.workflow.sourceSha256,
        workflowDigest: profile.workflow.workflowDigest,
      },
    }));
    const legacyIdentity: EvaluationPlanIdentity = {
      version: 1,
      apiVersion: current.apiVersion,
      id: current.planId,
      suite: current.suite,
      profiles,
      controls: current.controls,
      seeds: current.seeds,
      order: current.order,
      comparison: current.comparison,
    };
    const planDigest = calculateEvaluationPlanDigest(legacyIdentity);
    await store.create({
      ...current,
      planDigest,
      profiles,
      schedule: [
        ...createEvaluationSchedule(
          planDigest,
          current.suite.tasks.map((task) => task.id),
          profiles.map((profile) => profile.id),
          current.seeds,
        ),
      ],
    });

    expect(admitted.planDigest).toBe(planDigest);
    expect(planDigest).toBe("2c7b5aef0105c0dbe921123e2f6a6e163582d4d000f452edc22a11e35ddcead0");
    await expect(store.claim("evaluation-run", admitted.planDigest)).resolves.toMatchObject({
      records: [],
    });
  });

  it("rejects each redigested external identity change on resume", async () => {
    const baseIdentity = nativePiIdentity();
    const changedIdentities: Extract<
      ExternalHarnessIdentity,
      { readonly adapter: "pi-native-v1" }
    >[] = [
      { ...baseIdentity, adapterContractVersion: "1.0.1" },
      {
        ...baseIdentity,
        protocol: { ...baseIdentity.protocol, digest: "5".repeat(64) },
      },
      {
        ...baseIdentity,
        runtime: { ...baseIdentity.runtime, version: "0.0.71" },
      },
      {
        ...baseIdentity,
        runtime: { ...baseIdentity.runtime, policyDigest: "6".repeat(64) },
      },
      {
        ...baseIdentity,
        driver: { ...baseIdentity.driver, artifactSha256: "7".repeat(64) },
      },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, version: "0.84.1" },
      },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, integrity: `sha512-${"B".repeat(86)}==` },
      },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, configDigest: "8".repeat(64) },
      },
    ];

    for (const [index, changedIdentity] of changedIdentities.entries()) {
      const { root, admitted } = await admittedExternalEvaluation(baseIdentity);
      const evaluations = join(root, "evaluations");
      const store = new LocalEvaluationStore(evaluations);
      const evaluationId = `external-identity-${String(index)}`;
      const header = createPublicEvaluationHeader(
        admitted,
        evaluationId,
        "2026-08-09T10:00:00.000Z",
      );
      await store.create(header);
      const changedHeader = replaceExternalHarnessIdentity(header, changedIdentity);
      await writeFile(
        join(evaluations, evaluationId, "plan.json"),
        `${JSON.stringify(changedHeader)}\n`,
      );

      await expect(
        new LocalEvaluationStore(evaluations).claim(evaluationId, admitted.planDigest),
      ).rejects.toThrow(/plan|identity|changed/i);
    }
  });

  it("rejects each redigested OMP identity change on resume", async () => {
    const baseIdentity = nativeOmpIdentity();
    const changedIdentities: Extract<
      ExternalHarnessIdentity,
      { readonly adapter: "omp-native-v1" }
    >[] = [
      { ...baseIdentity, adapterContractVersion: "1.0.1" },
      { ...baseIdentity, protocol: { ...baseIdentity.protocol, digest: "4".repeat(64) } },
      { ...baseIdentity, runtime: { ...baseIdentity.runtime, version: "0.0.71" } },
      {
        ...baseIdentity,
        runtime: { ...baseIdentity.runtime, packageContentSha256: "5".repeat(64) },
      },
      {
        ...baseIdentity,
        runtime: { ...baseIdentity.runtime, policyDigest: "6".repeat(64) },
      },
      {
        ...baseIdentity,
        driver: { ...baseIdentity.driver, artifactSha256: "7".repeat(64) },
      },
      {
        ...baseIdentity,
        driver: { ...baseIdentity.driver, dependencyClosureSha256: "8".repeat(64) },
      },
      {
        ...baseIdentity,
        driver: {
          ...baseIdentity.driver,
          bun: { ...baseIdentity.driver.bun, version: "1.3.15" },
        },
      },
      {
        ...baseIdentity,
        driver: {
          ...baseIdentity.driver,
          bun: { ...baseIdentity.driver.bun, executableSha256: "9".repeat(64) },
        },
      },
      { ...baseIdentity, harness: { ...baseIdentity.harness, version: "17.2.13" } },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, integrity: `sha512-${"C".repeat(86)}==` },
      },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, packageContentSha256: "a".repeat(64) },
      },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, dependencyClosureSha256: "b".repeat(64) },
      },
      {
        ...baseIdentity,
        harness: { ...baseIdentity.harness, configDigest: "c".repeat(64) },
      },
      {
        ...baseIdentity,
        inference: { ...baseIdentity.inference, packageVersion: "17.2.13" },
      },
      {
        ...baseIdentity,
        inference: { ...baseIdentity.inference, packageContentSha256: "d".repeat(64) },
      },
    ];

    for (const [index, changedIdentity] of changedIdentities.entries()) {
      const { root, admitted } = await admittedExternalEvaluation(baseIdentity);
      const evaluations = join(root, "evaluations");
      const store = new LocalEvaluationStore(evaluations);
      const evaluationId = `omp-identity-${String(index)}`;
      const header = createPublicEvaluationHeader(
        admitted,
        evaluationId,
        "2026-08-09T10:00:00.000Z",
      );
      await store.create(header);
      const changedHeader = replaceExternalHarnessIdentity(header, changedIdentity);
      await writeFile(
        join(evaluations, evaluationId, "plan.json"),
        `${JSON.stringify(changedHeader)}\n`,
      );

      await expect(
        new LocalEvaluationStore(evaluations).claim(evaluationId, admitted.planDigest),
      ).rejects.toThrow(/plan|identity|changed/i);
    }
  });

  it("rejects a durable external profile that omits an identity field", async () => {
    const { root, admitted } = await admittedExternalEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    const header = createPublicEvaluationHeader(
      admitted,
      "external-missing-field",
      "2026-08-09T10:00:00.000Z",
    );
    await store.create(header);
    const changed = JSON.parse(JSON.stringify(header)) as {
      profiles: { adapter: string; harness?: { driver?: unknown } }[];
    };
    const external = changed.profiles.find((profile) => profile.adapter === "pi-native-v1");
    if (external?.harness === undefined) {
      throw new Error("test header has no external profile");
    }
    delete external.harness.driver;
    await writeFile(
      join(evaluations, "external-missing-field", "plan.json"),
      `${JSON.stringify(changed)}\n`,
    );

    await expect(store.read("external-missing-field")).rejects.toThrow(/header|corrupt/i);
  });

  it("rejects the non-canonical explicit file source kind in a redigested public header", async () => {
    const { root, admitted } = await admittedEvaluation();
    const store = new LocalEvaluationStore(join(root, "evaluations"));
    const header = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );
    const profiles = flowProfiles(header).map((profile) => ({
      ...profile,
      workflow: { ...profile.workflow, sourceKind: "file" as const },
    }));
    const identity = {
      version: 1 as const,
      apiVersion: header.apiVersion,
      id: header.planId,
      suite: header.suite,
      profiles,
      controls: header.controls,
      seeds: header.seeds,
      order: header.order,
      comparison: header.comparison,
    } as unknown as EvaluationPlanIdentity;
    const planDigest = calculateEvaluationPlanDigest(identity);

    await expect(
      store.create({
        ...header,
        planDigest,
        profiles: profiles as never,
        schedule: [
          ...createEvaluationSchedule(
            planDigest,
            header.suite.tasks.map((task) => task.id),
            profiles.map((profile) => profile.id),
            header.seeds,
          ),
        ],
      }),
    ).rejects.toThrow(/corrupt|header/i);
  });

  it("rejects a redigested header whose complete candidate identity is internally inconsistent", async () => {
    const { root, admitted } = await admittedEvaluation();
    const evaluations = join(root, "evaluations");
    const store = new LocalEvaluationStore(evaluations);
    const direct = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );
    const baseline = flowProfile(direct.profiles[0]);
    const selected = flowProfile(direct.profiles[1]);
    const identityWithoutDigest = {
      version: 1 as const,
      id: "better-instructions",
      candidateVersion: "1.0.0",
      scope: { kind: "workflow" as const, workflowId: "benchmark-profile" },
      manifest: {
        provenance: "candidate.prompt-candidate.yaml",
        sourceSha256: "a".repeat(64),
      },
      baseline: {
        provenance: baseline.workflow.provenance,
        sourceSha256: baseline.workflow.sourceSha256,
        workflowDigest: baseline.workflow.workflowDigest,
      },
      evidence: [
        {
          provenance: "tuning-evidence.json",
          sourceSha256: "b".repeat(64),
          evidenceDigest: "c".repeat(64),
          planDigest: "d".repeat(64),
        },
      ],
      changes: [
        {
          nodeId: "implement",
          beforeSha256: "e".repeat(64),
          afterSha256: "f".repeat(64),
        },
      ],
      projectedWorkflow: {
        sourceSha256: selected.workflow.sourceSha256,
        workflowDigest: selected.workflow.workflowDigest,
      },
    };
    const candidateIdentity = {
      ...identityWithoutDigest,
      candidateDigest: sha256Canonical(identityWithoutDigest),
    };
    const profiles = [
      {
        ...baseline,
        workflow: {
          provenance: baseline.workflow.provenance,
          sourceSha256: baseline.workflow.sourceSha256,
          workflowDigest: baseline.workflow.workflowDigest,
        },
      },
      {
        ...selected,
        workflow: {
          ...selected.workflow,
          provenance: "candidate.prompt-candidate.yaml",
          sourceKind: "prompt-candidate-projection" as const,
        },
        candidate: {
          provenance: "candidate.prompt-candidate.yaml",
          identity: candidateIdentity,
        },
      },
    ];
    const identity = {
      version: 1 as const,
      apiVersion: direct.apiVersion,
      id: direct.planId,
      suite: direct.suite,
      profiles,
      controls: direct.controls,
      seeds: direct.seeds,
      order: direct.order,
      comparison: direct.comparison,
    } as unknown as EvaluationPlanIdentity;
    const planDigest = calculateEvaluationPlanDigest(identity);
    await store.create({
      ...direct,
      planDigest,
      profiles: profiles as never,
      schedule: [
        ...createEvaluationSchedule(
          planDigest,
          direct.suite.tasks.map((task) => task.id),
          profiles.map((profile) => profile.id),
          direct.seeds,
        ),
      ],
    });

    const headerPath = join(evaluations, "evaluation-run", "plan.json");
    const tampered = JSON.parse(await readFile(headerPath, "utf8"));
    tampered.profiles[1].candidate.identity.evidence[0].evidenceDigest = "9".repeat(64);
    const tamperedIdentity = {
      version: 1,
      apiVersion: tampered.apiVersion,
      id: tampered.planId,
      suite: tampered.suite,
      profiles: tampered.profiles,
      controls: tampered.controls,
      seeds: tampered.seeds,
      order: tampered.order,
      comparison: tampered.comparison,
    };
    tampered.planDigest = calculateEvaluationPlanDigest(
      tamperedIdentity as unknown as EvaluationPlanIdentity,
    );
    tampered.schedule = createEvaluationSchedule(
      tampered.planDigest,
      tampered.suite.tasks.map((task: { id: string }) => task.id),
      tampered.profiles.map((profile: { id: string }) => profile.id),
      tampered.seeds,
    );
    await writeFile(headerPath, `${JSON.stringify(tampered)}\n`);

    await expect(store.read("evaluation-run")).rejects.toThrow(/corrupt|header/i);
  });

  it("rejects duplicate JSON keys in public headers and committed trial records", async () => {
    const headerFixture = await admittedEvaluation();
    const headerEvaluations = join(headerFixture.root, "evaluations");
    const headerStore = new LocalEvaluationStore(headerEvaluations);
    await headerStore.create(
      createPublicEvaluationHeader(
        headerFixture.admitted,
        "evaluation-run",
        "2026-08-09T10:00:00.000Z",
      ),
    );
    const headerPath = join(headerEvaluations, "evaluation-run", "plan.json");
    const header = await readFile(headerPath, "utf8");
    await writeFile(headerPath, header.replace('"version":1,', '"version":1,"version":1,'));
    await expect(headerStore.read("evaluation-run")).rejects.toThrow(/duplicate|corrupt|header/i);

    const ledgerFixture = await admittedEvaluation();
    const ledgerEvaluations = join(ledgerFixture.root, "evaluations");
    const ledgerStore = new LocalEvaluationStore(ledgerEvaluations);
    await ledgerStore.create(
      createPublicEvaluationHeader(
        ledgerFixture.admitted,
        "evaluation-run",
        "2026-08-09T10:00:00.000Z",
      ),
    );
    await ledgerStore.claim("evaluation-run", ledgerFixture.admitted.planDigest);
    await ledgerStore.append("evaluation-run", trialRecord(ledgerFixture.admitted, 0, null));
    await ledgerStore.release("evaluation-run");
    const ledgerPath = join(ledgerEvaluations, "evaluation-run", "trials.jsonl");
    const ledger = await readFile(ledgerPath, "utf8");
    await writeFile(ledgerPath, ledger.replace('"version":1,', '"version":1,"version":1,'));
    await expect(ledgerStore.read("evaluation-run")).rejects.toThrow(/duplicate|corrupt|record/i);
  });
});

async function admittedEvaluation() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-store-")));
  temporaryDirectories.push(root);
  await mkdir(join(root, "fixtures/task"), { recursive: true });
  await writeFile(join(root, "fixtures/task", "TASK.md"), "Create RESULT.md.\n");
  const workflow = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: benchmark-profile }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Follow TASK.md exactly.
      model: { provider: test, id: deterministic }
      tools: [read, edit]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 1024 }
`;
  await writeFile(join(root, "baseline.workflow.yaml"), workflow);
  await writeFile(join(root, "candidate.workflow.yaml"), workflow);
  await writeFile(
    join(root, "evaluation.yaml"),
    `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: harness-comparison }
suite:
  id: foundation-suite
  version: 1.0.0
  tasks:
    - id: edit-readme
      partition: holdout
      fixture: fixtures/task
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions: [{ kind: exists, path: RESULT.md }]
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }
  - { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }
controls:
  model: { provider: test, id: deterministic, thinking: medium }
  budget:
    maxNodeStarts: 8
    maxModelTokens: 10000
    maxCostUsdMicros: 1000000
    maxExecutionMs: 300000
    maxArtifactBytes: 1048576
  network: deny
  retry: { providerRetries: 0, harnessRetries: 0 }
seeds: [11]
order: paired-alternating-v1
comparison:
  baselineProfileId: baseline
  candidateProfileId: candidate
  minimumPairedTrials: 1
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`,
  );
  return { root, admitted: await admitLocalEvaluationPlan(join(root, "evaluation.yaml")) };
}

async function admittedExternalEvaluation(identity: ExternalHarnessIdentity = nativePiIdentity()) {
  const { root } = await admittedEvaluation();
  const planPath = join(root, "evaluation.yaml");
  const source = await readFile(planPath, "utf8");
  await writeFile(
    planPath,
    source.replace(
      "- { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }",
      identity.adapter === "pi-native-v1"
        ? "- { id: candidate, adapter: pi-native-v1, harness: { config: pi-evaluation-v1 } }"
        : identity.adapter === "omp-native-v1"
          ? "- { id: candidate, adapter: omp-native-v1, harness: { config: omp-evaluation-v1 } }"
          : "- { id: candidate, adapter: prime-agent-native-v1, harness: { config: prime-agent-rlm-evaluation-v1 } }",
    ),
  );
  return {
    root,
    admitted: await admitLocalEvaluationPlan(planPath, {
      resolveExternalHarnessIdentity: async () => identity,
    }),
  };
}

function replaceExternalHarnessIdentity(
  header: PublicEvaluationHeader,
  harness: ExternalHarnessIdentity,
): PublicEvaluationHeader {
  const profiles: EvaluationPlanIdentity["profiles"] = header.profiles.map((profile) => {
    if (profile.adapter === "pi-native-v1") {
      return {
        id: profile.id,
        adapter: profile.adapter,
        harness: harness.adapter === "pi-native-v1" ? harness : profile.harness,
      };
    }
    if (profile.adapter === "omp-native-v1") {
      return {
        id: profile.id,
        adapter: profile.adapter,
        harness: harness.adapter === "omp-native-v1" ? harness : profile.harness,
      };
    }
    if (profile.adapter === "prime-agent-native-v1") {
      return {
        id: profile.id,
        adapter: profile.adapter,
        harness: harness.adapter === "prime-agent-native-v1" ? harness : profile.harness,
      };
    }
    return {
      id: profile.id,
      adapter: profile.adapter,
      workflow: {
        provenance: profile.workflow.provenance,
        sourceSha256: profile.workflow.sourceSha256,
        workflowDigest: profile.workflow.workflowDigest,
        ...(profile.workflow.sourceKind === undefined
          ? {}
          : { sourceKind: profile.workflow.sourceKind }),
      },
      ...(profile.candidate === undefined ? {} : { candidate: profile.candidate }),
    };
  });
  const identity: EvaluationPlanIdentity = {
    version: 1,
    apiVersion: header.apiVersion,
    id: header.planId,
    suite: header.suite,
    profiles: [...profiles],
    controls: header.controls,
    seeds: header.seeds,
    order: header.order,
    comparison: header.comparison,
  };
  const planDigest = calculateEvaluationPlanDigest(identity);
  return {
    ...header,
    planDigest,
    profiles: [...profiles],
    schedule: [
      ...createEvaluationSchedule(
        planDigest,
        header.suite.tasks.map((task) => task.id),
        profiles.map((profile) => profile.id),
        header.seeds,
      ),
    ],
  };
}

function nativePiIdentity(): Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "pi-native-v1" }
> {
  return {
    version: 1,
    adapter: "pi-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "2".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-pi-evaluation-v1",
      artifactSha256: "3".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      node: { version: "22.19.0", executableSha256: "3".repeat(64) },
    },
    harness: {
      package: "@earendil-works/pi-coding-agent",
      version: "0.84.0",
      integrity:
        "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==",
      packageContentSha256: "4".repeat(64),
      config: "pi-evaluation-v1",
      configDigest: "4".repeat(64),
    },
    inference: {
      id: "flow-pi-inference-v1",
      version: 1,
      package: "@earendil-works/pi-ai",
      packageVersion: "0.84.0",
      packageIntegrity: `sha512-${"B".repeat(86)}==`,
      packageContentSha256: "5".repeat(64),
    },
  };
}

function nativeOmpIdentity(): Extract<
  ExternalHarnessIdentity,
  { readonly adapter: "omp-native-v1" }
> {
  return {
    version: 1,
    adapter: "omp-native-v1",
    adapterContractVersion: "1.0.0",
    protocol: {
      id: "flow-external-harness-jsonl-v1",
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    },
    runtime: {
      id: "srt-process-v1",
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "3".repeat(64),
      platform: "linux",
      containment: "linux-pid-namespace",
    },
    driver: {
      id: "native-omp-evaluation-v1",
      artifactSha256: "4".repeat(64),
      dependencyClosureSha256: "5".repeat(64),
      bun: { version: "1.3.14", executableSha256: "6".repeat(64) },
    },
    harness: {
      package: "@oh-my-pi/pi-coding-agent",
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "7".repeat(64),
      dependencyClosureSha256: "8".repeat(64),
      config: "omp-evaluation-v1",
      configDigest: "9".repeat(64),
    },
    inference: {
      id: "flow-omp-inference-v1",
      version: 1,
      package: "@oh-my-pi/pi-ai",
      packageVersion: "17.2.12",
      packageContentSha256: "a".repeat(64),
    },
  };
}

function trialRecord(
  admitted: Awaited<ReturnType<typeof admitLocalEvaluationPlan>>,
  index: number,
  previousDigest: string | null,
  verifierDigest = admitted.suite.tasks[0]?.verifier.digest ?? "a".repeat(64),
) {
  const schedule = admitted.schedule[index];
  if (schedule === undefined) {
    throw new Error("missing test schedule item");
  }
  return createEvaluationTrialRecord({
    schedule,
    planDigest: admitted.planDigest,
    previousDigest,
    startedAt: "2026-08-09T10:00:00.000Z",
    completedAt: "2026-08-09T10:00:01.000Z",
    environment: {
      platform: process.platform === "darwin" ? "darwin" : "linux",
      architecture: process.arch,
      nodeVersion: process.version,
      flowVersion: "0.0.0",
      workspaceBackend: "reflink-copy-v1",
      workspaceSnapshotDigest: "f".repeat(64),
    },
    harness: { outcome: "completed", runId: `eval-${schedule.trialId}`, reason: null },
    verification: {
      outcome: "accepted",
      verifierDigest,
      assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
    },
    metrics: unavailableEvaluationMetrics(),
  });
}

function trialAttempt(
  admitted: Awaited<ReturnType<typeof admittedEvaluation>>["admitted"],
  index: number,
) {
  const schedule = admitted.schedule[index];
  const profile = admitted.profiles.find((item) => item.id === schedule?.profileId);
  if (schedule === undefined || profile === undefined) {
    throw new Error("missing trial attempt inputs");
  }
  return Object.freeze({
    version: 1 as const,
    planDigest: admitted.planDigest,
    position: schedule.position,
    trialId: schedule.trialId,
    taskId: schedule.taskId,
    profileId: schedule.profileId,
    adapter: profile.adapter,
    startedAt: "2026-08-09T10:00:00.000Z",
    workspace: Object.freeze({
      backend: "reflink-copy-v1" as const,
      snapshotDigest: "e".repeat(64),
    }),
  });
}

function primeOciLease(trialId: string, state: "intent") {
  const ownerNonce = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}` as const;
  const policyDigest = "c".repeat(64);
  return Object.freeze({
    version: 1 as const,
    adapter: "prime-agent-native-v1" as const,
    state,
    ownerNonce,
    containerName: `flow-prime-${"d".repeat(32)}` as const,
    labels: Object.freeze({
      evaluationId: "evaluation-run",
      trialId,
      ownerNonce,
      imageId,
      policyDigest,
    }),
    imageId,
    policyDigest,
    fixtureDigest: "e".repeat(64),
    engineEndpoint: Object.freeze({
      socketPath: "/var/run/docker.sock" as const,
      device: 1,
      inode: 2,
      uid: 0,
      gid: 999,
      mode: 0o660,
    }),
  });
}

type FlowPublicProfile = Extract<
  PublicEvaluationHeader["profiles"][number],
  { readonly adapter: "flow-workflow-v1" }
>;

function flowProfile(
  profile: PublicEvaluationHeader["profiles"][number] | undefined,
): FlowPublicProfile {
  if (profile?.adapter !== "flow-workflow-v1") {
    throw new Error("evaluation fixture profile is not a Flow workflow");
  }
  return profile;
}

function flowProfiles(header: PublicEvaluationHeader): readonly FlowPublicProfile[] {
  return header.profiles.map((profile) => flowProfile(profile));
}

function invalidUtf8At(contents: Buffer, marker: string): Buffer {
  const copy = Buffer.from(contents);
  const index = copy.indexOf(marker) + Buffer.byteLength(marker);
  if (index < Buffer.byteLength(marker)) {
    throw new Error(`missing test marker ${marker}`);
  }
  copy[index] = 0x80;
  return copy;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("test identity is not canonical JSON");
}
