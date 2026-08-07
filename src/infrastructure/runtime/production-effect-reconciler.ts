import type { NodeEffectReconciler } from "../../application/ports.js";
import { reconcileHashAnchoredEditEffect } from "../fs/hash-anchored-edit.js";

export function createProductionNodeEffectReconciler(): NodeEffectReconciler {
  const reconciler: NodeEffectReconciler = {
    async reconcile(descriptor, publish, signal) {
      await reconcileHashAnchoredEditEffect(descriptor, publish, {
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
  return Object.freeze(reconciler);
}
