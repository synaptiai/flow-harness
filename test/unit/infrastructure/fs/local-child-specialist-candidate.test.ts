import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_CHILD_SPECIALIST_CANDIDATE_BYTES } from "../../../../src/domain/adaptation/child-specialist-candidate.js";
import { admitLocalChildSpecialistCandidate } from "../../../../src/infrastructure/fs/local-child-specialist-candidate.js";
import { childSpecialistCandidateFixture } from "../../../fixtures/child-specialist-candidate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local child-specialist candidate admission", () => {
  it("reopens one candidate and baseline as stable bounded files", async () => {
    const fixture = childSpecialistCandidateFixture("instructions");
    const root = await realpath(await mkdtemp(join(tmpdir(), "flow-child-specialist-")));
    roots.push(root);
    const candidatePath = join(root, "specialist.candidate.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(join(root, "baseline.workflow.yaml"), fixture.baselineText);

    const admitted = await admitLocalChildSpecialistCandidate(candidatePath, {
      packages: fixture.packages,
    });

    expect(admitted).toMatchObject({
      provenance: "specialist.candidate.yaml",
      sourceSha256: fixture.projected.identity.manifest.sourceSha256,
      identity: fixture.projected.identity,
      baseline: {
        provenance: "baseline.workflow.yaml",
        sourceSha256: fixture.projected.identity.baseline.workflow.sourceSha256,
      },
      workflow: {
        sourceSha256: fixture.projected.identity.projectedWorkflow.sourceSha256,
        workflowDigest: fixture.projected.identity.projectedWorkflow.workflowDigest,
      },
    });
    expect(Object.isFrozen(admitted)).toBe(true);
  });

  it("rejects a linked baseline without exposing its path", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const external = join(root, "PRIVATE_EXTERNAL_WORKFLOW");
    await writeFile(external, fixture.baselineText);
    await writeFile(join(root, "specialist.candidate.yaml"), fixture.sourceText);
    await symlink(external, join(root, "baseline.workflow.yaml"));

    const error = await admitLocalChildSpecialistCandidate(
      join(root, "specialist.candidate.yaml"),
      { packages: fixture.packages },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_path" });
    expect((error as Error).message).not.toContain("PRIVATE_EXTERNAL_WORKFLOW");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects a symbolic link in the candidate ancestor chain before source admission", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const realDirectory = join(root, "real-candidate-directory");
    await writeFile(join(root, "placeholder"), "x");
    await mkdir(realDirectory);
    await writeFile(join(realDirectory, "specialist.candidate.yaml"), fixture.sourceText);
    await writeFile(join(realDirectory, "baseline.workflow.yaml"), fixture.baselineText);
    await symlink(realDirectory, join(root, "PRIVATE_CANDIDATE_ALIAS"));

    const error = await admitLocalChildSpecialistCandidate(
      join(root, "PRIVATE_CANDIDATE_ALIAS", "specialist.candidate.yaml"),
      { packages: fixture.packages },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_path" });
    expect((error as Error).message).not.toContain("PRIVATE_CANDIDATE_ALIAS");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects a symbolic link above an ordinary candidate parent", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const realAncestor = join(root, "real-ancestor");
    const realDirectory = join(realAncestor, "ordinary-parent");
    await mkdir(realDirectory, { recursive: true });
    await writeFile(join(realDirectory, "specialist.candidate.yaml"), fixture.sourceText);
    await writeFile(join(realDirectory, "baseline.workflow.yaml"), fixture.baselineText);
    await symlink(realAncestor, join(root, "PRIVATE_INTERMEDIATE_ALIAS"));

    const error = await admitLocalChildSpecialistCandidate(
      join(root, "PRIVATE_INTERMEDIATE_ALIAS", "ordinary-parent", "specialist.candidate.yaml"),
      { packages: fixture.packages },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_path" });
    expect((error as Error).message).not.toContain("PRIVATE_INTERMEDIATE_ALIAS");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects a candidate directory replacement after stable reads", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidateDirectory = join(root, "candidate-root");
    const movedDirectory = join(root, "PRIVATE_MOVED_CANDIDATE_ROOT");
    await mkdir(candidateDirectory);
    const candidatePath = join(candidateDirectory, "specialist.candidate.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(join(candidateDirectory, "baseline.workflow.yaml"), fixture.baselineText);

    const error = await admitLocalChildSpecialistCandidate(candidatePath, {
      packages: fixture.packages,
      beforeReturn: async () => {
        await rename(candidateDirectory, movedDirectory);
        await symlink(movedDirectory, candidateDirectory);
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "source_changed" });
    expect((error as Error).message).not.toContain("PRIVATE_MOVED_CANDIDATE_ROOT");
    expect((error as Error).cause).toBeUndefined();
  });

  it("accepts exact candidate and baseline byte limits and rejects one more byte", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidatePath = join(root, "specialist.candidate.yaml");
    const baselinePath = join(root, "baseline.workflow.yaml");
    const exactCandidate = `${fixture.sourceText}${" ".repeat(
      MAX_CHILD_SPECIALIST_CANDIDATE_BYTES - Buffer.byteLength(fixture.sourceText),
    )}`;
    const exactBaseline = `${fixture.baselineText}${" ".repeat(
      1_048_576 - Buffer.byteLength(fixture.baselineText),
    )}`;
    const candidateDocument = JSON.parse(fixture.sourceText) as {
      baseline: { workflow: { sourceSha256: string } };
    };
    candidateDocument.baseline.workflow.sourceSha256 = sha256(exactBaseline);

    await writeFile(candidatePath, exactCandidate);
    await writeFile(baselinePath, fixture.baselineText);
    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, { packages: fixture.packages }),
    ).resolves.toMatchObject({
      sourceText: exactCandidate,
      identity: { scope: fixture.projected.identity.scope },
    });
    await writeFile(candidatePath, `${exactCandidate} `);
    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, { packages: fixture.packages }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });

    await writeFile(candidatePath, JSON.stringify(candidateDocument));
    await writeFile(baselinePath, exactBaseline);
    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, { packages: fixture.packages }),
    ).resolves.toMatchObject({
      baseline: { sourceSha256: sha256(exactBaseline) },
    });
    await writeFile(baselinePath, `${exactBaseline} `);
    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, { packages: fixture.packages }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  }, 15_000);

  it("rejects a baseline that changes after its bounded read", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidatePath = join(root, "specialist.candidate.yaml");
    const baselinePath = join(root, "baseline.workflow.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(baselinePath, fixture.baselineText);

    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, {
        packages: fixture.packages,
        afterBaselineRead: () => writeFile(baselinePath, `${fixture.baselineText} `),
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("preserves exact cancellation after baseline settlement", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidatePath = join(root, "specialist.candidate.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(join(root, "baseline.workflow.yaml"), fixture.baselineText);
    const controller = new AbortController();
    const reason = new Error("PRIVATE_CALLER_CANCELLATION");

    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, {
        packages: fixture.packages,
        signal: controller.signal,
        afterBaselineRead: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it("preserves exact cancellation while the package closure resolver settles", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidatePath = join(root, "specialist.candidate.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(join(root, "baseline.workflow.yaml"), fixture.baselineText);
    const controller = new AbortController();
    const reason = new Error("PRIVATE_PACKAGE_RESOLUTION_CANCELLATION");

    await expect(
      admitLocalChildSpecialistCandidate(candidatePath, {
        signal: controller.signal,
        resolvePackages: async () => {
          controller.abort(reason);
          return fixture.packages;
        },
      }),
    ).rejects.toBe(reason);
  });

  it("maps a private package resolver failure to one value-free stage", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidatePath = join(root, "specialist.candidate.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(join(root, "baseline.workflow.yaml"), fixture.baselineText);

    const error = await admitLocalChildSpecialistCandidate(candidatePath, {
      resolvePackages: async () => {
        throw new Error("PRIVATE_PACKAGE_CATALOG_FAILURE");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_source" });
    expect((error as Error).message).not.toContain("PRIVATE_PACKAGE_CATALOG_FAILURE");
    expect((error as Error).cause).toBeUndefined();
  });

  it("maps invalid private baseline content to one value-free stage", async () => {
    const fixture = childSpecialistCandidateFixture();
    const root = await testRoot();
    const candidatePath = join(root, "specialist.candidate.yaml");
    await writeFile(candidatePath, fixture.sourceText);
    await writeFile(join(root, "baseline.workflow.yaml"), "PRIVATE_INVALID_WORKFLOW");

    const error = await admitLocalChildSpecialistCandidate(candidatePath, {
      packages: fixture.packages,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_source" });
    expect((error as Error).message).not.toContain("PRIVATE_INVALID_WORKFLOW");
    expect((error as Error).cause).toBeUndefined();
  });
});

async function testRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flow-child-specialist-")));
  roots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
