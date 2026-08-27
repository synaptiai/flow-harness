import type { NodeEffectReconciler } from "../../application/ports.js";
import { reconcileExclusiveDirectoryCreateEffect } from "../fs/exclusive-directory-create.js";
import { reconcileHashAnchoredFilesystemEffect } from "../fs/hash-anchored-edit.js";

export function createProductionNodeEffectReconciler(): NodeEffectReconciler {
  const reconciler: NodeEffectReconciler = {
    async reconcile(descriptor, publish, signal) {
      if (descriptor.kind === "filesystem.mkdir") {
        await reconcileExclusiveDirectoryCreateEffect(descriptor, publish, {
          ...(signal === undefined ? {} : { signal }),
        });
        return;
      }
      await reconcileHashAnchoredFilesystemEffect(descriptor, publish, {
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
  return Object.freeze(reconciler);
}
