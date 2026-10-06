// The parent worker of build-facet-isolation-workerd.mjs: Durable Objects
// that build through their own build facet (and esbuild facet), as a session
// does, in one workerd process, so their facets share the facets' isolates.
// Bundled by the test with esbuild (keepNames, as wrangler bundles the
// worker); `GET /call?object=&method=&args=` calls one object's method.
// The test gives the build facet a `stats()` (its lanes, calls and binding
// memory), read through `facetStats`. The lanes probe is a facet of its own
// on the staged loader's callLanes, shared by every object's probe the way
// the build facet is: `probeHold` holds a lane open with a plugin of the
// object's, and another object's `probeDeliver` calls that plugin, from a
// job posted to that lane or directly.

import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { BUILD_FACET_WORKER_ID, buildFacetPrebundler, loadBuildFacet, rolldownBuildHost } from '../../../packages/worker/src/facets/build-facet.ts';
import { esbuildBuildFallbackHost, esbuildStackFallbackHost } from '../../../packages/worker/src/facets/esbuild-transform.ts';
import { NAPI_WASM_LOADER, fetchStagedBindingAsset } from '../../../packages/worker/src/runtime/staged-bindings.ts';

const LANES_PROBE = [
  'import { DurableObject } from "cloudflare:workers";',
  'import { AsyncLocalStorage } from "node:async_hooks";',
  'import { callLanes } from "napi-wasm-loader.js";',
  'const lanes = callLanes(AsyncLocalStorage);',
  'const held = new Map();',
  'export class LanesProbe extends DurableObject {',
  '  #calls = lanes.instance(String(this.ctx.id));',
  '  hold(key, plugin) {',
  '    return this.#calls.run(() => new Promise((resolve, reject) => held.set(key, { lane: lanes.current(), plugin, resolve, reject })));',
  '  }',
  '  deliver(key, direct) {',
  '    const hold = held.get(key);',
  '    if (!hold) return "not held";',
  '    held.delete(key);',
  '    const call = () => hold.plugin.ping().then(hold.resolve, hold.reject);',
  '    if (!direct) return lanes.post(hold.lane, call) ? "posted" : "refused";',
  '    try { call(); } catch (error) { hold.reject(error); }',
  '    return "called here";',
  '  }',
  '}',
].join('\n');

/** What the lanes probe's holder answers with, from wherever its plugin is called. */
class ProbePlugin extends RpcTarget {
  constructor(private readonly tag: string) {
    super();
  }
  ping(): string {
    return `pong ${this.tag}`;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BuildOptions {
  /** Every module imported by the entry (else a chain: each imports the next). */
  fanout?: boolean;
  /** Each module's read waits this long. */
  slowMs?: number;
  /** This module's read fails at once. */
  failAt?: number;
  /** The object resets itself (ctx.abort) this long into the build. */
  abortAfterMs?: number;
  /** Builds on the esbuild facet instead of the build facet. */
  esbuild?: boolean;
}

/** `modules` modules under /home/user/<tag>/src: m0 is the entry. */
function project(tag: string, modules: number, fanout: boolean): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < modules; i++) {
    let source: string;
    if (fanout && i === 0) {
      const names = Array.from({ length: modules - 1 }, (_, k) => `v${k + 1}`);
      source = names.map((name, k) => `import { v as ${name} } from './m${k + 1}.js';\n`).join('')
        + `export const v = [${JSON.stringify(tag + 0)}, ${names.join(', ')}].join('');\n`;
    } else if (!fanout && i + 1 < modules) {
      source = `import { v as w } from './m${i + 1}.js';\nexport const v = ${JSON.stringify(tag + i)} + w;\n`;
    } else {
      source = `export const v = ${JSON.stringify(tag + i)};\n`;
    }
    files.set(`home/user/${tag}/src/m${i}.js`, encoder.encode(source));
  }
  return files;
}

export class Workspace extends DurableObject {
  /** Reads a build asked for after it returned, by tag. */
  private late = new Map<string, number>();

  async build(tag: string, modules: number, options: BuildOptions = {}) {
    const started = Date.now();
    const files = project(tag, modules, options.fanout === true);
    let returned = false;
    const strip = (p: string) => p.replace(/^\/+/, '');
    const isDirectory = (p: string) => !files.has(strip(p)) && [...files.keys()].some((k) => k.startsWith(strip(p).replace(/\/+$/, '') + '/'));
    const read = async (p: string) => {
      if (returned) this.late.set(tag, (this.late.get(tag) ?? 0) + 1);
      if (options.failAt !== undefined && strip(p).endsWith(`/m${options.failAt}.js`)) throw new Error(`m${options.failAt} cannot be read`);
      if (options.slowMs) {
        const waited = Promise.withResolvers<void>();
        setTimeout(waited.resolve, options.slowMs);
        await waited.promise;
      }
      const bytes = files.get(strip(p));
      if (!bytes) throw new Error(`ENOENT: ${p}`);
      return bytes;
    };
    const vfs = {
      exists: (p: string) => files.has(strip(p)) || isDirectory(p),
      isDirectory,
      readFile: read,
      readFileString: async (p: string) => decoder.decode(await read(p)),
    };
    const buildHost = options.esbuild ? esbuildBuildFallbackHost(this.ctx, this.env) : rolldownBuildHost(this.ctx, this.env);
    const service = new EsbuildService(vfs, { buildHost });
    if (options.abortAfterMs !== undefined) setTimeout(() => this.ctx.abort(new Error('reset by the test')), options.abortAfterMs);
    try {
      const result = await service.build([`/home/user/${tag}/src/m0.js`], { bundle: true, format: 'esm' });
      const text = result.outputFiles[0].contents;
      const ok = Array.from({ length: modules }, (_, i) => tag + i).every((value) => text.includes(JSON.stringify(value)));
      return { ok, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: String((error as Error)?.message ?? error).slice(0, 400) };
    } finally {
      returned = true;
    }
  }

  /** Reads `tag`'s build asked for after it returned. */
  lateReads(tag: string): number {
    return this.late.get(tag) ?? 0;
  }

  /** A pre-bundle of a package of `modules` modules (a chain of relative imports) on the build facet. */
  async prebundle(tag: string, modules: number) {
    const started = Date.now();
    const root = `/home/user/${tag}/node_modules/pkg`;
    const slice: Array<{ path: string; isDir: true } | { path: string; isDir: false; bytes: Uint8Array }> = [
      { path: root, isDir: true },
      { path: `${root}/package.json`, isDir: false, bytes: encoder.encode(JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', exports: './m0.js' })) },
    ];
    for (let i = 0; i < modules; i++) {
      const next = i + 1 < modules ? `import { v as w } from './m${i + 1}.js';\n` : 'const w = "";\n';
      slice.push({ path: `${root}/m${i}.js`, isDir: false, bytes: encoder.encode(`${next}export const v = ${JSON.stringify(tag + i)} + w;\n`) });
    }
    try {
      const result = await buildFacetPrebundler(this.ctx, this.env)({
        specifier: 'pkg', entryPath: `${root}/m0.js`, externals: [], slice, bundlerVersion: 'build-facet-isolation-workerd',
      });
      const ok = result.ok && Array.from({ length: modules }, (_, i) => tag + i).every((value) => result.esmCode.includes(JSON.stringify(value)));
      return { ok, ms: Date.now() - started, ...(result.ok ? {} : { error: result.errorText }) };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: String((error as Error)?.message ?? error).slice(0, 400) };
    }
  }

  /** The build facet's own count of its lanes, calls in flight and binding memory. */
  async facetStats() {
    await loadBuildFacet(this.ctx, this.env);
    const facets = (this.ctx as unknown as { facets: { get(name: string, make: () => never): { stats(): Promise<unknown> } } }).facets;
    return facets.get(`${BUILD_FACET_WORKER_ID}:g0`, () => {
      throw new Error('no build facet');
    }).stats();
  }

  private lanesProbe() {
    const env = this.env as { LOADER: { get(id: string, code: () => Promise<unknown>): { getDurableObjectClass(name: string): unknown } } };
    const worker = env.LOADER.get(`lanes-probe:${NAPI_WASM_LOADER.sha256.slice(0, 16)}`, async () => ({
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: [...GUEST_COMPAT_FLAGS],
      mainModule: 'probe.js',
      modules: {
        'probe.js': LANES_PROBE,
        'napi-wasm-loader.js': new TextDecoder().decode(await fetchStagedBindingAsset(this.env as never, NAPI_WASM_LOADER)),
      },
      globalOutbound: null,
    }));
    const facets = (this.ctx as unknown as { facets: { get(name: string, make: () => Promise<unknown>): { hold(key: string, plugin: ProbePlugin): Promise<string>; deliver(key: string, direct: boolean): Promise<string> } } }).facets;
    return facets.get('lanes-probe', async () => ({ class: worker.getDurableObjectClass('LanesProbe') }));
  }

  /** Holds a lane of this object's probe open until another object calls `tag`'s plugin for it. */
  async probeHold(key: string, tag: string) {
    try {
      return { ok: true, said: await this.lanesProbe().hold(key, new ProbePlugin(tag)) };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 400) };
    }
  }

  /** Calls the plugin `key`'s holder gave, from a job posted to its lane or (`direct`) here. */
  probeDeliver(key: string, direct: boolean) {
    return this.lanesProbe().deliver(key, direct);
  }

  /** `modules` TypeScript modules transformed on the esbuild facet in one batch. */
  async transforms(tag: string, modules: number) {
    const started = Date.now();
    const requests = Array.from({ length: modules }, (_, i) => ({
      code: `export const v${i}: string = ${JSON.stringify(tag + i)};`,
      options: { loader: 'ts' as const, format: 'esm' as const },
    }));
    try {
      const outcomes = await esbuildStackFallbackHost(this.ctx, this.env)(requests);
      const bad = outcomes.findIndex((outcome, i) => !('code' in outcome) || !outcome.code.includes(JSON.stringify(tag + i)));
      return bad < 0 ? { ok: true, ms: Date.now() - started } : { ok: false, ms: Date.now() - started, error: JSON.stringify(outcomes[bad]).slice(0, 400) };
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: String((error as Error)?.message ?? error).slice(0, 400) };
    }
  }
}

interface Env {
  WS: DurableObjectNamespace<Workspace>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ready') return new Response('ready');
    if (url.pathname !== '/call') return new Response('not found', { status: 404 });
    const object = env.WS.get(env.WS.idFromName(url.searchParams.get('object') ?? ''));
    const method = url.searchParams.get('method') as 'build' | 'prebundle' | 'transforms' | 'lateReads' | 'facetStats' | 'probeHold' | 'probeDeliver';
    const args = JSON.parse(url.searchParams.get('args') ?? '[]');
    try {
      return Response.json(await (object[method] as (...a: unknown[]) => Promise<unknown>)(...args));
    } catch (error) {
      return Response.json({ ok: false, thrown: String((error as Error)?.message ?? error).slice(0, 400) });
    }
  },
};
