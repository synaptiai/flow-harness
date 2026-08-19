import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { projectEffectiveHarnessCandidate } from "../../../../src/application/prepare-effective-harness-candidate.js";
import {
  type AgentSkillCandidateIdentity,
  calculateAgentSkillCandidateIdentityDigest,
} from "../../../../src/domain/adaptation/agent-skill-candidate.js";
import {
  createEffectiveHarnessCandidateArtifact,
  encodeEffectiveHarnessCandidateArtifact,
} from "../../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../../src/domain/adaptation/effective-harness-state.js";
import {
  calculateEvaluationPlanDigest,
  createEvaluationSchedule,
  type EvaluationPlanIdentity,
} from "../../../../src/domain/evaluation/plan.js";
import { createEvaluationTrialRecord } from "../../../../src/domain/evaluation/records.js";
import { createTuningEvidencePacket } from "../../../../src/domain/evaluation/tuning-evidence.js";
import { compileWorkflowText } from "../../../../src/domain/workflow/compiler.js";
import { calculateWorkflowDigest } from "../../../../src/domain/workflow/digest.js";
import { admitLocalAdaptationCandidate } from "../../../../src/infrastructure/fs/local-adaptation-candidate.js";
import {
  discoverProjectAgentSkills,
  snapshotSelectedAgentSkills,
} from "../../../../src/infrastructure/fs/local-agent-skill-catalog.js";
import {
  admitLocalEvaluationPlan,
  MAX_EVALUATION_INSTRUCTION_BYTES,
} from "../../../../src/infrastructure/fs/local-evaluation-plan.js";
import {
  createPublicEvaluationHeader,
  LocalEvaluationStore,
  type PublicEvaluationHeader,
} from "../../../../src/infrastructure/fs/local-evaluation-store.js";
import { effectiveHarnessCandidateArtifactFixture } from "../../../fixtures/effective-harness-evaluation.js";
import { primeExternalHarnessIdentity } from "../../../fixtures/evaluation/prime-external-harness-identity.js";
import { modelRoutingCandidateFixture } from "../../../fixtures/model-routing-candidate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local evaluation plan admission", () => {
  it("admits immutable fixture, instruction, verifier, workflow, and schedule identities", async () => {
    const project = await evaluationProject();

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));

    expect(admitted).toMatchObject({
      apiVersion: "flow.synapti.ai/v1alpha1",
      id: "harness-comparison",
      suite: {
        id: "foundation-suite",
        version: "1.0.0",
        tasks: [
          {
            id: "edit-readme",
            partition: "holdout",
            fixture: {
              sourceCwd: join(project, "fixtures/edit-readme"),
              entryCount: 2,
              logicalBytes: expect.any(Number),
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              instructionPath: "TASK.md",
              instructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
            verifier: {
              kind: "filesystem-v1",
              digest: expect.stringMatching(/^[a-f0-9]{64}$/),
              assertions: [{ kind: "exists", path: "RESULT.md" }],
            },
          },
        ],
      },
      profiles: [
        {
          id: "baseline",
          adapter: "flow-workflow-v1",
          workflow: {
            workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        {
          id: "candidate",
          adapter: "flow-workflow-v1",
          workflow: {
            workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      ],
      planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(admitted.schedule).toHaveLength(4);
    expect(admitted.schedule.map((trial) => trial.profileId)).toEqual([
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("selects one immutable effective harness artifact as the exact baseline and candidate pair", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project);
    const legacyCandidate = await admitLocalAdaptationCandidate(
      join(project, "better.prompt-candidate.yaml"),
    );
    if (legacyCandidate.kind !== "prompt-candidate") {
      throw new Error("effective harness evaluation fixture is not a prompt candidate");
    }
    const baselineSource = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
    const baselineState = createEffectiveHarnessState({
      scopeDigest: "a".repeat(64),
      workflowSource: baselineSource,
      packages: [],
    });
    const projected = projectEffectiveHarnessCandidate({
      baseline: baselineState,
      candidate: {
        kind: "prompt",
        projection: legacyCandidate.candidate,
        baselineWorkflowSource: baselineSource,
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest: baselineState.scopeDigest,
        workflowId: baselineState.workflowId,
        generation: 7,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baselineState.stateDigest,
      }),
      baselineState,
      candidateState: projected.state,
      candidate: legacyCandidate.candidate.identity,
    });
    await writeFile(
      join(project, "candidate.effective-harness.json"),
      encodeEffectiveHarnessCandidateArtifact(artifact),
    );
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan.replace(
        /profiles:[\s\S]*?controls:/,
        `profiles:
  - { id: baseline, adapter: flow-workflow-v1, effectiveCandidate: candidate.effective-harness.json, selection: baseline }
  - { id: candidate, adapter: flow-workflow-v1, effectiveCandidate: candidate.effective-harness.json, selection: candidate }
controls:`,
      ),
    );

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    await rm(join(project, "candidate.effective-harness.json"));

    const [baseline, candidate] = admitted.profiles;
    expect(baseline).toMatchObject({
      id: "baseline",
      adapter: "flow-workflow-v1",
      workflow: {
        sourceKind: "effective-harness-baseline",
        workflowDigest: artifact.baselineState.workflow.workflowDigest,
      },
      effectiveHarness: {
        selection: "baseline",
        artifactDigest: artifact.artifactDigest,
        stateDigest: artifact.baselineState.stateDigest,
        baselineHeadDigest: artifact.baselineHead.headDigest,
      },
    });
    expect(candidate).toMatchObject({
      id: "candidate",
      adapter: "flow-workflow-v1",
      workflow: {
        sourceKind: "effective-harness-candidate-projection",
        workflowDigest: artifact.candidateState.workflow.workflowDigest,
      },
      candidate: { candidateDigest: artifact.candidate.candidateDigest },
      effectiveHarness: {
        selection: "candidate",
        artifactDigest: artifact.artifactDigest,
        stateDigest: artifact.candidateState.stateDigest,
        baselineHeadDigest: artifact.baselineHead.headDigest,
      },
    });
    expect(admitted.planDigest).toMatch(/^[a-f0-9]{64}$/);
    const header = createPublicEvaluationHeader(admitted, "effective-harness-evaluation");
    expect(JSON.stringify(header)).not.toContain("contentBase64");
    expect(header.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "baseline",
          effectiveHarness: expect.objectContaining({
            selection: "baseline",
            stateDigest: artifact.baselineState.stateDigest,
          }),
        }),
        expect.objectContaining({
          id: "candidate",
          effectiveHarness: expect.objectContaining({
            selection: "candidate",
            stateDigest: artifact.candidateState.stateDigest,
          }),
        }),
      ]),
    );
    const store = new LocalEvaluationStore(join(project, "evaluations"));
    await store.create(header);
    await expect(store.read("effective-harness-evaluation")).resolves.toMatchObject({ header });
  });

  it("binds two explicit profile routes to one exact model-routing artifact", async () => {
    const project = await evaluationProject();
    const baselineSource = routingWorkflowSource();
    const baselineState = createEffectiveHarnessState({
      scopeDigest: "a".repeat(64),
      workflowSource: baselineSource,
      packages: [],
    });
    const route = modelRoutingCandidateFixture(baselineSource);
    const projected = projectEffectiveHarnessCandidate({
      baseline: baselineState,
      candidate: {
        kind: "model-routing",
        projection: route,
        baselineWorkflowSource: baselineSource,
      },
    });
    const artifact = createEffectiveHarnessCandidateArtifact({
      baselineHead: createEffectiveHarnessHeadIdentity({
        scopeDigest: baselineState.scopeDigest,
        workflowId: baselineState.workflowId,
        generation: 7,
        activationDigest: "b".repeat(64),
        transitionDigest: "c".repeat(64),
        stateDigest: baselineState.stateDigest,
      }),
      baselineState,
      candidateState: projected.state,
      candidate: route.identity,
    });
    await writeFile(
      join(project, "route.effective-harness.json"),
      encodeEffectiveHarnessCandidateArtifact(artifact),
    );
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan
        .replace(
          /profiles:[\s\S]*?controls:/,
          `profiles:
  - { id: baseline, adapter: flow-workflow-v1, effectiveCandidate: route.effective-harness.json, selection: baseline }
  - { id: candidate, adapter: flow-workflow-v1, effectiveCandidate: route.effective-harness.json, selection: candidate }
controls:`,
        )
        .replace(
          "  budget:",
          `  modelRoutes:
    - { profileId: baseline, nodeId: implement, route: { provider: test, id: deterministic, thinking: medium } }
    - { profileId: candidate, nodeId: implement, route: { provider: openai, id: gpt-5.4, thinking: high } }
  budget:`,
        ),
    );

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    expect(admitted.controls.modelRoutes).toEqual([
      { profileId: "baseline", nodeId: "implement", route: route.identity.route.before },
      { profileId: "candidate", nodeId: "implement", route: route.identity.route.after },
    ]);
    expect(admitted.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "baseline",
          effectiveHarness: expect.objectContaining({ surface: "model-routing" }),
        }),
        expect.objectContaining({
          id: "candidate",
          candidate: expect.objectContaining({ kind: "model-routing-candidate" }),
          effectiveHarness: expect.objectContaining({ surface: "model-routing" }),
        }),
      ]),
    );
    const header = createPublicEvaluationHeader(admitted, "route-evaluation");
    expect((header.controls as typeof admitted.controls).modelRoutes).toEqual(
      admitted.controls.modelRoutes,
    );
    expect(header.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "baseline",
          effectiveHarness: expect.objectContaining({
            selection: "baseline",
            surface: "model-routing",
          }),
        }),
        expect.objectContaining({
          id: "candidate",
          candidate: {
            provenance: "route.effective-harness.json",
            identity: expect.objectContaining({
              kind: "model-routing-candidate",
              scope: expect.objectContaining({ nodeId: "implement" }),
              route: route.identity.route,
            }),
          },
          effectiveHarness: expect.objectContaining({
            selection: "candidate",
            surface: "model-routing",
          }),
        }),
      ]),
    );
    const store = new LocalEvaluationStore(join(project, "evaluations"));
    await store.create(header);
    await expect(store.read("route-evaluation")).resolves.toMatchObject({ header });

    const forged = structuredClone(header) as MutablePublicHeader;
    forged.evaluationId = "forged-route-evaluation";
    const forgedRoutes = forged.controls.modelRoutes;
    if (forgedRoutes === undefined) throw new Error("route header has no model routes");
    const forgedCandidateRoute = forgedRoutes[1];
    if (forgedCandidateRoute === undefined) throw new Error("route header has no candidate route");
    forgedCandidateRoute.route.id = "gpt-5.5-private-canary";
    redigestEvaluationHeader(forged);
    await expect(store.create(forged as PublicEvaluationHeader)).rejects.toMatchObject({
      code: "corrupt",
      message: expect.not.stringContaining("gpt-5.5-private-canary"),
    });
  });

  it("rejects an effective harness artifact through the legacy candidate field", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project);
    await writeFile(
      join(project, "candidate.effective-harness.json"),
      encodeEffectiveHarnessCandidateArtifact(effectiveHarnessCandidateArtifactFixture()),
    );
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan.replace("better.prompt-candidate.yaml", "candidate.effective-harness.json"),
    );

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrow(
      /requires the effectiveCandidate field/i,
    );
  });

  it("keeps plan identity portable across different absolute project roots", async () => {
    const first = await evaluationProject();
    const second = await evaluationProject();

    const [left, right] = await Promise.all([
      admitLocalEvaluationPlan(join(first, "evaluation.yaml")),
      admitLocalEvaluationPlan(join(second, "evaluation.yaml")),
    ]);

    expect(left.planDigest).toBe(right.planDigest);
    expect(left.suite.tasks[0]?.fixture.digest).toBe(right.suite.tasks[0]?.fixture.digest);
  });

  it("preserves the legacy direct-workflow plan identity", async () => {
    const project = await evaluationProject();
    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const header = createPublicEvaluationHeader(admitted, "direct-evaluation");

    expect(
      header.profiles.every(
        (profile) =>
          profile.adapter === "flow-workflow-v1" && profile.workflow.sourceKind === undefined,
      ),
    ).toBe(true);
  });

  it("admits an external profile through one exact trusted harness identity", async () => {
    const project = await evaluationProject();
    const source = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      source.replace(
        "- { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }",
        "- { id: candidate, adapter: pi-native-v1, harness: { config: pi-evaluation-v1 } }",
      ),
    );
    const identity = nativePiIdentity();

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"), {
      resolveExternalHarnessIdentity: async (profile) => {
        expect(profile).toEqual({
          id: "candidate",
          adapter: "pi-native-v1",
          harness: { config: "pi-evaluation-v1" },
        });
        return identity;
      },
    });

    expect(admitted.profiles[0]).toMatchObject({
      id: "baseline",
      adapter: "flow-workflow-v1",
      workflow: { workflowDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(admitted.profiles[1]).toEqual({
      id: "candidate",
      adapter: "pi-native-v1",
      harness: identity,
    });
    expect(createPublicEvaluationHeader(admitted, "external-evaluation").profiles[1]).toEqual({
      id: "candidate",
      adapter: "pi-native-v1",
      harness: identity,
    });
  });

  it("admits an OMP profile through the generic external harness resolver", async () => {
    const project = await evaluationProject();
    const source = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      source.replace(
        "- { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }",
        "- { id: candidate, adapter: omp-native-v1, harness: { config: omp-evaluation-v1 } }",
      ),
    );
    const identity = nativeOmpIdentity();

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"), {
      resolveExternalHarnessIdentity: async (profile) => {
        expect(profile).toEqual({
          id: "candidate",
          adapter: "omp-native-v1",
          harness: { config: "omp-evaluation-v1" },
        });
        return identity;
      },
    });

    expect(admitted.profiles[1]).toEqual({
      id: "candidate",
      adapter: "omp-native-v1",
      harness: identity,
    });
    expect(createPublicEvaluationHeader(admitted, "omp-evaluation").profiles[1]).toEqual({
      id: "candidate",
      adapter: "omp-native-v1",
      harness: identity,
    });
  });

  it("admits a Prime profile through one exact OCI identity", async () => {
    const project = await evaluationProject();
    const source = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      source.replace(
        "- { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }",
        "- { id: candidate, adapter: prime-agent-native-v1, harness: { config: prime-agent-rlm-evaluation-v1 } }",
      ),
    );
    const identity = primeExternalHarnessIdentity();

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"), {
      resolveExternalHarnessIdentity: async (profile) => {
        expect(profile).toEqual({
          id: "candidate",
          adapter: "prime-agent-native-v1",
          harness: { config: "prime-agent-rlm-evaluation-v1" },
        });
        return identity;
      },
    });

    expect(admitted.profiles[1]).toEqual({
      id: "candidate",
      adapter: "prime-agent-native-v1",
      harness: identity,
    });
    expect(createPublicEvaluationHeader(admitted, "prime-evaluation").profiles[1]).toEqual({
      id: "candidate",
      adapter: "prime-agent-native-v1",
      harness: identity,
    });
  });

  it("admits a prompt-candidate profile as an exact projected workflow identity", async () => {
    const project = await evaluationProject();
    const baselineText = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
    const baselineDigest = calculateWorkflowDigest(compileWorkflowText(baselineText));
    const evidence = tuningEvidence(baselineDigest);
    const evidenceText = JSON.stringify(evidence);
    await writeFile(join(project, "tuning.json"), evidenceText);
    await writeFile(
      join(project, "better.prompt-candidate.yaml"),
      JSON.stringify({
        apiVersion: "flow.synapti.ai/v1alpha1",
        kind: "PromptCandidate",
        metadata: { id: "better-instructions", version: "1.0.0" },
        scope: { kind: "workflow", workflowId: "baseline" },
        baseline: {
          workflow: "baseline.workflow.yaml",
          sourceSha256: sha256(baselineText),
          workflowDigest: baselineDigest,
        },
        evidence: [
          {
            path: "tuning.json",
            sourceSha256: sha256(evidenceText),
            evidenceDigest: evidence.evidenceDigest,
            planDigest: evidence.evaluation.planDigest,
          },
        ],
        changes: {
          prompts: [
            {
              nodeId: "implement",
              expectedSha256: sha256("Follow TASK.md exactly."),
              value: "Read TASK.md, implement it carefully, and verify the result.",
            },
          ],
        },
      }),
    );
    const direct = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan.replace("workflow: candidate.workflow.yaml", "candidate: better.prompt-candidate.yaml"),
    );

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const candidate = admitted.profiles[1];
    if (candidate?.adapter !== "flow-workflow-v1") {
      throw new Error("candidate profile fixture is not a Flow workflow");
    }
    expect(candidate.candidate).toMatchObject({
      id: "better-instructions",
      candidateVersion: "1.0.0",
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      baseline: { workflowDigest: baselineDigest },
      changes: [{ nodeId: "implement" }],
    });
    expect(candidate.workflow.compiled.nodes[0]).toMatchObject({
      type: "agent",
      agent: { prompt: "Read TASK.md, implement it carefully, and verify the result." },
    });
    expect(candidate.workflow.sourcePath).toBeNull();
    expect(candidate.workflow.sourceKind).toBe("prompt-candidate-projection");
    expect(admitted.planDigest).not.toBe(direct.planDigest);
    expect(
      createPublicEvaluationHeader(admitted, "candidate-evaluation").profiles[1],
    ).toMatchObject({
      id: "candidate",
      candidate: {
        provenance: "better.prompt-candidate.yaml",
        identity: {
          candidateDigest: candidate.candidate?.candidateDigest,
          baseline: { workflowDigest: baselineDigest },
          evidence: [{ evidenceDigest: evidence.evidenceDigest }],
          changes: [{ nodeId: "implement" }],
        },
      },
      workflow: { sourceKind: "prompt-candidate-projection" },
    });
  });

  it("admits an Agent Skill candidate as one workflow with paired immutable skill snapshots", async () => {
    const project = await evaluationProject();
    const fixture = await configureAgentSkillCandidateProfile(project);

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const baseline = admitted.profiles[0];
    const candidate = admitted.profiles[1];
    if (baseline?.adapter !== "flow-workflow-v1" || candidate?.adapter !== "flow-workflow-v1") {
      throw new Error("Agent Skill evaluation fixture is not a paired Flow workflow");
    }

    expect(baseline.workflow).toMatchObject({
      sourceKind: "file",
      sourceSha256: sha256(fixture.workflowText),
      workflowDigest: fixture.workflowDigest,
    });
    expect(candidate.workflow).toMatchObject({
      sourceKind: "agent-skill-candidate-projection",
      sourceSha256: sha256(fixture.workflowText),
      workflowDigest: fixture.workflowDigest,
    });
    const candidateIdentity = candidate.candidate;
    if (
      candidateIdentity === undefined ||
      !("kind" in candidateIdentity) ||
      candidateIdentity.kind !== "agent-skill-candidate"
    ) {
      throw new Error("Agent Skill evaluation fixture has no Agent Skill candidate identity");
    }
    expect(baseline.capabilitySnapshot?.digest).toBe(
      candidateIdentity.baseline.skill.capabilityDigest,
    );
    expect(candidate.capabilitySnapshot?.digest).toBe(
      candidateIdentity.projectedSkill.capabilityDigest,
    );
    expect(candidate.capabilitySnapshot?.digest).not.toBe(baseline.capabilitySnapshot?.digest);
    expect(candidate.workflow.compiled).toEqual(baseline.workflow.compiled);
    expect(createPublicEvaluationHeader(admitted, "skill-candidate-evaluation").profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "baseline",
          capabilitySnapshotDigest: baseline.capabilitySnapshot?.digest,
        }),
        expect.objectContaining({
          id: "candidate",
          capabilitySnapshotDigest: candidate.capabilitySnapshot?.digest,
          candidate: {
            provenance: "better.agent-skill-candidate.yaml",
            identity: expect.objectContaining({
              kind: "agent-skill-candidate",
              baseline: expect.objectContaining({
                skill: expect.objectContaining({ packageDigest: fixture.baselineSkillDigest }),
              }),
            }),
          },
        }),
      ]),
    );
  });

  it("preserves exact cancellation at a nested Agent Skill candidate boundary", async () => {
    const project = await evaluationProject();
    await configureAgentSkillCandidateProfile(project);
    const controller = new AbortController();
    const reason = new Error("operator cancelled evaluation candidate admission");
    const dependencies = {
      signal: controller.signal,
      afterCandidatePathValidation: (provenance: string) => {
        if (provenance === ".flow/skills/review") {
          controller.abort(reason);
        }
      },
    };

    await expect(
      admitLocalEvaluationPlan(join(project, "evaluation.yaml"), dependencies),
    ).rejects.toBe(reason);
  });

  it("rejects a redigested durable profile that substitutes one skill snapshot identity", async () => {
    const project = await evaluationProject();
    await configureAgentSkillCandidateProfile(project);
    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const header = createPublicEvaluationHeader(admitted, "skill-candidate-evaluation");
    const baseline = header.profiles[0];
    if (baseline?.adapter !== "flow-workflow-v1") {
      throw new Error("Agent Skill evaluation fixture has no Flow baseline profile");
    }
    const profiles: typeof header.profiles = [
      { ...baseline, capabilitySnapshotDigest: "f".repeat(64) },
      ...header.profiles.slice(1),
    ];
    const identityProfiles: EvaluationPlanIdentity["profiles"] = profiles.map((profile) => {
      if (profile.adapter === "pi-native-v1") {
        return { id: profile.id, adapter: profile.adapter, harness: profile.harness };
      }
      if (profile.adapter === "omp-native-v1") {
        return { id: profile.id, adapter: profile.adapter, harness: profile.harness };
      }
      if (profile.adapter === "prime-agent-native-v1") {
        return { id: profile.id, adapter: profile.adapter, harness: profile.harness };
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
        ...(profile.capabilitySnapshotDigest === undefined
          ? {}
          : { capabilitySnapshotDigest: profile.capabilitySnapshotDigest }),
        ...(profile.candidate === undefined ? {} : { candidate: profile.candidate }),
      };
    });
    const identity: EvaluationPlanIdentity = {
      version: 1,
      apiVersion: header.apiVersion,
      id: header.planId,
      suite: header.suite,
      profiles: identityProfiles,
      controls: header.controls,
      seeds: header.seeds,
      order: header.order,
      comparison: header.comparison,
    };
    const planDigest = calculateEvaluationPlanDigest(identity);
    const redigested = {
      ...header,
      profiles,
      planDigest,
      schedule: [
        ...createEvaluationSchedule(
          planDigest,
          header.suite.tasks.map((task) => task.id),
          profiles.map((profile) => profile.id),
          header.seeds,
        ),
      ],
    };

    await expect(
      new LocalEvaluationStore(join(project, "evaluations")).create(redigested),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it.each([
    {
      label: "candidate manifest provenance",
      mutate: (header: MutablePublicHeader) => {
        requiredSkillCandidateIdentity(header).manifest.provenance = "substitute.yaml";
      },
    },
    {
      label: "baseline package digest",
      mutate: (header: MutablePublicHeader) => {
        requiredSkillCandidateIdentity(header).baseline.skill.packageDigest = "f".repeat(64);
      },
    },
    {
      label: "projected package digest",
      mutate: (header: MutablePublicHeader) => {
        requiredSkillCandidateIdentity(header).projectedSkill.packageDigest = "f".repeat(64);
      },
    },
    {
      label: "baseline capability digest",
      mutate: (header: MutablePublicHeader) => {
        requiredSkillCandidateIdentity(header).baseline.skill.capabilityDigest = "f".repeat(64);
      },
    },
    {
      label: "projected capability digest",
      mutate: (header: MutablePublicHeader) => {
        requiredSkillCandidateIdentity(header).projectedSkill.capabilityDigest = "f".repeat(64);
      },
    },
    {
      label: "baseline workflow source",
      mutate: (header: MutablePublicHeader) => {
        requiredSkillCandidateIdentity(header).baseline.workflow.sourceSha256 = "f".repeat(64);
      },
    },
    {
      label: "baseline profile package list",
      mutate: (header: MutablePublicHeader) => {
        requiredFlowProfile(header, "baseline").capabilityPackageDigests = ["f".repeat(64)];
      },
    },
    {
      label: "candidate profile package list",
      mutate: (header: MutablePublicHeader) => {
        requiredFlowProfile(header, "candidate").capabilityPackageDigests = ["f".repeat(64)];
      },
    },
  ])("rejects a redigested durable $label substitution", async ({ mutate }) => {
    const project = await evaluationProject();
    await configureAgentSkillCandidateProfile(project);
    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const header = structuredClone(
      createPublicEvaluationHeader(admitted, "skill-candidate-evaluation"),
    ) as MutablePublicHeader;
    mutate(header);
    redigestSkillCandidateHeader(header);

    await expect(
      new LocalEvaluationStore(join(project, "evaluations")).create(
        header as PublicEvaluationHeader,
      ),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it.each(["baseline", "candidate"] as const)(
    "rejects a jointly redigested %s skill package and package-list substitution",
    async (profileId) => {
      const project = await evaluationProject();
      await configureAgentSkillCandidateProfile(project);
      const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
      const header = structuredClone(
        createPublicEvaluationHeader(admitted, "skill-candidate-evaluation"),
      ) as MutablePublicHeader;
      const substitutedDigest = "f".repeat(64);
      if (profileId === "baseline") {
        requiredSkillCandidateIdentity(header).baseline.skill.packageDigest = substitutedDigest;
      } else {
        requiredSkillCandidateIdentity(header).projectedSkill.packageDigest = substitutedDigest;
      }
      requiredFlowProfile(header, profileId).capabilityPackageDigests = [substitutedDigest];
      redigestSkillCandidateHeader(header);

      await expect(
        new LocalEvaluationStore(join(project, "evaluations")).create(
          header as PublicEvaluationHeader,
        ),
      ).rejects.toMatchObject({ code: "corrupt" });
    },
  );

  it("preserves a nested candidate selection provenance in durable identity", async () => {
    const project = await evaluationProject();
    await configureAgentSkillCandidateProfile(project);
    const nestedRoot = join(project, "candidates");
    await mkdir(join(nestedRoot, ".flow", "skills", "review"), { recursive: true });
    for (const relativePath of [
      "better.agent-skill-candidate.yaml",
      "baseline.workflow.yaml",
      "tuning.json",
      ".flow/skills/review/SKILL.md",
      ".flow/skills/review/reference.md",
    ]) {
      await writeFile(join(nestedRoot, relativePath), await readFile(join(project, relativePath)));
    }
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan.replace(
        "candidate: better.agent-skill-candidate.yaml",
        "candidate: candidates/better.agent-skill-candidate.yaml",
      ),
    );

    const admitted = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const header = createPublicEvaluationHeader(admitted, "nested-skill-candidate-evaluation");
    expect(header.profiles[1]).toMatchObject({
      candidate: {
        provenance: "candidates/better.agent-skill-candidate.yaml",
        identity: {
          manifest: { provenance: "better.agent-skill-candidate.yaml" },
        },
      },
    });
    await expect(
      new LocalEvaluationStore(join(project, "evaluations")).create(header),
    ).resolves.toBeUndefined();
  });

  it("keeps prompt candidate identity stable across a nested plan selection", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project);
    const rootAdmission = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const rootCandidate = rootAdmission.profiles[1];
    if (rootCandidate?.adapter !== "flow-workflow-v1" || rootCandidate.candidate === undefined) {
      throw new Error("prompt candidate fixture has no admitted candidate profile");
    }
    const nestedRoot = join(project, "candidates");
    await mkdir(nestedRoot);
    for (const relativePath of [
      "better.prompt-candidate.yaml",
      "baseline.workflow.yaml",
      "tuning.json",
    ]) {
      await writeFile(join(nestedRoot, relativePath), await readFile(join(project, relativePath)));
    }
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan.replace(
        "candidate: better.prompt-candidate.yaml",
        "candidate: candidates/better.prompt-candidate.yaml",
      ),
    );

    const nestedAdmission = await admitLocalEvaluationPlan(join(project, "evaluation.yaml"));
    const nestedCandidate = nestedAdmission.profiles[1];
    if (
      nestedCandidate?.adapter !== "flow-workflow-v1" ||
      nestedCandidate.candidate === undefined
    ) {
      throw new Error("nested prompt candidate fixture has no admitted candidate profile");
    }
    expect(nestedCandidate.candidate.candidateDigest).toBe(rootCandidate.candidate.candidateDigest);
    expect(nestedCandidate.candidate.manifest.provenance).toBe("better.prompt-candidate.yaml");
    expect(
      createPublicEvaluationHeader(nestedAdmission, "nested-prompt-candidate-evaluation"),
    ).toBeDefined();
  });

  it("requires a candidate projection to overlay the declared comparison baseline", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project, "overlay-baseline.workflow.yaml");
    const directBaseline = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
    await writeFile(
      join(project, "baseline.workflow.yaml"),
      directBaseline.replace("Follow TASK.md exactly.", "Use a different baseline prompt."),
    );

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrowError(
      /comparison baseline|exact baseline|overlay/i,
    );
  });

  it("rejects a prompt candidate selected on the comparison baseline profile", async () => {
    const project = await evaluationProject();
    await configureCandidateProfile(project);
    const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
    await writeFile(
      join(project, "evaluation.yaml"),
      plan
        .replace(
          "- { id: baseline, adapter: flow-workflow-v1, workflow: baseline.workflow.yaml }",
          "- { id: baseline, adapter: flow-workflow-v1, candidate: better.prompt-candidate.yaml }",
        )
        .replace(
          "- { id: candidate, adapter: flow-workflow-v1, candidate: better.prompt-candidate.yaml }",
          "- { id: candidate, adapter: flow-workflow-v1, workflow: candidate.workflow.yaml }",
        ),
    );

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrowError(
      /comparison candidate profile|candidate source/i,
    );
  });

  it("rejects workflow model and budget drift from the declared controls", async () => {
    const modelDrift = await evaluationProject({ modelId: "other-model" });
    await expect(admitLocalEvaluationPlan(join(modelDrift, "evaluation.yaml"))).rejects.toThrow(
      /model.*controls/i,
    );

    const thinkingDrift = await evaluationProject();
    const highThinking = workflowSource("deterministic", 8).replace(
      "model: { provider: test, id: deterministic }",
      "model: { provider: test, id: deterministic, thinking: high }",
    );
    await writeFile(join(thinkingDrift, "baseline.workflow.yaml"), highThinking);
    await expect(admitLocalEvaluationPlan(join(thinkingDrift, "evaluation.yaml"))).rejects.toThrow(
      /model.*controls|thinking/i,
    );

    const budgetDrift = await evaluationProject({ maxNodeStarts: 9 });
    await expect(admitLocalEvaluationPlan(join(budgetDrift, "evaluation.yaml"))).rejects.toThrow(
      /budget.*controls/i,
    );
  });

  it("rejects path escapes, symbolic links, and mutable special entries", async () => {
    const escapedProject = await evaluationProject({ workflowPath: "../outside.workflow.yaml" });
    await expect(admitLocalEvaluationPlan(join(escapedProject, "evaluation.yaml"))).rejects.toThrow(
      /canonical portable relative path/i,
    );

    const linked = await evaluationProject();
    await symlink("README.md", join(linked, "fixtures/edit-readme", "ALIAS.md"));
    await expect(admitLocalEvaluationPlan(join(linked, "evaluation.yaml"))).rejects.toThrow(
      /symbolic link/i,
    );
  });

  it("rejects profiles without a controlled model and uncaptured capability or retry semantics", async () => {
    const noModel = await evaluationProject();
    const commandOnly = `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: command-only }
budget:
  maxNodeStarts: 8
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: prepare
    type: command
    command: { executable: /usr/bin/true, args: [] }
`;
    await writeFile(join(noModel, "baseline.workflow.yaml"), commandOnly);
    await expect(admitLocalEvaluationPlan(join(noModel, "evaluation.yaml"))).rejects.toThrow(
      /model-bearing|controlled model/i,
    );

    const capability = await evaluationProject();
    const capabilitySource = workflowSource("deterministic", 8).replace(
      "      tools: [read, edit]",
      "      tools: [read, edit]\n      skills: [review]",
    );
    await writeFile(join(capability, "baseline.workflow.yaml"), capabilitySource);
    await expect(admitLocalEvaluationPlan(join(capability, "evaluation.yaml"))).rejects.toThrow(
      /capabilit|skills/i,
    );

    const recovery = await evaluationProject();
    const recoverySource = workflowSource("deterministic", 8).replace(
      "      tools: [read, edit]",
      "      tools: [read, edit]\n      recovery: { mode: fresh, maxAttempts: 2 }",
    );
    await writeFile(join(recovery, "baseline.workflow.yaml"), recoverySource);
    await expect(admitLocalEvaluationPlan(join(recovery, "evaluation.yaml"))).rejects.toThrow(
      /recovery|retry/i,
    );
  });

  it("rejects fixture entries the workspace isolator cannot reproduce", async () => {
    const project = await evaluationProject();
    await mkdir(join(project, "fixtures/edit-readme", ".flow"));
    await writeFile(join(project, "fixtures/edit-readme", ".flow", "ambient"), "hidden\n");

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrow(
      /\.flow|isolation/i,
    );
  });

  it("accepts the exact instruction limit and rejects one byte above it", async () => {
    const project = await evaluationProject();
    const instructionPath = join(project, "fixtures/edit-readme", "TASK.md");
    await writeFile(instructionPath, "x".repeat(MAX_EVALUATION_INSTRUCTION_BYTES));

    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).resolves.toBeDefined();

    await writeFile(instructionPath, "x".repeat(MAX_EVALUATION_INSTRUCTION_BYTES + 1));
    await expect(admitLocalEvaluationPlan(join(project, "evaluation.yaml"))).rejects.toThrow(
      /instruction.*exceeds|limit/i,
    );
  });
});

async function evaluationProject(
  overrides: {
    readonly modelId?: string;
    readonly maxNodeStarts?: number;
    readonly workflowPath?: string;
  } = {},
): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), "flow-evaluation-admission-")));
  temporaryDirectories.push(project);
  await mkdir(join(project, "fixtures/edit-readme"), { recursive: true });
  await writeFile(join(project, "fixtures/edit-readme", "TASK.md"), "Create RESULT.md.\n");
  await writeFile(join(project, "fixtures/edit-readme", "README.md"), "# Fixture\n");
  const workflow = workflowSource(
    overrides.modelId ?? "deterministic",
    overrides.maxNodeStarts ?? 8,
  );
  await writeFile(join(project, "baseline.workflow.yaml"), workflow);
  await writeFile(
    join(project, "candidate.workflow.yaml"),
    workflow.replace("id: baseline", "id: candidate"),
  );
  await writeFile(join(project, "evaluation.yaml"), planSource(overrides.workflowPath));
  return project;
}

function workflowSource(modelId: string, maxNodeStarts: number): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: Workflow
metadata: { id: baseline }
budget:
  maxNodeStarts: ${maxNodeStarts}
  maxModelTokens: 10000
  maxCostUsd: 1
  maxExecutionMs: 300000
  maxArtifactBytes: 1048576
nodes:
  - id: implement
    type: agent
    agent:
      prompt: Follow TASK.md exactly.
      model: { provider: test, id: ${modelId} }
      tools: [read, edit]
  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }
      schema: { type: string, maxLength: 4096 }
`;
}

function routingWorkflowSource(): string {
  return workflowSource("deterministic", 8).replace(
    `  - id: publish
    type: result
    dependsOn: [implement]
    result:
      source: { nodeId: implement, field: agent.text }`,
    `  - id: private-review
    type: agent
    dependsOn: [implement]
    agent:
      prompt: Review the result.
      model: { provider: test, id: deterministic }
      tools: [read]
  - id: publish
    type: result
    dependsOn: [private-review]
    result:
      source: { nodeId: private-review, field: agent.text }`,
  );
}

function planSource(workflowPath = "baseline.workflow.yaml"): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: EvaluationPlan
metadata: { id: harness-comparison }
suite:
  id: foundation-suite
  version: 1.0.0
  tasks:
    - id: edit-readme
      partition: holdout
      fixture: fixtures/edit-readme
      instruction: TASK.md
      verifier:
        kind: filesystem-v1
        assertions:
          - { kind: exists, path: RESULT.md }
profiles:
  - { id: baseline, adapter: flow-workflow-v1, workflow: ${workflowPath} }
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
seeds: [11, 22]
order: paired-alternating-v1
comparison:
  baselineProfileId: baseline
  candidateProfileId: candidate
  minimumPairedTrials: 2
  confidenceLevel: 0.95
  minimumEffect: 0
  maxFalseCompletionRate: 0
  maxPolicyViolations: 0
  maxVerifiedSuccessRegression: 0
`;
}

function tuningEvidence(workflowDigest: string) {
  const planDigest = "a".repeat(64);
  const schedule = createEvaluationSchedule(
    planDigest,
    ["tuning-task"],
    ["baseline", "other"],
    [1],
  );
  let previousDigest: string | null = null;
  const records = schedule.map((item) => {
    const record = createEvaluationTrialRecord({
      schedule: item,
      planDigest,
      previousDigest,
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      environment: {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.19.0",
        flowVersion: "0.0.0-test",
        workspaceBackend: "reflink-copy-v1",
        workspaceSnapshotDigest: "9".repeat(64),
      },
      harness: { outcome: "completed", runId: "run", reason: null },
      verification: {
        outcome: "accepted",
        verifierDigest: "b".repeat(64),
        assertions: [{ kind: "exists", path: "RESULT.md", outcome: true }],
      },
      metrics: {
        costUsdMicros: 1,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        turns: 1,
        toolCalls: 0,
        toolErrors: 0,
        wallTimeMs: 1,
        activeTimeMs: 1,
        interventions: 0,
        policyViolations: 0,
        recoveryAttempts: 0,
        recoveryOutcome: "not_attempted",
      },
    });
    previousDigest = record.recordDigest;
    return record;
  });
  return createTuningEvidencePacket({
    evaluationId: "source-evaluation",
    planDigest,
    suite: { id: "adaptive-suite", version: "1.0.0" },
    tasks: [{ id: "tuning-task", partition: "tuning" }],
    profiles: [
      { id: "baseline", adapter: "flow-workflow-v1", workflowDigest },
      { id: "other", adapter: "flow-workflow-v1", workflowDigest: "c".repeat(64) },
    ],
    schedule,
    records,
  });
}

async function configureCandidateProfile(
  project: string,
  baselineProvenance = "baseline.workflow.yaml",
): Promise<void> {
  const baselineText = await readFile(join(project, "baseline.workflow.yaml"), "utf8");
  if (baselineProvenance !== "baseline.workflow.yaml") {
    await writeFile(join(project, baselineProvenance), baselineText);
  }
  const baselineDigest = calculateWorkflowDigest(compileWorkflowText(baselineText));
  const evidence = tuningEvidence(baselineDigest);
  const evidenceText = JSON.stringify(evidence);
  await writeFile(join(project, "tuning.json"), evidenceText);
  await writeFile(
    join(project, "better.prompt-candidate.yaml"),
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "PromptCandidate",
      metadata: { id: "better-instructions", version: "1.0.0" },
      scope: { kind: "workflow", workflowId: "baseline" },
      baseline: {
        workflow: baselineProvenance,
        sourceSha256: sha256(baselineText),
        workflowDigest: baselineDigest,
      },
      evidence: [
        {
          path: "tuning.json",
          sourceSha256: sha256(evidenceText),
          evidenceDigest: evidence.evidenceDigest,
          planDigest: evidence.evaluation.planDigest,
        },
      ],
      changes: {
        prompts: [
          {
            nodeId: "implement",
            expectedSha256: sha256("Follow TASK.md exactly."),
            value: "Read TASK.md, implement it carefully, and verify the result.",
          },
        ],
      },
    }),
  );
  const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
  await writeFile(
    join(project, "evaluation.yaml"),
    plan.replace("workflow: candidate.workflow.yaml", "candidate: better.prompt-candidate.yaml"),
  );
}

async function configureAgentSkillCandidateProfile(project: string) {
  const skillRoot = join(project, ".flow", "skills", "review");
  await mkdir(skillRoot, { recursive: true });
  const skillManifest = `---
name: review
description: Review the result against the task.
metadata:
  owner: synapti
allowed-tools: Read
---
# Review

Check correctness.
`;
  const resourceText = "Check the evidence.\n";
  await writeFile(join(skillRoot, "SKILL.md"), skillManifest);
  await writeFile(join(skillRoot, "reference.md"), resourceText);
  const workflowText = workflowSource("deterministic", 8).replace(
    "      tools: [read, edit]",
    "      tools: [read, edit]\n      skills: [review]",
  );
  const compiled = compileWorkflowText(workflowText);
  const workflowDigest = calculateWorkflowDigest(compiled);
  await writeFile(join(project, "baseline.workflow.yaml"), workflowText);
  const evidence = tuningEvidence(workflowDigest);
  const evidenceText = JSON.stringify(evidence);
  await writeFile(join(project, "tuning.json"), evidenceText);
  const snapshot = await snapshotSelectedAgentSkills(await discoverProjectAgentSkills(project), [
    "review",
  ]);
  const skill = snapshot.packages[0];
  if (skill === undefined) {
    throw new Error("Agent Skill evaluation fixture has no baseline package");
  }
  await writeFile(
    join(project, "better.agent-skill-candidate.yaml"),
    JSON.stringify({
      apiVersion: "flow.synapti.ai/v1alpha1",
      kind: "AgentSkillCandidate",
      metadata: { id: "better-review", version: "1.0.0" },
      scope: {
        kind: "workflow-agent-skill",
        workflowId: "baseline",
        skillName: "review",
      },
      baseline: {
        workflow: {
          path: "baseline.workflow.yaml",
          sourceSha256: sha256(workflowText),
          workflowDigest,
        },
        skill: { path: ".flow/skills/review", packageDigest: skill.digest },
      },
      evidence: [
        {
          path: "tuning.json",
          sourceSha256: sha256(evidenceText),
          evidenceDigest: evidence.evidenceDigest,
          planDigest: evidence.evaluation.planDigest,
        },
      ],
      changes: {
        resources: [
          {
            path: "reference.md",
            expectedSha256: sha256(resourceText),
            value: "Check correctness, security, and evidence.\n",
          },
        ],
      },
    }),
  );
  const plan = await readFile(join(project, "evaluation.yaml"), "utf8");
  await writeFile(
    join(project, "evaluation.yaml"),
    plan.replace(
      "workflow: candidate.workflow.yaml",
      "candidate: better.agent-skill-candidate.yaml",
    ),
  );
  return { workflowText, workflowDigest, baselineSkillDigest: skill.digest };
}

type MutablePublicHeader = DeepMutable<PublicEvaluationHeader>;
type MutableFlowProfile = Extract<
  MutablePublicHeader["profiles"][number],
  { adapter: "flow-workflow-v1" }
>;

type DeepMutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly []
    ? []
    : Value extends readonly [infer Item]
      ? [DeepMutable<Item>]
      : Value extends readonly (infer Item)[]
        ? DeepMutable<Item>[]
        : Value extends object
          ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
          : Value;

function requiredFlowProfile(header: MutablePublicHeader, id: string): MutableFlowProfile {
  const profile = header.profiles.find(
    (item): item is MutableFlowProfile => item.adapter === "flow-workflow-v1" && item.id === id,
  );
  if (profile === undefined) {
    throw new Error(`Agent Skill durable fixture has no ${id} Flow profile`);
  }
  return profile;
}

function requiredSkillCandidateIdentity(
  header: MutablePublicHeader,
): DeepMutable<AgentSkillCandidateIdentity> {
  const identity = requiredFlowProfile(header, "candidate").candidate?.identity;
  if (
    identity === undefined ||
    !("kind" in identity) ||
    identity.kind !== "agent-skill-candidate"
  ) {
    throw new Error("Agent Skill durable fixture has no skill candidate identity");
  }
  return identity;
}

function redigestSkillCandidateHeader(header: MutablePublicHeader): void {
  const candidateIdentity = requiredSkillCandidateIdentity(header);
  const { candidateDigest: _candidateDigest, ...identityContent } = candidateIdentity;
  candidateIdentity.candidateDigest = calculateAgentSkillCandidateIdentityDigest(identityContent);
  redigestEvaluationHeader(header);
}

function redigestEvaluationHeader(header: MutablePublicHeader): void {
  const profiles: EvaluationPlanIdentity["profiles"] = header.profiles.map((profile) => {
    if (profile.adapter !== "flow-workflow-v1") {
      throw new Error("Agent Skill durable fixture unexpectedly contains an external profile");
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
      ...(profile.capabilitySnapshotDigest === undefined
        ? {}
        : { capabilitySnapshotDigest: profile.capabilitySnapshotDigest }),
      ...(profile.capabilityPackageDigests === undefined
        ? {}
        : { capabilityPackageDigests: profile.capabilityPackageDigests }),
      ...(profile.candidate === undefined ? {} : { candidate: profile.candidate }),
    };
  });
  const planIdentity: EvaluationPlanIdentity = {
    version: 1,
    apiVersion: header.apiVersion,
    id: header.planId,
    suite: header.suite,
    profiles,
    controls: header.controls as EvaluationPlanIdentity["controls"],
    seeds: header.seeds,
    order: header.order,
    comparison: header.comparison,
  };
  header.planDigest = calculateEvaluationPlanDigest(planIdentity);
  header.schedule = [
    ...createEvaluationSchedule(
      header.planDigest,
      header.suite.tasks.map((task) => task.id),
      header.profiles.map((profile) => profile.id),
      header.seeds,
    ),
  ];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativePiIdentity() {
  return Object.freeze({
    version: 1 as const,
    adapter: "pi-native-v1" as const,
    adapterContractVersion: "1.0.0",
    protocol: Object.freeze({
      id: "flow-external-harness-jsonl-v1" as const,
      maxFrameBytes: 1_048_576,
      digest: "1".repeat(64),
    }),
    runtime: Object.freeze({
      id: "srt-process-v1" as const,
      package: "@anthropic-ai/sandbox-runtime",
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "2".repeat(64),
      platform: "linux" as const,
      containment: "linux-pid-namespace" as const,
    }),
    driver: Object.freeze({
      id: "native-pi-evaluation-v1" as const,
      artifactSha256: "3".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      node: Object.freeze({ version: "22.19.0", executableSha256: "3".repeat(64) }),
    }),
    harness: Object.freeze({
      package: "@earendil-works/pi-coding-agent" as const,
      version: "0.84.0",
      integrity:
        "sha512-oxEU7BT9xuVT6UKNwUNDzNP5dVGb+DZRGfaEyMyAab8dRlqTSxxyhSlMAxmYsu//YOeasj9E8n2+px1BzIai0g==",
      packageContentSha256: "4".repeat(64),
      config: "pi-evaluation-v1" as const,
      configDigest: "4".repeat(64),
    }),
    inference: Object.freeze({
      id: "flow-pi-inference-v1" as const,
      version: 1 as const,
      package: "@earendil-works/pi-ai" as const,
      packageVersion: "0.84.0",
      packageIntegrity: `sha512-${"B".repeat(86)}==`,
      packageContentSha256: "5".repeat(64),
    }),
  });
}

function nativeOmpIdentity() {
  return Object.freeze({
    version: 1 as const,
    adapter: "omp-native-v1" as const,
    adapterContractVersion: "1.0.0",
    protocol: Object.freeze({
      id: "flow-external-harness-jsonl-v1" as const,
      maxFrameBytes: 1_048_576 as const,
      digest: "1".repeat(64),
    }),
    runtime: Object.freeze({
      id: "srt-process-v1" as const,
      package: "@anthropic-ai/sandbox-runtime" as const,
      version: "0.0.70",
      packageContentSha256: "2".repeat(64),
      policyDigest: "2".repeat(64),
      platform: "linux" as const,
      containment: "linux-pid-namespace" as const,
    }),
    driver: Object.freeze({
      id: "native-omp-evaluation-v1" as const,
      artifactSha256: "3".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      bun: Object.freeze({ version: "1.3.14", executableSha256: "3".repeat(64) }),
    }),
    harness: Object.freeze({
      package: "@oh-my-pi/pi-coding-agent" as const,
      version: "17.2.12",
      integrity:
        "sha512-+q+W4fyNQQ7xAKiN0mmOisWDDtKO0R/ZctTSsKqR4ulN3K1zfQ9HwiTxtg7HJHn5fwCy+X3BmUG72FatNUN8IA==",
      packageContentSha256: "4".repeat(64),
      dependencyClosureSha256: "4".repeat(64),
      config: "omp-evaluation-v1" as const,
      configDigest: "4".repeat(64),
    }),
    inference: Object.freeze({
      id: "flow-omp-inference-v1" as const,
      version: 1 as const,
      package: "@oh-my-pi/pi-ai" as const,
      packageVersion: "17.2.12",
      packageContentSha256: "5".repeat(64),
    }),
  });
}
