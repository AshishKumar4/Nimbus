// Core and fabric share one holder without introducing a dependency cycle.
export {
  adoptCtxExports,
  composeFabric,
  getCtxExports,
  stagedBootAssembler,
  supervisorEntrypoint,
  supervisorEntrypointName,
} from '@nimbus-sh/platform/composition.js';

export type {
  CtxExports,
  EntrypointLoopbackFactory,
  FabricComposition,
  StagedBootAssembler,
} from '@nimbus-sh/platform/composition.js';
