/**
 * git/pack/facet.ts — the pack layer as the git network facet runs it.
 *
 * scripts/bundle-facet-workers.mjs builds this into an IIFE bound to
 * `__nimbusGitPack` (pack/facet.generated.ts), which the facet's generated
 * source splices ahead of its body, as it does the wave writer. node:crypto
 * and node:zlib resolve to the facet module's own imports of them.
 */
export { PackStreamProcessor, WORK_BUDGET_UNITS } from './processor.js';
export { encodeIdxV2, ENTRY_BYTES } from './idx.js';
export { discover, requestPack, UploadPackError } from './upload-pack.js';
export { CheckoutPlan, encodeBatch, decodeBatch, parseTree } from './plan.js';
export { oidToHex, oidFromHex, PackFormatError } from './format.js';
export { cloneDiscover, cloneFast, cloneBatch, cloneFinish, clonePlanFromStore, fetchObjects } from './clone.js';
export { historyStep, historyResume, historyPlan, treeSlices } from './history.js';
export { facetPacks } from './facet-packs.js';
