import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { appendFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  inspectPrimeImageArchive,
  PrimeImageArchiveInspectionError,
  PrimeImagePackageMetadataBudget,
} from "../../../../src/infrastructure/oci/prime-image-archive.js";
import {
  createTarArchive,
  createTarEntryPrefix,
  createDockerImageArchive as dockerArchive,
  createDockerLayerTar as layerTar,
  writeDockerArchiveFixture as writeArchive,
} from "../../../fixtures/prime/docker-image-archive.js";
import { nodePackageIdentityCases } from "../../../fixtures/prime/node-package-identity-cases.js";
import { invalidUtf8PythonPackageMetadata } from "../../../fixtures/prime/package-metadata-cases.js";

describe("Prime image archive", () => {
  it("creates an external package inventory from ordered image layers", async () => {
    const sbom = {
      node: [{ name: "selected-package", version: "1.2.3" }],
      python: [{ name: "selected-python", version: "4.5.6" }],
    };
    const archive = dockerArchive([
      layerTar(
        {
          "opt/flow/node/node_modules/selected/package.json": JSON.stringify({
            name: "selected-package",
            version: "1.2.3",
          }),
          "opt/flow/node/node_modules/removed/package.json": JSON.stringify({
            name: "removed-package",
            version: "9.9.9",
          }),
        },
        ["opt", "opt/flow", "opt/flow/node"],
      ),
      layerTar({
        "opt/flow/node/node_modules/removed/.wh.package.json": "",
        "opt/flow/python/lib/python3.11/site-packages/selected_python-4.5.6.dist-info/METADATA":
          "Name: selected-python\nVersion: 4.5.6\n",
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    const inspected = await inspectPrimeImageArchive({
      archivePath,
      imageId: archive.imageId,
    });

    expect(inspected.sbom).toEqual(sbom);
    expect(inspected.sbomSha256).toBe(sha256(canonicalize(sbom)));
    expect(inspected.layerSha256).toHaveLength(2);
  });

  it("applies current-layer package metadata after lower-layer whiteouts", async () => {
    const replacement = JSON.stringify({ name: "replacement-package", version: "2.0.0" });
    const archive = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/replaced/package.json": JSON.stringify({
          name: "lower-package",
          version: "1.0.0",
        }),
      }),
      layerTar({
        "opt/flow/node/node_modules/replaced/package.json": replacement,
        "opt/flow/node/node_modules/replaced/.wh.package.json": "",
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).resolves.toMatchObject({
      sbom: { node: [{ name: "replacement-package", version: "2.0.0" }] },
    });
  });

  it("checks each retained metadata path once for a layer with many whiteouts", async () => {
    const archive = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/first/package.json": JSON.stringify({
          name: "first",
          version: "1.0.0",
        }),
        "opt/flow/node/node_modules/second/package.json": JSON.stringify({
          name: "second",
          version: "1.0.0",
        }),
        "opt/flow/node/node_modules/third/package.json": JSON.stringify({
          name: "third",
          version: "1.0.0",
        }),
      }),
      layerTar({
        "opt/flow/node/node_modules/.wh.unmatched-first": "",
        "opt/flow/node/node_modules/.wh.unmatched-second": "",
        "opt/flow/node/node_modules/.wh.unmatched-third": "",
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);
    let observedMetadataPaths = 0;

    await inspectPrimeImageArchive(
      { archivePath, imageId: archive.imageId },
      {
        observeWhiteoutMetadataPath: () => {
          observedMetadataPaths += 1;
        },
      },
    );

    expect(observedMetadataPaths).toBe(3);
  });

  it.each(["whiteout", "replacement"] as const)(
    "defers invalid lower-layer package metadata until a final %s",
    async (settlement) => {
      const path = "opt/flow/node/node_modules/settled/package.json";
      const archive = dockerArchive([
        layerTar({ [path]: "{" }),
        settlement === "whiteout"
          ? layerTar({ "opt/flow/node/node_modules/settled/.wh.package.json": "" })
          : layerTar({
              [path]: JSON.stringify({ name: "settled", version: "1.0.0" }),
            }),
      ]);
      const archivePath = await writeArchive(archive.bytes);

      await expect(
        inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
      ).resolves.toMatchObject({
        sbom: {
          node: settlement === "whiteout" ? [] : [{ name: "settled", version: "1.0.0" }],
          python: [],
        },
      });
    },
  );

  it.each(["regular-last", "directory-last"] as const)(
    "uses the final %s tar header for a package metadata path",
    async (order) => {
      const path = "opt/flow/node/node_modules/header-order/package.json";
      const regular = {
        content: Buffer.from(JSON.stringify({ name: "header-order", version: "1.0.0" })),
        path,
        type: "0",
      };
      const directory = { content: Buffer.alloc(0), path, type: "5" };
      const layer = Buffer.concat([
        createTarEntryPrefix(
          order === "regular-last" ? [directory, regular] : [regular, directory],
        ),
        Buffer.alloc(1_024),
      ]);
      const archive = dockerArchive([layer]);
      const archivePath = await writeArchive(archive.bytes);
      const inspection = inspectPrimeImageArchive({ archivePath, imageId: archive.imageId });

      if (order === "regular-last") {
        await expect(inspection).resolves.toMatchObject({
          sbom: { node: [{ name: "header-order", version: "1.0.0" }], python: [] },
        });
      } else {
        await expect(inspection).rejects.toMatchObject({
          stage: "inventory image archive packages",
        });
      }
    },
  );

  it("rejects a final hard-linked package metadata path before SBOM publication", async () => {
    const path = "opt/flow/node/node_modules/hard-linked/package.json";
    const hardLinkLayer = Buffer.concat([
      createTarEntryPrefix([{ content: Buffer.alloc(0), path, type: "1" }]),
      Buffer.alloc(1_024),
    ]);
    const archive = dockerArchive([
      layerTar({
        [path]: JSON.stringify({ name: "lower", version: "1.0.0" }),
      }),
      hardLinkLayer,
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage: "inventory image archive packages" });
  });

  it("applies a root opaque whiteout to all lower-layer package metadata", async () => {
    const archive = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/lower/package.json": JSON.stringify({
          name: "lower-package",
          version: "1.0.0",
        }),
      }),
      layerTar({
        ".wh..wh..opq": "",
        "opt/flow/node/node_modules/current/package.json": JSON.stringify({
          name: "current-package",
          version: "2.0.0",
        }),
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).resolves.toMatchObject({
      sbom: { node: [{ name: "current-package", version: "2.0.0" }] },
    });
  });

  it.each([
    [
      "nonempty regular file",
      layerTar({ "opt/flow/node/node_modules/lower/.wh.package.json": "not empty" }),
    ],
    ["directory", layerTar({}, ["opt/flow/node/node_modules/lower/.wh.package.json"])],
    ["empty target", layerTar({ ".wh.": "" })],
    [
      "symbolic link",
      Buffer.concat([
        createTarEntryPrefix([
          {
            content: Buffer.alloc(0),
            path: "opt/flow/node/node_modules/lower/.wh.package.json",
            type: "2",
          },
        ]),
        Buffer.alloc(1_024),
      ]),
    ],
  ] as const)("rejects a malformed %s whiteout", async (_label, malformedLayer) => {
    const archive = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/lower/package.json": JSON.stringify({
          name: "lower-package",
          version: "1.0.0",
        }),
      }),
      malformedLayer,
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({
      stage: "scan image archive layers",
      cause: expect.objectContaining({ message: "Prime image layer has an invalid whiteout" }),
    });
  });

  it("admits only the canonical tar root directory marker", async () => {
    const archive = dockerArchive([layerTar({}, ["."])]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).resolves.toMatchObject({ layerSha256: [expect.stringMatching(/^[a-f0-9]{64}$/)] });

    const regularRoot = dockerArchive([layerTar({ "./": "not a directory marker" })]);
    const regularRootPath = await writeArchive(regularRoot.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath: regularRootPath, imageId: regularRoot.imageId }),
    ).rejects.toMatchObject({
      stage: "scan image archive layers",
      cause: expect.objectContaining({ message: "Prime image tar path violates its Linux bounds" }),
    });
  });

  it("counts every physical tar header and admits at most one root marker", async () => {
    const archive = dockerArchive([layerTar({})]);
    const root = { content: Buffer.alloc(0), path: "./", type: "5" } as const;
    const fillers = Array.from({ length: 2_044 }, (_, index) => ({
      content: Buffer.alloc(0),
      path: `unused-${index}`,
    }));
    const exactPath = await writeArchive(
      Buffer.concat([createTarEntryPrefix([root, ...fillers]), archive.bytes]),
    );

    await expect(
      inspectPrimeImageArchive({ archivePath: exactPath, imageId: archive.imageId }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const overPath = await writeArchive(
      Buffer.concat([
        createTarEntryPrefix([root, ...fillers, { content: Buffer.alloc(0), path: "one-over" }]),
        archive.bytes,
      ]),
    );
    await expect(
      inspectPrimeImageArchive({ archivePath: overPath, imageId: archive.imageId }),
    ).rejects.toMatchObject({
      stage: "read image archive manifest",
      cause: expect.objectContaining({ message: "Prime image tar exceeds its entry limit" }),
    });

    const duplicateRootPath = await writeArchive(
      Buffer.concat([createTarEntryPrefix([root, root]), archive.bytes]),
    );
    await expect(
      inspectPrimeImageArchive({ archivePath: duplicateRootPath, imageId: archive.imageId }),
    ).rejects.toMatchObject({
      stage: "read image archive manifest",
      cause: expect.objectContaining({ message: "Prime image tar repeats its root marker" }),
    });
  }, 15_000);

  it("rejects a secret that a later layer deletes", async () => {
    const archive = dockerArchive([
      layerTar({ "run/private-token": syntheticPrivateKey() }),
      layerTar({ "run/.wh.private-token": "" }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({
      name: "PrimeImageArchiveInspectionError",
      stage: "scan image archive private keys",
      cause: expect.objectContaining({ message: expect.stringMatching(/secret/i) }),
    });
  });

  it("distinguishes complete private-key material from parser and documentation markers", async () => {
    const markerOnly = dockerArchive([
      layerTar({
        "usr/lib/parser.txt": "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----",
      }),
    ]);
    const markerOnlyPath = await writeArchive(markerOnly.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath: markerOnlyPath, imageId: markerOnly.imageId }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const boundaryKey = dockerArchive([
      layerTar({ "opt/flow/fixture.key": `${"x".repeat(65_510)}\n${syntheticPrivateKey()}` }),
    ]);
    const boundaryKeyPath = await writeArchive(boundaryKey.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath: boundaryKeyPath, imageId: boundaryKey.imageId }),
    ).rejects.toMatchObject({ stage: "scan image archive private keys" });
  });

  it.each(realPrivateKeyVariants())("rejects OpenSSL-accepted $label", async ({ pem }) => {
    const contents = pem.startsWith("\uFEFF") ? pem : `${"x".repeat(65_510)}\n${pem}`;
    const archive = dockerArchive([layerTar({ "opt/flow/fixture.key": contents })]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage: "scan image archive private keys" });
  });

  it.each([false, true])(
    "enforces exact and one-over private-key candidate bytes with terminated=%s",
    async (terminated) => {
      const marker = "-----BEGIN PRIVATE KEY-----\n";
      const terminator = terminated ? "\n" : "";
      const payloadBytes = 1_048_576 - marker.length - terminator.length;
      const exact = `${marker}${"A".repeat(payloadBytes)}${terminator}`;
      const oneOver = `${marker}${"A".repeat(payloadBytes + 1)}${terminator}`;
      expect(Buffer.byteLength(exact)).toBe(1_048_576);
      expect(Buffer.byteLength(oneOver)).toBe(1_048_577);

      const exactArchive = dockerArchive([layerTar({ "opt/flow/exact.key": exact })]);
      const exactPath = await writeArchive(exactArchive.bytes);
      await expect(
        inspectPrimeImageArchive({ archivePath: exactPath, imageId: exactArchive.imageId }),
      ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

      const overArchive = dockerArchive([layerTar({ "opt/flow/one-over.key": oneOver })]);
      const overPath = await writeArchive(overArchive.bytes);
      await expect(
        inspectPrimeImageArchive({ archivePath: overPath, imageId: overArchive.imageId }),
      ).rejects.toMatchObject({ stage: "scan image archive private keys" });
    },
  );

  it("rejects an OpenSSL-accepted private key that a later layer deletes", async () => {
    const encrypted = realPrivateKeyVariants().find(({ label }) => label.includes("tab metadata"));
    expect(encrypted).toBeDefined();
    if (encrypted === undefined) {
      throw new Error("The traditional encrypted RSA fixture is missing");
    }
    const archive = dockerArchive([
      layerTar({ "run/private-token": encrypted.pem }),
      layerTar({ "run/.wh.private-token": "" }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage: "scan image archive private keys" });
  });

  it.each([
    ["GitHub", `ghp_${"g".repeat(36)}`, "scan image archive GitHub tokens"],
    ["npm", `npm_${"n".repeat(36)}`, "scan image archive npm tokens"],
    [
      "bare synthetic sentinel",
      "FLOW_PRIME_FORBIDDEN_SECRET_",
      "scan image archive synthetic secrets",
    ],
    [
      "synthetic sentinel with digits",
      "FLOW_PRIME_FORBIDDEN_SECRET_0123456789",
      "scan image archive synthetic secrets",
    ],
    [
      "synthetic sentinel with separators",
      "FLOW_PRIME_FORBIDDEN_SECRET_fixture_01-test",
      "scan image archive synthetic secrets",
    ],
  ] as const)("classifies %s secret patterns", async (_label, token, stage) => {
    const archive = dockerArchive([layerTar({ "opt/flow/fixture.txt": token })]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage });
  });

  it("allows only the canonical AWS documentation access key example", async () => {
    const documentedExample = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/aws-example/index.d.ts": 'AccessKeyId: "AKIAIOSFODNN7EXAMPLE"',
      }),
    ]);
    const documentedExamplePath = await writeArchive(documentedExample.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: documentedExamplePath,
        imageId: documentedExample.imageId,
      }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const otherAccessKey = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/other-key/index.d.ts": 'AccessKeyId: "AKIA000000000EXAMPLE"',
      }),
    ]);
    const otherAccessKeyPath = await writeArchive(otherAccessKey.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: otherAccessKeyPath,
        imageId: otherAccessKey.imageId,
      }),
    ).rejects.toMatchObject({
      stage: "scan Node image AWS access keys",
      cause: expect.objectContaining({ message: expect.stringMatching(/secret/i) }),
    });

    const canonicalPrefix = "AKIAIOSFODNN7EXAMPLE\n";
    const boundaryPadding = "x".repeat(65_530 - canonicalPrefix.length - 1);
    const mixedBoundaryKeys = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/mixed-keys/index.d.ts": `${canonicalPrefix}${boundaryPadding}\nAKIA1234567890ABCDEF`,
      }),
    ]);
    const mixedBoundaryKeysPath = await writeArchive(mixedBoundaryKeys.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: mixedBoundaryKeysPath,
        imageId: mixedBoundaryKeys.imageId,
      }),
    ).rejects.toMatchObject({ stage: "scan Node image AWS access keys" });

    const embeddedAccessKey = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/encoded/index.js": `base64AKIA1234567890ABCDEFcontinuation`,
      }),
    ]);
    const embeddedAccessKeyPath = await writeArchive(embeddedAccessKey.bytes);
    await expect(
      inspectPrimeImageArchive({
        archivePath: embeddedAccessKeyPath,
        imageId: embeddedAccessKey.imageId,
      }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const chunkEdgeContinuation = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/encoded/chunk.js": `${"x".repeat(65_515)}\nAKIA1234567890ABCDEFZ`,
      }),
    ]);
    const chunkEdgeContinuationPath = await writeArchive(chunkEdgeContinuation.bytes);
    await expect(
      inspectPrimeImageArchive({
        archivePath: chunkEdgeContinuationPath,
        imageId: chunkEdgeContinuation.imageId,
      }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const chunkEdgeLookbehind = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/encoded/lookbehind.js": `${"x".repeat(65_536)}AKIA1234567890ABCDEF\n`,
      }),
    ]);
    const chunkEdgeLookbehindPath = await writeArchive(chunkEdgeLookbehind.bytes);
    await expect(
      inspectPrimeImageArchive({
        archivePath: chunkEdgeLookbehindPath,
        imageId: chunkEdgeLookbehind.imageId,
      }),
    ).resolves.toMatchObject({ archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    for (const delimiter of [" ", "\n", "."]) {
      const chunkEdgeDelimiter = dockerArchive([
        layerTar({
          "opt/flow/node/node_modules/encoded/boundary.js": `${"x".repeat(65_515)}\nAKIA1234567890ABCDEF${delimiter}`,
        }),
      ]);
      const chunkEdgeDelimiterPath = await writeArchive(chunkEdgeDelimiter.bytes);
      await expect(
        inspectPrimeImageArchive({
          archivePath: chunkEdgeDelimiterPath,
          imageId: chunkEdgeDelimiter.imageId,
        }),
      ).rejects.toMatchObject({ stage: "scan Node image AWS access keys" });
    }

    const finalStandaloneKey = dockerArchive([
      layerTar({ "opt/flow/node/node_modules/final/index.js": "AKIA1234567890ABCDEF" }),
    ]);
    const finalStandaloneKeyPath = await writeArchive(finalStandaloneKey.bytes);
    await expect(
      inspectPrimeImageArchive({
        archivePath: finalStandaloneKeyPath,
        imageId: finalStandaloneKey.imageId,
      }),
    ).rejects.toMatchObject({ stage: "scan Node image AWS access keys" });

    const pythonAccessKey = dockerArchive([
      layerTar({
        "opt/flow/python/lib/python3.11/site-packages/example.py": "AKIA1234567890ABCDEF",
      }),
    ]);
    const pythonAccessKeyPath = await writeArchive(pythonAccessKey.bytes);

    await expect(
      inspectPrimeImageArchive({
        archivePath: pythonAccessKeyPath,
        imageId: pythonAccessKey.imageId,
      }),
    ).rejects.toMatchObject({ stage: "scan Python image AWS access keys" });

    const nativeAccessKey = dockerArchive([
      layerTar({ "opt/flow/bin/native-fixture": "AKIA1234567890ABCDEF" }),
    ]);
    const nativeAccessKeyPath = await writeArchive(nativeAccessKey.bytes);
    await expect(
      inspectPrimeImageArchive({
        archivePath: nativeAccessKeyPath,
        imageId: nativeAccessKey.imageId,
      }),
    ).rejects.toMatchObject({ stage: "scan native Prime image AWS access keys" });

    const systemAccessKey = dockerArchive([
      layerTar({ "var/lib/system-fixture": "AKIA1234567890ABCDEF" }),
    ]);
    const systemAccessKeyPath = await writeArchive(systemAccessKey.bytes);
    await expect(
      inspectPrimeImageArchive({
        archivePath: systemAccessKeyPath,
        imageId: systemAccessKey.imageId,
      }),
    ).rejects.toMatchObject({ stage: "scan system image AWS access keys" });
  });

  it("rejects an archive whose configuration bytes do not match the image ID", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: `sha256:${"f".repeat(64)}` }),
    ).rejects.toMatchObject({
      name: "PrimeImageArchiveInspectionError",
      stage: "verify image archive configuration",
      cause: expect.objectContaining({ message: expect.stringMatching(/configuration.*digest/i) }),
    });
  });

  it("classifies noncanonical archive input", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: "invalid" }),
    ).rejects.toMatchObject({ stage: "open image archive" });
  });

  it("classifies a missing Docker archive manifest", async () => {
    const archivePath = await writeArchive(createTarArchive({ "other.json": Buffer.from("{}\n") }));

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: `sha256:${"a".repeat(64)}` }),
    ).rejects.toMatchObject({ stage: "read image archive manifest" });
  });

  it("classifies invalid package inventory metadata", async () => {
    const archive = dockerArchive([
      layerTar({ "opt/flow/node/node_modules/invalid/package.json": "{" }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage: "inventory image archive packages" });
  });

  it.each(nodePackageIdentityCases)(
    "matches the runtime probe when a Node package $label",
    async (testCase) => {
      const archive = dockerArchive([
        layerTar({
          "opt/flow/node/node_modules/fixture/package.json": JSON.stringify(testCase.manifest),
        }),
      ]);
      const archivePath = await writeArchive(archive.bytes);
      const inspection = inspectPrimeImageArchive({ archivePath, imageId: archive.imageId });

      if (testCase.outcome === "reject") {
        await expect(inspection).rejects.toMatchObject({
          stage: "inventory image archive packages",
        });
      } else {
        const inspected = await inspection;
        expect(inspected.sbom.node).toEqual(
          testCase.outcome === "accept" ? [testCase.identity] : [],
        );
      }
    },
  );

  it("matches the runtime probe by deduplicating Node package identities", async () => {
    const identity = { name: "duplicate", version: "1.2.3" };
    const archive = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/first/package.json": JSON.stringify(identity),
        "opt/flow/node/node_modules/second/package.json": JSON.stringify(identity),
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).resolves.toMatchObject({
      sbom: { node: [identity], python: [] },
    });
  });

  it("matches the runtime probe by selecting only immediate Python dist-info metadata", async () => {
    const archive = dockerArchive([
      layerTar({
        "opt/flow/python/lib/python3.11/site-packages/selected-1.2.3.dist-info/METADATA":
          "Name: selected\nVersion: 1.2.3\n",
        "opt/flow/python/lib/python3.11/site-packages/selected-1.2.3.dist-info/nested/METADATA":
          "Name: nested\nVersion: 9.9.9\n",
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).resolves.toMatchObject({
      sbom: { node: [], python: [{ name: "selected", version: "1.2.3" }] },
    });
  });

  it("rejects final Python package metadata with invalid UTF-8", async () => {
    const archive = dockerArchive([
      layerTar({
        "opt/flow/python/lib/python3.11/site-packages/invalid.dist-info/METADATA":
          invalidUtf8PythonPackageMetadata,
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
    ).rejects.toMatchObject({ stage: "inventory image archive packages" });
  });

  it("enforces exact aggregate package metadata budget transitions", () => {
    const entryBudget = new PrimeImagePackageMetadataBudget();
    for (let index = 0; index < 131_072; index += 1) {
      entryBudget.replace(undefined, 0);
    }
    expect(entryBudget.entries).toBe(131_072);
    expect(() => entryBudget.replace(undefined, 0)).toThrowError(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: "Prime image package metadata exceeds its aggregate limit",
        }),
        stage: "inventory image archive packages",
      }),
    );

    const byteBudget = new PrimeImagePackageMetadataBudget();
    byteBudget.replace(undefined, 2_147_483_648);
    expect(byteBudget.bytes).toBe(2_147_483_648);
    expect(() => byteBudget.replace(2_147_483_648, 2_147_483_649)).toThrowError(
      expect.objectContaining({ stage: "inventory image archive packages" }),
    );

    const replacementBudget = new PrimeImagePackageMetadataBudget({
      maxBytes: 100,
      maxEntries: 1,
    });
    replacementBudget.replace(undefined, 60);
    replacementBudget.replace(60, 100);
    expect(replacementBudget).toMatchObject({ bytes: 100, entries: 1 });
    expect(() => replacementBudget.replace(100, 101)).toThrowError(
      expect.objectContaining({ stage: "inventory image archive packages" }),
    );

    let maxByteReads = 0;
    let maxEntryReads = 0;
    const accessorBudget = new PrimeImagePackageMetadataBudget({
      get maxBytes() {
        maxByteReads += 1;
        return maxByteReads <= 2 ? 1 : Number.NaN;
      },
      get maxEntries() {
        maxEntryReads += 1;
        return maxEntryReads <= 2 ? 1 : Number.NaN;
      },
    });
    expect(() => accessorBudget.replace(undefined, 2)).toThrowError(
      expect.objectContaining({ stage: "inventory image archive packages" }),
    );
    expect(maxByteReads).toBe(1);
    expect(maxEntryReads).toBe(1);

    const inconsistentBudget = new PrimeImagePackageMetadataBudget({
      maxBytes: 100,
      maxEntries: 1,
    });
    inconsistentBudget.replace(undefined, 100);
    expect(() => inconsistentBudget.replace(1_000, 0)).toThrow(/budget transition is invalid/i);
    expect(inconsistentBudget).toMatchObject({ bytes: 100, entries: 1 });

    const emptyBudget = new PrimeImagePackageMetadataBudget({ maxBytes: 10, maxEntries: 1 });
    expect(() => emptyBudget.replace(0, 1)).toThrow(/budget transition is invalid/i);
    expect(() => emptyBudget.replace(5, 0)).toThrow(/budget transition is invalid/i);
    expect(emptyBudget).toMatchObject({ bytes: 0, entries: 0 });
  });

  it("budgets only the final duplicate metadata header in one layer", async () => {
    const path = "opt/flow/node/node_modules/duplicate-budget/package.json";
    const finalManifest = Buffer.from(
      JSON.stringify({ name: "duplicate-budget", version: "1.0.0" }),
    );
    const layer = Buffer.concat([
      createTarEntryPrefix([
        { content: Buffer.alloc(101, 0x20), path },
        { content: finalManifest, path },
      ]),
      Buffer.alloc(1_024),
    ]);
    const archive = dockerArchive([layer]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        { packageMetadataLimits: { maxBytes: 100, maxEntries: 1 } },
      ),
    ).resolves.toMatchObject({
      sbom: { node: [{ name: "duplicate-budget", version: "1.0.0" }], python: [] },
    });
  });

  it("enforces the package metadata entry budget after cross-layer merging", async () => {
    const packageLayer = (name: string) =>
      layerTar({
        [`opt/flow/node/node_modules/${name}/package.json`]: JSON.stringify({
          name,
          version: "1.0.0",
        }),
      });
    const limits = { maxBytes: 1_048_576, maxEntries: 2 };
    const exact = dockerArchive([packageLayer("first"), packageLayer("second")]);
    const exactPath = await writeArchive(exact.bytes);
    await expect(
      inspectPrimeImageArchive(
        { archivePath: exactPath, imageId: exact.imageId },
        { packageMetadataLimits: limits },
      ),
    ).resolves.toMatchObject({ sbom: { node: expect.any(Array), python: [] } });

    const over = dockerArchive([
      packageLayer("first"),
      packageLayer("second"),
      packageLayer("third"),
    ]);
    const overPath = await writeArchive(over.bytes);
    await expect(
      inspectPrimeImageArchive(
        { archivePath: overPath, imageId: over.imageId },
        { packageMetadataLimits: limits },
      ),
    ).rejects.toMatchObject({ stage: "inventory image archive packages" });
  });

  it("applies aggregate package metadata budgets independently by package kind", async () => {
    const archive = dockerArchive([
      layerTar({
        "opt/flow/node/node_modules/selected/package.json": JSON.stringify({
          name: "selected-node",
          version: "1.0.0",
        }),
        "opt/flow/python/lib/python3.11/site-packages/selected.dist-info/METADATA":
          "Name: selected-python\nVersion: 1.0.0\n",
      }),
    ]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        { packageMetadataLimits: { maxBytes: 1_048_576, maxEntries: 1 } },
      ),
    ).resolves.toMatchObject({
      sbom: {
        node: [{ name: "selected-node", version: "1.0.0" }],
        python: [{ name: "selected-python", version: "1.0.0" }],
      },
    });
  });

  it.each([1_048_576, 1_048_577])(
    "enforces the individual package metadata limit at %i bytes",
    async (bytes) => {
      const identity = JSON.stringify({ name: "bounded", version: "1.0.0" });
      const manifest = `${identity}${" ".repeat(bytes - Buffer.byteLength(identity))}`;
      const archive = dockerArchive([
        layerTar({ "opt/flow/node/node_modules/bounded/package.json": manifest }),
      ]);
      const archivePath = await writeArchive(archive.bytes);
      const inspection = inspectPrimeImageArchive({ archivePath, imageId: archive.imageId });

      if (bytes === 1_048_576) {
        await expect(inspection).resolves.toMatchObject({
          sbom: { node: [{ name: "bounded", version: "1.0.0" }], python: [] },
        });
      } else {
        await expect(inspection).rejects.toMatchObject({
          stage: "inventory image archive packages",
        });
      }
    },
  );

  it.each(["whiteout", "replacement"] as const)(
    "settles oversized lower-layer package metadata with a final %s",
    async (settlement) => {
      const path = "opt/flow/node/node_modules/oversized/package.json";
      const identity = JSON.stringify({ name: "oversized", version: "1.0.0" });
      const oversized = `${identity}${" ".repeat(1_048_577 - Buffer.byteLength(identity))}`;
      const archive = dockerArchive([
        layerTar({ [path]: oversized }),
        settlement === "whiteout"
          ? layerTar({ "opt/flow/node/node_modules/oversized/.wh.package.json": "" })
          : layerTar({
              [path]: JSON.stringify({ name: "settled", version: "1.0.0" }),
            }),
      ]);
      const archivePath = await writeArchive(archive.bytes);

      await expect(
        inspectPrimeImageArchive({ archivePath, imageId: archive.imageId }),
      ).resolves.toMatchObject({
        sbom: {
          node: settlement === "whiteout" ? [] : [{ name: "settled", version: "1.0.0" }],
          python: [],
        },
      });
    },
  );

  it.each([8_192, 8_193])(
    "enforces the unique package identity limit at %i entries",
    async (count) => {
      const manifests = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `opt/flow/node/node_modules/package-${index}/package.json`,
          JSON.stringify({ name: `package-${index}`, version: "1.0.0" }),
        ]),
      );
      const archive = dockerArchive([layerTar(manifests)]);
      const archivePath = await writeArchive(archive.bytes);
      const inspection = inspectPrimeImageArchive({ archivePath, imageId: archive.imageId });

      if (count === 8_192) {
        const inspected = await inspection;
        expect(inspected.sbom.node).toHaveLength(8_192);
        expect(inspected.sbom.python).toEqual([]);
      } else {
        await expect(inspection).rejects.toMatchObject({
          stage: "inventory image archive packages",
        });
      }
    },
    15_000,
  );

  it("classifies archive mutation during the final stability observation", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        {
          beforeStabilityObservation: async () => {
            await appendFile(archivePath, Buffer.from("changed"));
          },
        },
      ),
    ).rejects.toMatchObject({
      stage: "verify image archive stability",
      cause: expect.objectContaining({ message: "Prime image archive changed while inspected" }),
    });
  });

  it("classifies a close failure as archive stability evidence", async () => {
    const archive = dockerArchive([layerTar({})]);
    const archivePath = await writeArchive(archive.bytes);
    const closeFailure = new Error("private delayed close failure");

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        {
          closeArchive: async (handle) => {
            await handle.close();
            throw closeFailure;
          },
        },
      ),
    ).rejects.toMatchObject({
      stage: "verify image archive stability",
      cause: closeFailure,
    });
  });

  it("preserves a primary phase when archive close also fails", async () => {
    const archive = dockerArchive([layerTar({ "run/private-token": syntheticPrivateKey() })]);
    const archivePath = await writeArchive(archive.bytes);
    const closeFailure = new Error("private close failure after scan failure");

    await expect(
      inspectPrimeImageArchive(
        { archivePath, imageId: archive.imageId },
        {
          closeArchive: async (handle) => {
            await handle.close();
            throw closeFailure;
          },
        },
      ),
    ).rejects.toMatchObject({
      stage: "scan image archive private keys",
      cause: expect.objectContaining({
        errors: [
          expect.objectContaining({ stage: "scan image archive private keys" }),
          closeFailure,
        ],
      }),
    });
  });

  it("uses a closed public diagnostic for archive inspection failures", () => {
    expect(
      new PrimeImageArchiveInspectionError("read image archive manifest", new Error("private")),
    ).toMatchObject({
      message: "Prime image archive inspection failed during read image archive manifest",
      stage: "read image archive manifest",
    });
  });
});

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function syntheticPrivateKey(): string {
  const line = "QUJD".repeat(16);
  return `-----BEGIN PRIVATE KEY-----\n${line}\n${line}\n-----END PRIVATE KEY-----\n`;
}

function realPrivateKeyVariants(): readonly Readonly<{
  readonly label: string;
  readonly pem: string;
}>[] {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1_024 });
  const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const pkcs8Lines = pkcs8.trimEnd().split("\n");
  const body = pkcs8Lines.slice(1, -1).join("");
  const spacedPkcs8 = `${pkcs8Lines[0]}\n${body.split("").join("        ")}\n${pkcs8Lines.at(-1)}\n`;
  const passphrase = "flow-test-only-passphrase";
  const traditionalEncrypted = privateKey
    .export({
      cipher: "aes-256-cbc",
      format: "pem",
      passphrase,
      type: "pkcs1",
    })
    .toString();
  const encryptedPkcs8 = privateKey
    .export({
      cipher: "aes-256-cbc",
      format: "pem",
      passphrase,
      type: "pkcs8",
    })
    .toString();
  const bomPkcs8 = `\uFEFF${pkcs8}`;
  const tabbedTraditional = traditionalEncrypted.replace("Proc-Type: 4", "Proc-Type:\t4");

  createPrivateKey(spacedPkcs8);
  createPrivateKey({ key: traditionalEncrypted, passphrase });
  createPrivateKey({ key: encryptedPkcs8, passphrase });
  createPrivateKey(bomPkcs8);
  createPrivateKey({ key: tabbedTraditional, passphrase });
  return Object.freeze([
    Object.freeze({ label: "PKCS#8 with legal payload whitespace", pem: spacedPkcs8 }),
    Object.freeze({ label: "traditional encrypted RSA PEM", pem: traditionalEncrypted }),
    Object.freeze({ label: "encrypted PKCS#8 PEM", pem: encryptedPkcs8 }),
    Object.freeze({ label: "PKCS#8 with one file-start UTF-8 BOM", pem: bomPkcs8 }),
    Object.freeze({
      label: "traditional encrypted RSA PEM with tab metadata",
      pem: tabbedTraditional,
    }),
  ]);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
