#!/usr/bin/env bun
/**
 * git-remote-nimbus: worker git/remote-helper.ts as host git runs a remote
 * helper (`nimbus::<path>` URLs), over an engine that does with host git
 * what the GitPackStream engine does over the network: list a repository's
 * refs, write the pack of what is wanted into the fetching repository, take
 * a pushed pack and update refs as receive-pack does (each against the value
 * the push expects). For tests/unit/git-remote-helper-differential.mjs.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runRemoteHelper } from '../../../packages/worker/src/git/remote-helper.ts';

const git = (args, input) => {
  const r = spawnSync('git', args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`);
  return r.stdout;
};
const repoOf = (url) => url.replace(/^nimbus::/, '');

const engine = {
  async listRefs({ url }) {
    const refs = [];
    for (const line of git(['ls-remote', '--symref', repoOf(url)]).toString().split('\n')) {
      if (!line) continue;
      const [value, name] = line.split('\t');
      if (name.endsWith('^{}')) continue;
      if (value.startsWith('ref: ')) refs.push({ name, oid: null, symref: value.slice(5) });
      else refs.push({ name, oid: value });
    }
    return { refs, objectFormat: 'sha1' };
  },
  async fetchPack({ url, gitDir, wants, includeTag, depth }) {
    if (depth !== undefined) throw new Error('this engine fetches whole histories');
    const origin = repoOf(url);
    // What the fetching repository has, so the pack holds only the rest.
    const haves = git(['--git-dir', gitDir, 'for-each-ref', '--format=%(objectname)']).toString().split('\n')
      .filter((oid) => oid && spawnSync('git', ['--git-dir', origin, 'cat-file', '-e', oid]).status === 0);
    const pack = git(['--git-dir', origin, 'pack-objects', '--revs', '--stdout', ...(includeTag ? ['--include-tag'] : [])],
      `${wants.join('\n')}\n${haves.map((h) => `^${h}`).join('\n')}\n`);
    const indexed = git(['--git-dir', gitDir, 'index-pack', '--stdin', '--fix-thin'], pack).toString().trim();
    const objects = Number(git(['--git-dir', origin, 'rev-list', '--objects', '--count', ...wants, ...haves.map((h) => `^${h}`)]).toString().trim());
    return { packName: `pack-${indexed.split(/\s/).at(-1)}`, objects, bytes: pack.byteLength, shallow: false, promisor: false, selfContained: haves.length === 0 };
  },
  async pushPack({ url, commands, pack, atomic }) {
    const origin = repoOf(url);
    if (pack) {
      const bytes = Buffer.from(await new Response(pack).arrayBuffer());
      git(['--git-dir', origin, 'index-pack', '--stdin', '--fix-thin'], bytes);
    }
    const line = (c) => (/^0+$/.test(c.new) ? `delete ${c.ref} ${c.old}\n` : `update ${c.ref} ${c.new} ${c.old}\n`);
    if (atomic) {
      const r = spawnSync('git', ['--git-dir', origin, 'update-ref', '--stdin'], { input: commands.map(line).join('') });
      return { refs: commands.map((c) => (r.status === 0 ? { ref: c.ref, ok: true } : { ref: c.ref, ok: false, reason: 'atomic transaction failed' })) };
    }
    return {
      refs: commands.map((c) => {
        const r = spawnSync('git', ['--git-dir', origin, 'update-ref', '--stdin'], { input: line(c) });
        return r.status === 0 ? { ref: c.ref, ok: true } : { ref: c.ref, ok: false, reason: 'failed to update ref' };
      }),
    };
  },
};

const has = async (gitDir, oids) => new Set(oids.filter((oid) => spawnSync('git', ['--git-dir', gitDir, 'cat-file', '-e', oid]).status === 0));
const packObjects = ({ gitDir, include, exclude }) => {
  const have = exclude.filter((oid) => spawnSync('git', ['--git-dir', gitDir, 'cat-file', '-e', oid]).status === 0);
  const child = spawn('git', ['--git-dir', gitDir, 'pack-objects', '--revs', '--thin', '--stdout', '-q'], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.end(`${include.join('\n')}\n${have.map((h) => `^${h}`).join('\n')}\n`);
  return new ReadableStream({
    start(controller) {
      child.stdout.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      child.stdout.on('end', () => controller.close());
      child.on('error', (error) => controller.error(error));
    },
  });
};

/** Lines of stdin, read as git writes them. */
const lines = (() => {
  let buffered = '';
  let ended = false;
  const waiting = [];
  process.stdin.on('data', (chunk) => { buffered += chunk.toString('utf8'); for (const w of waiting.splice(0)) w(); });
  process.stdin.on('end', () => { ended = true; for (const w of waiting.splice(0)) w(); });
  return async () => {
    for (;;) {
      const at = buffered.indexOf('\n');
      if (at >= 0) { const line = buffered.slice(0, at); buffered = buffered.slice(at + 1); return line; }
      if (ended) return null;
      await new Promise((resolve) => waiting.push(resolve));
    }
  };
})();

const write = (stream) => (text) => new Promise((resolve) => stream.write(text, () => resolve()));
const code = await runRemoteHelper({
  args: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  readLine: lines,
  stdout: write(process.stdout),
  stderr: write(process.stderr),
  readFile: async (path) => { try { return new Uint8Array(await readFile(path)); } catch { return null; } },
}, engine, { has, packObjects });
process.exit(code);
