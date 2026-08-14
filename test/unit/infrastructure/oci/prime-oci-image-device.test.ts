import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolvePrimeImageDevice } from "../../../../src/infrastructure/oci/prime-oci-image-device.js";

describe("Prime OCI image-device resolution", () => {
  it("resolves an exact whole Docker-root device through sysfs without /dev/block", async () => {
    const readMetadata = vi.fn(async (path: string) => {
      if (path === "/var/lib/docker") {
        return deviceMetadata({ device: linuxDevice(259, 0), block: false });
      }
      if (path === "/dev/nvme0n1") {
        return deviceMetadata({ device: linuxDevice(259, 0), block: true });
      }
      throw new Error(`unexpected metadata path: ${path}`);
    });

    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/259:0") {
            return "/sys/devices/pci0000:00/block/nvme0n1";
          }
          return path;
        },
        readMetadata,
        readPartitionMarker: async () => null,
      }),
    ).resolves.toEqual({ path: "/dev/nvme0n1", major: 259, minor: 0 });
    expect(readMetadata).not.toHaveBeenCalledWith("/dev/block/259:0");
  });

  it("uses a missing production partition marker as whole-device evidence", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-prime-sysfs-"));
    const sysfsDevice = join(temporaryRoot, "nvme0n1");
    await mkdir(sysfsDevice);
    try {
      await expect(
        resolvePrimeImageDevice("/var/lib/docker", {
          realpath: async (path) => (path === "/sys/dev/block/259:0" ? sysfsDevice : path),
          readMetadata: async (path) =>
            path === "/var/lib/docker"
              ? deviceMetadata({ device: linuxDevice(259, 0), block: false })
              : deviceMetadata({ device: linuxDevice(259, 0), block: true }),
        }),
      ).resolves.toEqual({ path: "/dev/nvme0n1", major: 259, minor: 0 });
    } finally {
      await rm(temporaryRoot, { recursive: true });
    }
  });

  it("rejects a production partition-marker read fault other than absence", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "flow-prime-sysfs-"));
    const sysfsDevice = join(temporaryRoot, "nvme0n1");
    await mkdir(join(sysfsDevice, "partition"), { recursive: true });
    try {
      await expect(
        resolvePrimeImageDevice("/var/lib/docker", {
          realpath: async (path) => (path === "/sys/dev/block/259:0" ? sysfsDevice : path),
          readMetadata: async () => deviceMetadata({ device: linuxDevice(259, 0), block: false }),
        }),
      ).rejects.toMatchObject({ code: "EISDIR" });
    } finally {
      await rm(temporaryRoot, { recursive: true });
    }
  });

  it("resolves a Docker-root partition to its exact whole-disk cgroup device", async () => {
    const sysfsPartition = "/sys/devices/pci0000:00/block/sda/sda1";
    const sysfsDisk = "/sys/devices/pci0000:00/block/sda";
    const readMetadata = vi.fn(async (path: string) => {
      if (path === "/var/lib/docker") {
        return deviceMetadata({ device: linuxDevice(8, 1), block: false });
      }
      if (path === "/dev/sda") {
        return deviceMetadata({ device: linuxDevice(8, 0), block: true });
      }
      throw new Error(`unexpected metadata path: ${path}`);
    });

    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return sysfsPartition;
          }
          if (path === "/sys/dev/block/8:0") {
            return sysfsDisk;
          }
          return path;
        },
        readMetadata,
        readPartitionMarker: async (path) => {
          expect(path).toBe(`${sysfsPartition}/partition`);
          return "1\n";
        },
      }),
    ).resolves.toEqual({ path: "/dev/sda", major: 8, minor: 0 });
    expect(readMetadata).not.toHaveBeenCalledWith("/dev/sda1");
  });

  it("rejects a block node whose device identity differs from Docker root", async () => {
    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/test-device";
          }
          return path;
        },
        readPartitionMarker: async () => null,
        readMetadata: async (path) =>
          path === "/var/lib/docker"
            ? deviceMetadata({ device: linuxDevice(8, 1), block: false })
            : deviceMetadata({ device: linuxDevice(8, 2), block: true }),
      }),
    ).rejects.toThrow(/sysfs identity/i);
  });

  it("rejects a non-block node with the matching device identity", async () => {
    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/test-device";
          }
          return path;
        },
        readPartitionMarker: async () => null,
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

  it.each(["0", "01", "10000000000", "1\n\n", "PRIVATE_PARTITION"])(
    "rejects the invalid sysfs partition marker %j",
    async (partitionMarker) => {
      await expect(
        resolvePrimeImageDevice("/var/lib/docker", {
          realpath: async (path) =>
            path === "/sys/dev/block/8:1" ? "/sys/devices/pci0000:00/block/sda/sda1" : path,
          readPartitionMarker: async () => partitionMarker,
          readMetadata: async () => deviceMetadata({ device: linuxDevice(8, 1), block: false }),
        }),
      ).rejects.toThrow(/partition marker/i);
    },
  );

  it("accepts the maximum bounded sysfs partition marker", async () => {
    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/sda/sda1";
          }
          if (path === "/sys/dev/block/8:0") {
            return "/sys/devices/pci0000:00/block/sda";
          }
          return path;
        },
        readPartitionMarker: async () => "9999999999\n",
        readMetadata: async (path) =>
          path === "/var/lib/docker"
            ? deviceMetadata({ device: linuxDevice(8, 1), block: false })
            : deviceMetadata({ device: linuxDevice(8, 0), block: true }),
      }),
    ).resolves.toEqual({ path: "/dev/sda", major: 8, minor: 0 });
  });

  it("rejects a whole-disk node whose sysfs identity is not the partition parent", async () => {
    await expect(
      resolvePrimeImageDevice("/var/lib/docker", {
        realpath: async (path) => {
          if (path === "/sys/dev/block/8:1") {
            return "/sys/devices/pci0000:00/block/sda/sda1";
          }
          if (path === "/sys/dev/block/8:0") {
            return "/sys/devices/pci0000:00/block/foreign";
          }
          return path;
        },
        readPartitionMarker: async () => "1\n",
        readMetadata: async (path) =>
          path === "/var/lib/docker"
            ? deviceMetadata({ device: linuxDevice(8, 1), block: false })
            : deviceMetadata({ device: linuxDevice(8, 0), block: true }),
      }),
    ).rejects.toThrow(/sysfs identity/i);
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
