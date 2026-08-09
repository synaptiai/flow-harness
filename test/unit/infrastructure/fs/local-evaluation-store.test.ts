import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
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
} from "../../../../src/infrastructure/fs/local-evaluation-store.js";

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
        provenance: header.profiles[0]?.workflow.provenance ?? "baseline.workflow.yaml",
        sourceSha256: header.profiles[0]?.workflow.sourceSha256 ?? "b".repeat(64),
        workflowDigest: header.profiles[0]?.workflow.workflowDigest ?? "c".repeat(64),
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
        sourceSha256: header.profiles[0]?.workflow.sourceSha256 ?? "3".repeat(64),
        workflowDigest: header.profiles[0]?.workflow.workflowDigest ?? "4".repeat(64),
      },
    };
    const candidate = {
      provenance: "candidate.prompt-candidate.yaml",
      identity: {
        ...misplacedIdentityWithoutDigest,
        candidateDigest: sha256Canonical(misplacedIdentityWithoutDigest),
      },
    };
    const profiles = header.profiles.map((profile, index) => ({
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
    const profiles = current.profiles.map((profile) => ({
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
    await expect(store.claim("evaluation-run", admitted.planDigest)).resolves.toMatchObject({
      records: [],
    });
  });

  it("rejects the non-canonical explicit file source kind in a redigested public header", async () => {
    const { root, admitted } = await admittedEvaluation();
    const store = new LocalEvaluationStore(join(root, "evaluations"));
    const header = createPublicEvaluationHeader(
      admitted,
      "evaluation-run",
      "2026-08-09T10:00:00.000Z",
    );
    const profiles = header.profiles.map((profile) => ({
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
    const baseline = direct.profiles[0];
    const selected = direct.profiles[1];
    if (baseline === undefined || selected === undefined) {
      throw new Error("fixture profiles are missing");
    }
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
