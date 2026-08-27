import type { NodeEffectReconciler } from "../../application/ports.js";
import { reconcileHashAnchoredFilesystemEffect } from "../fs/hash-anchored-edit.js";

export function createProductionNodeEffectReconciler(): NodeEffectReconciler {
  const reconciler: NodeEffectReconciler = {
    async reconcile(descriptor, publish, signal) {
      await reconcileHashAnchoredFilesystemEffect(descriptor, publish, {
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
  return Object.freeze(reconciler);
}
