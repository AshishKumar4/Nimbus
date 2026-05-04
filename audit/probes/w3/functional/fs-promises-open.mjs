// W3 functional probe — fs.promises.open returns FileHandle with read/write/close
import { execProbe } from '../_helpers.mjs';

export default function fs_promises_open() {
  return execProbe(async ({ runFacetSnippet, extractStdout, assertProbe }) => {
    const r = await runFacetSnippet('fs-promises-open', `
      const fs = require('fs');
      const fsp = fs.promises;
      (async () => {
        await fsp.writeFile('/tmp/fh.txt', 'hello fh');
        const fh = await fsp.open('/tmp/fh.txt', 'r');
        console.log('FH_TYPEOF=' + (typeof fh));
        console.log('FH_READFILE_TYPE=' + (typeof fh.readFile));
        console.log('FH_CLOSE_TYPE=' + (typeof fh.close));
        const content = await fh.readFile('utf8');
        console.log('FH_CONTENT=' + content);
        await fh.close();
        console.log('FH_DONE=true');
      })().catch(e => console.log('FH_ERROR=' + (e.code || e.message)));
    `);
    if (!r.ok) return assertProbe('fs-promises-open', false, 'driver failed', r.output);
    const so = extractStdout(r.output);
    const ok = so.includes('FH_TYPEOF=object')
      && so.includes('FH_READFILE_TYPE=function')
      && so.includes('FH_CLOSE_TYPE=function')
      && so.includes('FH_CONTENT=hello fh')
      && so.includes('FH_DONE=true');
    return assertProbe('fs-promises-open', ok, 'expected all FH checks, got:\n' + so, r.output);
  });
}
