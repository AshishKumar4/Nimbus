// The scaffold every wasi/ and wasi-files/ probe shares: a session with a
// terminal in a working directory, one of the hand-assembled wasm fixtures
// staged there, the checks reported through makeAsserter, and the session
// deleted at the end. A probe keeps only what is its own: which fixture,
// what it runs, and what the output must say.
//
// The fixtures are three maps of base64 modules (./_fixtures.mjs,
// ./_fixtures-stream-b.mjs, ../wasi-files/_fixtures.mjs), looked up here by
// name; a name defined twice is refused rather than shadowed.

import { BASE, Terminal, deleteSession, makeAsserter, mintSession, stripAnsi } from '../_driver.mjs';
import { FIXTURES as FILE_FIXTURES } from '../wasi-files/_fixtures.mjs';
import { FIXTURES } from './_fixtures.mjs';
import { STREAM_B_FIXTURES } from './_fixtures-stream-b.mjs';

const ALL_FIXTURES = {};
for (const map of [FIXTURES, STREAM_B_FIXTURES, FILE_FIXTURES]) {
  for (const [name, b64] of Object.entries(map)) {
    if (Object.hasOwn(ALL_FIXTURES, name)) throw new Error(`wasi fixture ${name} is defined twice`);
    ALL_FIXTURES[name] = b64;
  }
}

/** The shell command that writes fixture `name` to `vfsPath` in the session. */
export function writeWasiFixtureCmd(name, vfsPath) {
  const b64 = ALL_FIXTURES[name];
  if (!b64) throw new Error(`unknown wasi fixture: ${name}`);
  return `node -e "require('fs').writeFileSync('${vfsPath}', Buffer.from('${b64}','base64'))"`;
}

/** The last `n` lines of a command's output, ANSI stripped. */
export function tailLines(output, n = 6) {
  return stripAnsi(output).split(/\r?\n/).slice(-n).join('\n');
}

/** Each line of `text`, trimmed. */
export function trimmedLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim());
}

/**
 * Open probe `name`: a fresh session whose terminal is at its prompt in
 * `dir`, with fixture `fixture` (when given) written there as `as`. The
 * session is deleted if opening fails.
 */
export async function openWasiProbe(name, { dir, fixture, as }) {
  const sid = await mintSession();
  console.log(`[${name}] sid=${sid} BASE=${BASE}`);
  const t = new Terminal(sid);
  const a = makeAsserter(name);
  const close = async () => {
    await t.close().catch(() => {});
    const del = await deleteSession(sid, name);
    console.log(`deleteSession: ${del.status}`);
  };
  try {
    await t.connect();
    await t.waitForPrompt(60_000);
    await t.run(`mkdir -p ${dir} && cd ${dir}`, 10_000);
    if (fixture) await t.run(writeWasiFixtureCmd(fixture, as), 30_000);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    sid,
    t,
    /** Print what the probe saw, then check each [label, ok]. */
    report(checks, findings = {}) {
      console.log(JSON.stringify({ probe: name, sid, base: BASE, ...findings }, null, 2));
      const detail = typeof findings.tail === 'string' ? JSON.stringify(findings.tail) : '';
      for (const [label, ok] of checks) a.check(label, Boolean(ok), detail);
    },
    close,
    /** 0 when at least one check ran and none failed. */
    exitCode() {
      const { pass, fail } = a.summary();
      return fail === 0 && pass > 0 ? 0 : 1;
    },
  };
}
