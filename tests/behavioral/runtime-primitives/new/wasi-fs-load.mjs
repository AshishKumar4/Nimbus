// A WASI process that reads and writes a lot: its store is bounded
// (WASI_RESIDENT_STORE_BYTES) beside the guest's own memory in a 128 MiB
// isolate. Each step must finish with the right answer, timed by the client.
// FILES stays under what one facet invocation may ask of the session: every
// call that reaches it is a subrequest, and 3,000 files (about 4 calls each)
// ran out of them on main and on this branch alike (f1357, f1426).
import { mintSession, deleteSession, Terminal, stripAnsi, makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('wasi-fs-load');
const sid = await mintSession();
const t = new Terminal(sid);
const step = async (label, cmd, timeout = 900_000) => {
  const started = Date.now();
  const r = await t.run(cmd, timeout);
  const out = stripAnsi(r.output).replace(/\s+$/, '');
  console.log(JSON.stringify({ label, wallMs: Date.now() - started, out: out.slice(-300) }));
  return out;
};
const FILES = Number(process.env.FILES ?? 800);
const script = `
import os, sys, hashlib, importlib
mods = ['json', 'email.parser', 'http.client', 'xml.dom.minidom', 'asyncio', 'unittest', 'argparse', 'decimal',
        'difflib', 'csv', 'pathlib', 'tarfile', 'zipfile', 'logging.handlers', 'urllib.request', 'html.parser']
for m in mods: importlib.import_module(m)
os.makedirs('many', exist_ok=True)
for i in range(${FILES}):
    with open(f'many/f{i:04d}.txt', 'w') as f: f.write(str(i) * 1000)
total = 0
for name in sorted(os.listdir('many')): total += len(open('many/' + name).read())
big = os.urandom(6 * 1024 * 1024)
with open('big.bin', 'wb') as f: f.write(big)
digests = {hashlib.sha256(open('big.bin', 'rb').read()).hexdigest() for _ in range(5)}
print('modules', len(mods), 'files', len(os.listdir('many')), 'chars', total, 'big-ok', digests == {hashlib.sha256(big).hexdigest()})
`;
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await step('install', 'nimbus install python 2>&1 | tail -1', 900_000);
  await step('write load.py', `cat > load.py <<'EOF'\n${script}\nEOF`);
  const expectedChars = Array.from({ length: FILES }, (_, i) => String(i).length * 1000).reduce((x, y) => x + y, 0);
  for (let i = 1; i <= 2; i++) {
    const out = await step(`python load.py #${i}`, 'python3 load.py; echo RC=$?');
    a.check(`load.py #${i} answered right`, out.includes(`modules 16 files ${FILES} chars ${expectedChars} big-ok True`) && out.includes('RC=0'), out.slice(-300));
  }
  const last = `many/f${String(FILES - 1).padStart(4, '0')}.txt`;
  const counted = await step('shell sees the files', `find many -type f | wc -l; wc -c < ${last}; wc -c < big.bin`);
  a.check('the shell sees every file the run wrote', new RegExp(`\\b${FILES}\\b`).test(counted) && counted.includes(String(String(FILES - 1).length * 1000)) && counted.includes('6291456'), counted);
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const { fail } = a.summary();
process.exit(fail > 0 ? 1 : 0);
