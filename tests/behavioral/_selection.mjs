// How a probe is named in a selection (NIMBUS_PROBE_ONLY, NIMBUS_PROBE_SKIP,
// remote-probes --only/--skip): its path under tests/behavioral without
// `.mjs` ("frameworks/astro-real"), or its file's own name ("astro-real").
import { basename } from 'node:path';

/** A comma-separated selection's names; a name may carry `.mjs`, `./` or a `tests/behavioral/` prefix. */
export const selectionNames = (list) => (list || '').split(',').filter(Boolean)
  .map((name) => name.replace(/^(\.\/)?(tests\/behavioral\/)?/, '').replace(/\.mjs$/, ''));

/** Whether `names` names the probe at `relPath` (its path under tests/behavioral, with `.mjs`). */
export function namesProbe(names, relPath) {
  const full = relPath.replace(/\.mjs$/, '');
  const leaf = basename(relPath).replace(/\.mjs$/, '');
  return names.includes(full) || names.includes(leaf);
}

/** Whether a run selected by `only` and `skip` (comma-separated, either may be empty) runs the probe at `relPath`. */
export function selects({ only = '', skip = '' }, relPath) {
  const onlyNames = selectionNames(only);
  if (onlyNames.length > 0 && !namesProbe(onlyNames, relPath)) return false;
  return !namesProbe(selectionNames(skip), relPath);
}
