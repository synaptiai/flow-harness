import { appendFile, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES } from "../../../src/domain/capability/presentation-packages.js";
import {
  assertPresentationPackageCatalog,
  createInstalledDiscoveredPresentationPackage,
  discoverProjectPresentationPackages,
  MAX_PRESENTATION_PACKAGES,
  PresentationPackageCatalogError,
  snapshotSelectedPresentationPackage,
} from "../../../src/infrastructure/fs/local-presentation-package-catalog.js";
import { discoverProjectCapabilityCatalogs } from "../../../src/infrastructure/fs/project-capability-catalog.js";

describe("local presentation package catalog", () => {
  it("discovers and snapshots one exact local package", async () => {
    const root = await project();
    await writePackage(root, "operations", "1.0.0");

    const catalog = await discoverProjectPresentationPackages(root);
    expect(catalog.packages.map((item) => `${item.name}@${item.version}`)).toEqual([
      "operations@1.0.0",
    ]);
    const snapshot = await snapshotSelectedPresentationPackage(catalog, {
      name: "operations",
      version: "1.0.0",
    });
    expect(snapshot.name).toBe("operations");
    expect(snapshot.provenance).toBe(".flow/presentations/operations");
  });

  it("rejects links, source drift, and version substitution", async () => {
    const root = await project();
    const external = await mkdtemp(join(tmpdir(), "flow-presentation-external-"));
    await mkdir(join(root, ".flow", "presentations"), { recursive: true });
    await symlink(external, join(root, ".flow", "presentations", "linked"));
    await expect(discoverProjectPresentationPackages(root)).rejects.toMatchObject({
      code: "unsafe_entry",
    });

    const clean = await project();
    await writePackage(clean, "operations", "1.0.0");
    const catalog = await discoverProjectPresentationPackages(clean);
    await writePackage(clean, "operations", "1.0.1");
    await expect(
      snapshotSelectedPresentationPackage(catalog, { name: "operations", version: "1.0.0" }),
    ).rejects.toMatchObject({ code: "source_changed" });
    await expect(
      snapshotSelectedPresentationPackage(catalog, { name: "operations", version: "2.0.0" }),
    ).rejects.toMatchObject({ code: "version_mismatch" });
  });

  it("does not inspect the local presentation tree during ordinary capability discovery", async () => {
    const root = await project();
    const external = await mkdtemp(join(tmpdir(), "flow-presentation-unselected-"));
    await mkdir(join(root, ".flow", "presentations"));
    await symlink(external, join(root, ".flow", "presentations", "PRIVATE_UNSELECTED"));

    const catalogs = await discoverProjectCapabilityCatalogs(root);

    expect(catalogs.presentations.packages).toEqual([]);
  });

  it("accepts the exact package count and rejects one additional package", async () => {
    const root = await project();
    await Promise.all(
      Array.from({ length: MAX_PRESENTATION_PACKAGES }, (_, index) =>
        writePackage(root, `operations-${String(index).padStart(2, "0")}`, "1.0.0"),
      ),
    );

    await expect(discoverProjectPresentationPackages(root)).resolves.toMatchObject({
      packages: { length: MAX_PRESENTATION_PACKAGES },
    });

    await writePackage(root, "operations-overflow", "1.0.0");
    await expect(discoverProjectPresentationPackages(root)).rejects.toMatchObject({
      code: "limit_exceeded",
    });
  });

  it("rejects a symbolic-link ancestor before reading a presentation manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow-presentation-linked-project-"));
    const redirected = join(root, "redirected-flow");
    await writePackageAtFlowRoot(redirected, "operations", "1.0.0");
    await symlink(redirected, join(root, ".flow"));

    await expect(discoverProjectPresentationPackages(root)).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects package-directory replacement after observing its identity", async () => {
    const root = await project();
    await writePackage(root, "operations", "1.0.0");
    let replaced = false;

    await expect(
      discoverProjectPresentationPackages(root, {
        afterPackageDirectoryObserved: async (directory) => {
          if (replaced) {
            return;
          }
          replaced = true;
          await rename(directory, `${directory}.original`);
          await writePackage(root, "operations", "1.0.1");
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("bounds the physical read when a manifest grows after its initial stat", async () => {
    const root = await project();
    await writePackage(root, "operations", "1.0.0");
    let changed = false;

    await expect(
      discoverProjectPresentationPackages(root, {
        afterManifestStat: async (path) => {
          if (changed) {
            return;
          }
          changed = true;
          await appendFile(path, `\n#${"P".repeat(MAX_PRESENTATION_PACKAGE_MANIFEST_BYTES)}`);
        },
      }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      message: "presentation package manifest exceeds its byte limit",
    });
  });

  it("rejects a symbolic-link manifest without reading its target", async () => {
    const root = await project();
    const external = join(
      await mkdtemp(join(tmpdir(), "flow-presentation-manifest-link-")),
      "PRIVATE.yaml",
    );
    await writeFile(external, packageSource("operations", "1.0.0"));
    const directory = join(root, ".flow", "presentations", "operations");
    await mkdir(directory, { recursive: true });
    await symlink(external, join(directory, "PRESENTATION.yaml"));

    await expect(discoverProjectPresentationPackages(root)).rejects.toMatchObject({
      code: "unsafe_entry",
    });
  });

  it("rejects a same-size manifest rewrite after observing the opened file", async () => {
    const root = await project();
    await writePackage(root, "operations", "1.0.0");
    let changed = false;

    await expect(
      discoverProjectPresentationPackages(root, {
        afterManifestStat: async (path) => {
          if (changed) {
            return;
          }
          changed = true;
          const replacement = packageSource("operations", "1.0.1");
          expect(Buffer.byteLength(replacement)).toBe(
            Buffer.byteLength(packageSource("operations", "1.0.0")),
          );
          await writeFile(path, replacement);
        },
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("preserves exact cancellation before reads", async () => {
    const root = await project();
    const controller = new AbortController();
    const reason = new Error("PRIVATE CANCEL");
    controller.abort(reason);
    await expect(
      discoverProjectPresentationPackages(root, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("stops after opened-file observation when cancellation wins before the physical read", async () => {
    const root = await project();
    await writePackage(root, "operations", "1.0.0");
    let ordinaryReadCalls = 0;
    await discoverProjectPresentationPackages(root, {
      beforeManifestRead: () => {
        ordinaryReadCalls += 1;
      },
    });
    expect(ordinaryReadCalls).toBe(1);

    const controller = new AbortController();
    const reason = new Error("PRIVATE CANCEL AFTER STAT");
    let cancelledReadCalls = 0;
    await expect(
      discoverProjectPresentationPackages(root, {
        signal: controller.signal,
        afterManifestStat: () => controller.abort(reason),
        beforeManifestRead: () => {
          cancelledReadCalls += 1;
        },
      }),
    ).rejects.toBe(reason);
    expect(cancelledReadCalls).toBe(0);
  });

  it("settles the manifest handle when cancellation wins immediately after open", async () => {
    const root = await project();
    await writePackage(root, "operations", "1.0.0");
    const controller = new AbortController();
    const reason = new Error("PRIVATE CANCEL AFTER OPEN");
    const phases: string[] = [];
    let reachedRead = false;

    await expect(
      discoverProjectPresentationPackages(root, {
        signal: controller.signal,
        afterManifestOpen: () => {
          phases.push("open");
          controller.abort(reason);
        },
        beforeManifestRead: () => {
          reachedRead = true;
        },
        afterManifestClose: () => {
          phases.push("close");
        },
      }),
    ).rejects.toBe(reason);
    expect(phases).toEqual(["open", "close"]);
    expect(reachedRead).toBe(false);
  });

  it("does not retain private filesystem values in the public error graph", async () => {
    const privateRoot = join(tmpdir(), "PRIVATE_PRESENTATION_PROJECT_DOES_NOT_EXIST");
    let caught: unknown;

    try {
      await discoverProjectPresentationPackages(privateRoot);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PresentationPackageCatalogError);
    expect(caught).toMatchObject({ code: "io", message: "resolve Flow project root" });
    expect(caught).not.toHaveProperty("cause");
    expect(String(caught)).not.toContain("PRIVATE_PRESENTATION_PROJECT_DOES_NOT_EXIST");
  });

  it("creates installed entries and rejects local/installed name collisions", async () => {
    const root = await project();
    const source = Buffer.from(packageSource("operations", "1.0.0"));
    const installed = createInstalledDiscoveredPresentationPackage({
      projectRoot: root,
      bundleDigest: "a".repeat(64),
      package: {
        kind: "presentation-package",
        name: "operations",
        version: "1.0.0",
        manifestBase64: source.toString("base64"),
      },
    });
    expect(installed.provenance).toContain("sha256");
    expect(() => assertPresentationPackageCatalog([installed, installed])).toThrow(
      PresentationPackageCatalogError,
    );
  });
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-presentation-catalog-"));
  await mkdir(join(root, ".flow"));
  return root;
}

async function writePackage(root: string, name: string, version: string): Promise<void> {
  await writePackageAtFlowRoot(join(root, ".flow"), name, version);
}

async function writePackageAtFlowRoot(
  flowRoot: string,
  name: string,
  version: string,
): Promise<void> {
  const directory = join(flowRoot, "presentations", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "PRESENTATION.yaml"), packageSource(name, version));
}

function packageSource(name: string, version: string): string {
  return `apiVersion: flow.synapti.ai/v1alpha1
kind: PresentationPackage
metadata:
  name: ${name}
  version: ${version}
  description: Operator layout
spec:
  messages:
    - version: v0.9
      createSurface:
        surfaceId: flow-run
        catalogId: https://flow.synapti.ai/a2ui/catalogs/run-presentation/v1
    - version: v0.9
      updateComponents:
        surfaceId: flow-run
        components:
          - id: root
            component: FlowLayout
            density: compact
            children: [group-1]
          - id: group-1
            component: FlowGroup
            variant: stack
            children: [run-summary, graph-progress, node-table, resource-facts, pending-approvals, outcome-notice]
          - id: run-summary
            component: FlowRunSummary
          - id: graph-progress
            component: FlowGraphProgress
          - id: node-table
            component: FlowNodeTable
          - id: resource-facts
            component: FlowResourceFacts
          - id: pending-approvals
            component: FlowPendingApprovals
          - id: outcome-notice
            component: FlowOutcomeNotice
`;
}
