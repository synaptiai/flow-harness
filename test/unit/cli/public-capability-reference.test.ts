import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPublicCapabilityReferenceCli } from "../../../src/cli/public-capability-reference.js";
import { PublicCapabilityCatalogValidationError } from "../../../src/domain/capability/public-capability-reference.js";
import { PUBLIC_CAPABILITY_REFERENCE_PATHS } from "../../../src/infrastructure/fs/public-capability-reference-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("public capability reference CLI", () => {
  it("writes and then verifies the production reference", async () => {
    const root = await temporaryRoot();
    const output: string[] = [];

    expect(await runPublicCapabilityReferenceCli(["--write"], options(root, output))).toBe(0);
    expect(await runPublicCapabilityReferenceCli(["--check"], options(root, output))).toBe(0);
    const catalog = JSON.parse(
      await readFile(join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.json), "utf8"),
    );
    expect(catalog).toMatchObject({ version: "flow.public-capabilities/v1" });
    expect(catalog.limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "proof-specification-bytes", value: 65_536 }),
        expect.objectContaining({ id: "proof-statement-bytes", value: 131_072 }),
        expect.objectContaining({ id: "proof-term-bytes", value: 262_144 }),
        expect.objectContaining({ id: "proof-qualification-input-bytes", value: 1_048_576 }),
      ]),
    );
    expect(catalog.executionSeams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "lean-proof-verifier",
          implementation: "lean-proof-oci-v1",
        }),
      ]),
    );
    expect(output).toEqual([
      "Generated the public capability reference.\n",
      "The public capability reference is current.\n",
    ]);
  });

  it("returns a failure with regeneration guidance for stale output", async () => {
    const root = await temporaryRoot();
    const errors: string[] = [];
    await runPublicCapabilityReferenceCli(["--write"], options(root));
    await writeFile(join(root, PUBLIC_CAPABILITY_REFERENCE_PATHS.json), "{}\n", "utf8");

    expect(await runPublicCapabilityReferenceCli(["--check"], options(root, [], errors))).toBe(1);
    expect(errors.join("")).toMatch(
      /public capability reference is stale.*docs:capabilities:generate/u,
    );
  });

  it("returns usage status for an unsupported mode", async () => {
    const errors: string[] = [];

    expect(
      await runPublicCapabilityReferenceCli(
        ["--unknown"],
        options(await temporaryRoot(), [], errors),
      ),
    ).toBe(2);
    expect(errors).toEqual(["Usage: public-capability-reference (--check | --write)\n"]);
  });

  it("contains filesystem failures without exposing the host path", async () => {
    const root = await temporaryRoot();
    const missingRoot = join(root, "private-host-path");
    const errors: string[] = [];

    expect(
      await runPublicCapabilityReferenceCli(["--check"], options(missingRoot, [], errors)),
    ).toBe(1);
    expect(errors.join("")).toMatch(/file operation failed/u);
    expect(errors.join("")).not.toContain(missingRoot);
  });

  it("contains catalog failures without echoing rejected descriptor values", async () => {
    const secret = "descriptor-secret-value";
    const errors: string[] = [];

    expect(
      await runPublicCapabilityReferenceCli(["--check"], {
        ...options(await temporaryRoot(), [], errors),
        createCatalog: () => {
          throw new TypeError(`unsupported value ${secret}`);
        },
      }),
    ).toBe(1);
    expect(errors).toEqual(["public capability reference is invalid\n"]);
    expect(errors.join("")).not.toContain(secret);
  });

  it("identifies the safe catalog location for a controlled validation failure", async () => {
    const secret = "descriptor-secret-value";
    const errors: string[] = [];

    expect(
      await runPublicCapabilityReferenceCli(["--check"], {
        ...options(await temporaryRoot(), [], errors),
        createCatalog: () => {
          throw new PublicCapabilityCatalogValidationError(
            "tools[2]",
            new TypeError(`unsupported value ${secret}`),
          );
        },
      }),
    ).toBe(1);
    expect(errors).toEqual(["invalid_public_capability_catalog at tools[2]\n"]);
    expect(errors.join("")).not.toContain(secret);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flow-public-reference-cli-"));
  temporaryDirectories.push(root);
  return root;
}

function options(root: string, output: string[] = [], errors: string[] = []) {
  return {
    cwd: root,
    stdout: (value: string) => output.push(value),
    stderr: (value: string) => errors.push(value),
  };
}
