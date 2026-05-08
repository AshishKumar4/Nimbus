// W10 functional: R2 onlyIf conditionals (etag-based If-Match / If-None-Match)

import { eq, ok, summary } from '../_tap.mjs';
import { makeMockVfs } from '../_mock-vfs.mjs';
import { R2Emulator } from '../../../../src/bindings/r2.ts';

const vfs = makeMockVfs();
const r2 = new R2Emulator({ vfs, root: 'home/user', binding: 'BUCKET', onLog: () => {} });

const obj = await r2.put('config.json', '{"v":1}');
const etag = obj.etag;
ok('etag present', typeof etag === 'string' && etag.length > 0);

// If-Match: match — returns body
const matched = await r2.get('config.json', { onlyIf: { etagMatches: etag } });
ok('match: returns object', !!matched);
eq('match: text correct', await matched.text(), '{"v":1}');

// If-Match: no match — returns null  (real R2 returns precondition fail; emulator returns null body)
const noMatch = await r2.get('config.json', { onlyIf: { etagMatches: 'wrong-etag' } });
eq('etagMatches wrong returns null', noMatch, null);

// If-None-Match: not matching → returns body
const noneOK = await r2.get('config.json', { onlyIf: { etagDoesNotMatch: 'unrelated' } });
ok('etagDoesNotMatch with unrelated etag returns body', !!noneOK);

// If-None-Match: matching → returns null (304 equivalent)
const noneNotOK = await r2.get('config.json', { onlyIf: { etagDoesNotMatch: etag } });
eq('etagDoesNotMatch with matching etag returns null', noneNotOK, null);

// Conditional put: only put if etag matches existing
const updated = await r2.put('config.json', '{"v":2}', { onlyIf: { etagMatches: etag } });
ok('conditional put with matching etag succeeds', !!updated);
eq('updated body', await (await r2.get('config.json')).text(), '{"v":2}');

// Conditional put with stale etag fails
const stale = await r2.put('config.json', '{"v":3}', { onlyIf: { etagMatches: etag } });
eq('stale conditional put returns null', stale, null);
eq('body unchanged after stale put', await (await r2.get('config.json')).text(), '{"v":2}');

summary('w10/functional/r2-conditionals');
