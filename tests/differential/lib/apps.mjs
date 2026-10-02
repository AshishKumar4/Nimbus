// The framework apps the interpreter is measured on (interpreter-frameworks.mjs,
// interpreter-memory.mjs): how each is scaffolded into the gitignored .cache/,
// how its dev server or build runs, and what of a run is observed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const CACHE = join(REPO, '.cache/interpreter-differential');
export const LIB = fileURLToPath(new URL('./', import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cwd, command) {
  const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, CI: '1', npm_config_yes: 'true' } });
  if (r.status !== 0) throw new Error(`${command} failed in ${cwd}:\n${r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
}

/** GET `path` until its body contains `marker` (a dev server compiles on the first request). */
export async function page(port, path, marker) {
  let last = '';
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(60000) }).then(async (res) => [res.status, await res.text()]).catch((e) => [0, e.message]);
    last = `${r[0]} ${r[1].slice(0, 300)}`;
    if (r[0] === 200 && r[1].includes(marker)) return r[1];
    await sleep(500);
  }
  throw new Error(`no page with ${marker} at ${path}: ${last}`);
}

const VINEXT_FILES = {
  'package.json': JSON.stringify({ name: 'vinext-diff', private: true, type: 'module', dependencies: { vinext: '^1.0.0', vite: '^8.0.0', react: '^19.2.6', 'react-dom': '^19.2.6', '@vitejs/plugin-rsc': '^0.5.34', '@vitejs/plugin-react': '^5.1.4', 'react-server-dom-webpack': '^19.2.6' } }),
  'vite.config.ts': "import { defineConfig } from 'vite';\nimport vinext from 'vinext';\nexport default defineConfig({ plugins: [vinext()] });\n",
  'app/layout.tsx': 'export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html>; }\n',
  'app/page.tsx': 'export default function Page() { return <h1>vinext-differential</h1>; }\n',
};

const ASTRO_PROOF = (marker) => `# Markdown proof\n\n**${marker}**\n`;

/** The apps: how each is made, how it runs, and what of a run is compared. */
export const APPS = {
  astro: {
    make(dir) {
      sh(CACHE, `npm create astro@7 astro -- --template minimal --no-install --no-git --skip-houston --yes`);
      sh(dir, 'npm install');
      writeFileSync(join(dir, 'src/pages/proof.md'), ASTRO_PROOF('differential'));
      writeFileSync(join(dir, 'src/pages/index.astro'), "---\nimport { Content } from './proof.md';\n---\n<html lang=\"en\"><head><title>Astro proof</title></head><body><Content /></body></html>\n");
    },
    // --ignore-lock: Astro's --force would kill whatever process the lock file names.
    serve: (port) => ['node_modules/astro/bin/astro.mjs', 'dev', '--ignore-lock', '--port', String(port)],
    /** The first page render alone. */
    async first(dir, port) {
      writeFileSync(join(dir, 'src/pages/proof.md'), ASTRO_PROOF('differential'));
      return { '/': await page(port, '/', 'differential') };
    },
    async observe(dir, port) {
      const { '/': first } = await this.first(dir, port);
      writeFileSync(join(dir, 'src/pages/proof.md'), ASTRO_PROOF('differential-edited'));
      const edited = await page(port, '/', 'differential-edited');
      writeFileSync(join(dir, 'src/pages/proof.md'), ASTRO_PROOF('differential'));
      return { '/': first, '/ after an edit': edited };
    },
  },
  ajv: {
    make(dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ajv-diff', private: true, dependencies: { ajv: '^8.17.0' } }));
      sh(dir, 'npm install');
    },
  },
  vite: {
    make(dir) {
      sh(CACHE, 'npm create vite@8 vite -- --template react-ts --no-interactive');
      sh(dir, 'npm install');
    },
    build: (out) => ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--emptyOutDir'],
  },
  nuxt: {
    make(dir) {
      sh(CACHE, 'npx --yes nuxi@latest init nuxt -t minimal --no-install --gitInit=false --packageManager=npm');
      sh(dir, 'npm install');
    },
    serve: (port) => ['node_modules/nuxt/bin/nuxt.mjs', 'dev', '--no-fork', '--port', String(port)],
    async observe(dir, port) {
      return { '/': await page(port, '/', '__nuxt') };
    },
  },
  vinext: {
    make(dir) {
      for (const [name, text] of Object.entries(VINEXT_FILES)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      sh(dir, 'npm install');
    },
    serve: (port) => ['node_modules/.bin/vinext', 'dev', '--port', String(port)],
    async observe(dir, port) {
      writeFileSync(join(dir, 'app/page.tsx'), VINEXT_FILES['app/page.tsx']);
      // The inline scripts carry React's development flight data, whose row
      // numbering follows the call stacks it records (interpreter-frameworks.mjs
      // normalize()): the rendered document is compared without them.
      const html = await page(port, '/', 'vinext-differential');
      return { '/': html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>') };
    },
  },
};

/** The app's directory, scaffolded and installed on first use. */
export function ensureApp(name) {
  mkdirSync(CACHE, { recursive: true });
  const dir = join(CACHE, name);
  if (!existsSync(join(dir, 'node_modules'))) {
    rmSync(dir, { recursive: true, force: true });
    APPS[name].make(dir);
  }
  return dir;
}

/**
 * Start the app's dev server under node with `flags`, and run `use(port,
 * server)` against it; the server is stopped afterwards (SIGTERM to the one
 * process started here, then SIGKILL to it if it lingers). `server.pid`
 * is the node process.
 */
export async function withServer(app, dir, port, flags, env, use) {
  // Astro 7 backgrounds its dev server when it sees CI or an agent; these runs need it in the foreground.
  const serverEnv = { ...process.env, ...env };
  for (const name of ['CI', 'AGENT', 'CLAUDECODE', 'OMPCODE']) delete serverEnv[name];
  const child = spawn('node', [...flags, ...app.serve(port)], { cwd: dir, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    return await Promise.race([use(port, child), exited.then(() => { throw new Error(`server exited:\n${output.slice(-3000)}`); })]);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(10000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
