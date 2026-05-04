// W3 functional probe — fs.promises.rm recursive
import { execProbe } from '../_helpers.mjs';

export default function fs_promises_rm() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('fs-promises-rm', `
      const fs = require('fs');
      const fsp = fs.promises;
      (async () => {
        await fsp.mkdir('/tmp/rm-tree/sub', { recursive: true });
        await fsp.writeFile('/tmp/rm-tree/a.txt', 'A');
        await fsp.writeFile('/tmp/rm-tree/sub/b.txt', 'B');
        const before = fs.existsSync('/tmp/rm-tree');
        await fsp.rm('/tmp/rm-tree', { recursive: true, force: true });
        const after = fs.existsSync('/tmp/rm-tree/a.txt');
        console.log('RM_BEFORE=' + before);
        console.log('RM_AFTER=' + after);
      })().catch(e => console.log('RM_ERROR=' + (e.code || e.message)));
    `);
    if (!r.ok) return assertProbe('fs-promises-rm', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    return assertProbe('fs-promises-rm',
      so.includes('RM_BEFORE=true') && so.includes('RM_AFTER=false'),
      'expected RM_BEFORE=true RM_AFTER=false, got:\n' + so, r.output);
  });
}
