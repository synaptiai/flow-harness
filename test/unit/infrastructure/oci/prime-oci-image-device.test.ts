import { describe, expect, it, vi } from "vitest";

import { resolvePrimeImageDevice } from "../../../../src/infrastructure/oci/prime-oci-image-device.js";

describe("Prime OCI image-device resolution", () => {
  it("resolves the exact Docker-root device through sysfs without /dev/block", async () => {
    const readMetadata = vi.fn(async (path: string) => {
      if (path === "/var/lib/docker") {
        return deviceMetadata({ device: linuxDevice(8, 1), block: false });
      }
      if (path === "/dev/sda1") {
        return deviceMetadata({ device: linuxDevice(8, 1), block: true });
      }
      throw new Error(`unexpected metadata path: ${path}`);
    });

    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/sda/sda1";
          }
          return path;
        },
        readMetadata,
      }),
    ).resolves.toEqual({ path: "/dev/sda1", major: 8, minor: 1 });
    expect(readMetadata).not.toHaveBeenCalledWith("/dev/block/8:1");
  });

  it("rejects a block node whose device identity differs from Docker root", async () => {
    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/sda/sda1";
          }
          return path;
        },
        readMetadata: async (path) =>
          path === "/var/lib/docker"
            ? deviceMetadata({ device: linuxDevice(8, 1), block: false })
            : deviceMetadata({ device: linuxDevice(8, 2), block: true }),
      }),
    ).rejects.toThrow(/exact block device/i);
  });

  it("rejects a non-block node with the matching device identity", async () => {
    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/sda/sda1";
          }
          return path;
        },
        readMetadata: async (path) =>
          path === "/var/lib/docker"
            ? deviceMetadata({ device: linuxDevice(8, 1), block: false })
            : {
                dev: 0n,
                rdev: linuxDevice(8, 1),
                isBlockDevice: () => false,
              },
      }),
    ).rejects.toThrow(/not one block device/i);
  });
});

function deviceMetadata(input: { readonly device: bigint; readonly block: boolean }) {
  return {
    dev: input.block ? 0n : input.device,
    rdev: input.block ? input.device : 0n,
    isBlockDevice: () => input.block,
  };
}

function linuxDevice(major: number, minor: number): bigint {
  const majorValue = BigInt(major);
  const minorValue = BigInt(minor);
  return (
    ((majorValue & 0xfffn) << 8n) |
    ((majorValue & ~0xfffn) << 32n) |
    (minorValue & 0xffn) |
    ((minorValue & ~0xffn) << 12n)
  );
}
