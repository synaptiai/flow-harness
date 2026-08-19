import { describe, expect, it } from "vitest";

import {
  checkCapabilityPackagePhysicalPublication,
  checkCapabilityPackageRecoveryInventory,
  MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS,
  MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES,
  MAX_CAPABILITY_PACKAGE_RECOVERY_BLOBS,
  MAX_CAPABILITY_PACKAGE_RECOVERY_BYTES,
} from "../../../src/application/capability-package-store.js";

describe("capability package physical storage", () => {
  it("accepts an exact count and byte boundary", () => {
    const publicationBytes = 1_024;

    expect(
      checkCapabilityPackagePhysicalPublication({
        physicalBlobCount: MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS - 1,
        physicalBlobBytes: MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES - publicationBytes,
        publicationBytes,
        blobAlreadyPresent: false,
      }),
    ).toEqual({
      allowed: true,
      resultingBlobCount: MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS,
      resultingBlobBytes: MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES,
    });
  });

  it.each([
    ["blob count", MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS, 0, 1],
    ["blob bytes", 0, MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES, 1],
  ] as const)(
    "rejects a publication one past the physical %s limit",
    (_label, physicalBlobCount, physicalBlobBytes, publicationBytes) => {
      expect(
        checkCapabilityPackagePhysicalPublication({
          physicalBlobCount,
          physicalBlobBytes,
          publicationBytes,
          blobAlreadyPresent: false,
        }),
      ).toEqual({
        allowed: false,
        resultingBlobCount: physicalBlobCount + 1,
        resultingBlobBytes: physicalBlobBytes + publicationBytes,
      });
    },
  );

  it("does not charge an exact blob that is already present", () => {
    expect(
      checkCapabilityPackagePhysicalPublication({
        physicalBlobCount: MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS,
        physicalBlobBytes: MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES,
        publicationBytes: 4_096,
        blobAlreadyPresent: true,
      }),
    ).toEqual({
      allowed: true,
      resultingBlobCount: MAX_CAPABILITY_PACKAGE_PHYSICAL_BLOBS,
      resultingBlobBytes: MAX_CAPABILITY_PACKAGE_PHYSICAL_BYTES,
    });
  });

  it.each([
    [MAX_CAPABILITY_PACKAGE_RECOVERY_BLOBS, MAX_CAPABILITY_PACKAGE_RECOVERY_BYTES, true],
    [MAX_CAPABILITY_PACKAGE_RECOVERY_BLOBS + 1, 0, false],
    [0, MAX_CAPABILITY_PACKAGE_RECOVERY_BYTES + 1, false],
  ] as const)(
    "checks the recovery inventory boundary for %i blobs and %i bytes",
    (physicalBlobCount, physicalBlobBytes, allowed) => {
      expect(
        checkCapabilityPackageRecoveryInventory({ physicalBlobCount, physicalBlobBytes }),
      ).toEqual({ allowed });
    },
  );
});
