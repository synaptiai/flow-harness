import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectEffectiveHarnessCandidate } from "../../../../src/application/prepare-effective-harness-candidate.js";
import {
  createEffectiveHarnessCandidateArtifact,
  encodeEffectiveHarnessCandidateArtifact,
} from "../../../../src/domain/adaptation/effective-harness-candidate.js";
import {
  createEffectiveHarnessHeadIdentity,
  createEffectiveHarnessState,
} from "../../../../src/domain/adaptation/effective-harness-state.js";
import { admitLocalEffectiveHarnessCandidate } from "../../../../src/infrastructure/fs/local-effective-harness-candidate.js";
import { agentSkillPackageActivationFixture } from "../../../fixtures/agent-skill-package-activation.js";

const temporaryDirectories: string[] = [];
const scopeDigest = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local effective harness candidate admission", () => {
  it("reopens one exact artifact without live source dependencies", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "candidate.effective-harness.json");
    const artifact = candidateArtifact();
    await writeFile(path, encodeEffectiveHarnessCandidateArtifact(artifact));

    const admitted = await admitLocalEffectiveHarnessCandidate(path);
    await rm(path);

    expect(admitted.artifact).toEqual(artifact);
    expect(admitted.provenance).toBe("candidate.effective-harness.json");
    expect(admitted.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects links and preserves exact cancellation after the stable read", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "target.json");
    const link = join(root, "candidate.json");
    await writeFile(target, encodeEffectiveHarnessCandidateArtifact(candidateArtifact()));
    await symlink(target, link);

    await expect(admitLocalEffectiveHarnessCandidate(link)).rejects.toMatchObject({
      code: "invalid_path",
    });

    const reason = new Error("cancel after candidate read");
    const controller = new AbortController();
    await expect(
      admitLocalEffectiveHarnessCandidate(target, {
        signal: controller.signal,
        afterRead: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it("preserves exact cancellation after the candidate handle is closed", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "candidate.json");
    const reason = new Error("cancel after candidate close");
    const controller = new AbortController();
    await writeFile(path, encodeEffectiveHarnessCandidateArtifact(candidateArtifact()));

    await expect(
      admitLocalEffectiveHarnessCandidate(path, {
        signal: controller.signal,
        afterClose: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it("rejects an ancestor link and a leaf replacement after the stable read", async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    const nested = join(external, "nested");
    await mkdir(nested);
    const externalCandidate = join(nested, "candidate.json");
    await writeFile(
      externalCandidate,
      encodeEffectiveHarnessCandidateArtifact(candidateArtifact()),
    );
    await symlink(external, join(root, "alias"), "dir");

    await expect(
      admitLocalEffectiveHarnessCandidate(join(root, "alias", "nested", "candidate.json")),
    ).rejects.toMatchObject({ code: "invalid_path" });

    const directCandidate = join(root, "candidate.json");
    const movedCandidate = join(root, "candidate.original.json");
    await writeFile(directCandidate, encodeEffectiveHarnessCandidateArtifact(candidateArtifact()));
    await expect(
      admitLocalEffectiveHarnessCandidate(directCandidate, {
        afterRead: async () => {
          await rename(directCandidate, movedCandidate);
          await writeFile(
            directCandidate,
            encodeEffectiveHarnessCandidateArtifact(candidateArtifact()),
          );
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
});

function candidateArtifact() {
  const fixture = agentSkillPackageActivationFixture();
  const baseline = createEffectiveHarnessState({
    scopeDigest,
    workflowSource: fixture.prompt.baselineText,
    packages: [],
  });
  const projected = projectEffectiveHarnessCandidate({
    baseline,
    candidate: {
      kind: "agent-skill-package",
      projection: fixture.projected,
      baselineWorkflowSource: fixture.prompt.baselineText,
    },
  });
  return createEffectiveHarnessCandidateArtifact({
    baselineHead: createEffectiveHarnessHeadIdentity({
      scopeDigest,
      workflowId: baseline.workflowId,
      generation: 1,
      activationDigest: "b".repeat(64),
      transitionDigest: "c".repeat(64),
      stateDigest: baseline.stateDigest,
    }),
    baselineState: baseline,
    candidateState: projected.state,
    candidate: fixture.projected.identity,
  });
}

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "flow-effective-candidate-")));
  temporaryDirectories.push(path);
  return path;
}
