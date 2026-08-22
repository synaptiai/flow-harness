import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { renderPublicCapabilityReference } from "../../../src/application/public-capability-reference.js";
import {
  definePublicCapabilityCatalog,
  type PublicCapabilityCatalogInput,
} from "../../../src/domain/capability/public-capability-reference.js";
import {
  PUBLIC_CAPABILITY_REFERENCE_PATHS,
  type PublicCapabilityReferenceDriftError,
  verifyPublicCapabilityReferenceFiles,
  writePublicCapabilityReferenceFiles,
} from "../../../src/infrastructure/fs/public-capability-reference-files.js";
import { createProductionPublicCapabilityCatalog } from "../../../src/infrastructure/runtime/production-public-capability-reference.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("production public capability reference", () => {
  it("publishes input schemas that compile under the declared JSON Schema dialect", () => {
    const catalog = createProductionPublicCapabilityCatalog();
    const ajv = new Ajv2020({ allErrors: true, strict: true });

    for (const tool of catalog.tools) {
      expect(
        () => ajv.compile({ $schema: catalog.jsonSchemaDialect, ...tool.inputSchema }),
        tool.name,
      ).not.toThrow();
    }
  });

  it.each([
    ["tool", changeFirstTool],
    ["schema", changeFirstSchema],
    ["limit", changeFirstLimit],
    ["capability family", changeFirstFamily],
    ["provider seam", changeFirstSeam],
    ["evaluation adapter", changeFirstAdapter],
  ] as const)("rejects stale artifacts after a production %s change", async (_label, change) => {
    const root = await mkdtemp(join(tmpdir(), "flow-production-reference-"));
    temporaryDirectories.push(root);
    const current = createProductionPublicCapabilityCatalog();
    await writePublicCapabilityReferenceFiles(root, renderPublicCapabilityReference(current));

    await expect(
      verifyPublicCapabilityReferenceFiles(
        root,
        renderPublicCapabilityReference(definePublicCapabilityCatalog(change(current))),
      ),
    ).rejects.toMatchObject({
      name: "PublicCapabilityReferenceDriftError",
      stalePaths: [
        PUBLIC_CAPABILITY_REFERENCE_PATHS.json,
        PUBLIC_CAPABILITY_REFERENCE_PATHS.markdown,
      ],
    } satisfies Partial<PublicCapabilityReferenceDriftError>);
  });
});

function changeFirstTool(catalog: PublicCapabilityCatalogInput): PublicCapabilityCatalogInput {
  return {
    ...catalog,
    tools: catalog.tools.map((tool, index) =>
      index === 0 ? { ...tool, name: `${tool.name}_changed` } : tool,
    ),
  };
}

function changeFirstSchema(catalog: PublicCapabilityCatalogInput): PublicCapabilityCatalogInput {
  return {
    ...catalog,
    tools: catalog.tools.map((tool, index) =>
      index === 0
        ? { ...tool, inputSchema: { ...tool.inputSchema, title: "Changed schema" } }
        : tool,
    ),
  };
}

function changeFirstLimit(catalog: PublicCapabilityCatalogInput): PublicCapabilityCatalogInput {
  return {
    ...catalog,
    limits: catalog.limits.map((limit, index) =>
      index === 0 ? { ...limit, value: limit.value + 1 } : limit,
    ),
  };
}

function changeFirstFamily(catalog: PublicCapabilityCatalogInput): PublicCapabilityCatalogInput {
  return {
    ...catalog,
    capabilityFamilies: catalog.capabilityFamilies.map((family, index) =>
      index === 0 ? { ...family, summary: `${family.summary} Changed.` } : family,
    ),
  };
}

function changeFirstSeam(catalog: PublicCapabilityCatalogInput): PublicCapabilityCatalogInput {
  return {
    ...catalog,
    executionSeams: catalog.executionSeams.map((seam, index) =>
      index === 0 ? { ...seam, implementation: `${seam.implementation}-changed` } : seam,
    ),
  };
}

function changeFirstAdapter(catalog: PublicCapabilityCatalogInput): PublicCapabilityCatalogInput {
  return {
    ...catalog,
    evaluationAdapters: catalog.evaluationAdapters.map((adapter, index) =>
      index === 0 ? { ...adapter, summary: `${adapter.summary} Changed.` } : adapter,
    ),
  };
}
