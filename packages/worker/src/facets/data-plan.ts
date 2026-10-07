/**
 * Which file contents a resident node process holds from its first
 * instruction, besides its module map.
 *
 * A synchronous read cannot wait for bytes, so whatever a process reads
 * synchronously has to be in its facet before it runs; the namespace (every
 * name and stat) is always there, content is not. This decides content by
 * rule, from the namespace and the module closure, without reading file
 * contents except a few package.json files:
 *
 *   package-json   every package.json
 *   project        the working tree, minus dependency, VCS and build-cache dirs
 *   convention     config and lockfile names in the working dir and above it
 *   package-data   non-code files under 256 KiB in every package the closure uses
 *   home           $HOME's dot entries (tool config, skills), minus caches
 *   typescript     when the closure has typescript: its lib .d.ts, @types/**,
 *                  and the declaration files of the packages @types depends on
 *   static         what the closure's own code names by a foldable path
 *                  (static-fs-refs.ts), resolved against the namespace:
 *                  under 256 KiB, or any size when the code reads it with
 *                  readFileSync (or a read-only openSync) by that path,
 *                  through any symlinks on it
 *   entries        the entry files the working dir's own dependencies name
 *                  (exports under every condition, module, main, browser),
 *                  under 256 KiB: a dev server reads them synchronously to
 *                  pre-bundle what the app imports (Vite's optimizer reads
 *                  each with readFileSync), and the process never loads them
 *   learned        paths earlier launches of the same package versions missed
 *
 * Code the closure loads is in the module map already; the store adopts a
 * file that is its own module, so it is readable as data too. A file whose
 * module is an emit and that the map does not carry (`codeOnly`: an ES module
 * staged only to run) is planned as any other file is.
 */
import { resolveFile, type RequireFs } from '@nimbus-sh/core/runtime/require-resolution.js';
import type { RuntimeFsBridge } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { StaticFsRefs } from '@nimbus-sh/core/runtime/static-fs-refs.js';

export interface DataPlanEntry { path: string; kind: string; size: number; linkTarget?: string }

export interface DataPlanSource {
  /** One page of the namespace in path order; `next === null` ends it. */
  list(after: string | null): Promise<{ entries: DataPlanEntry[]; next: string | null }>;
  /** A file's text, or null when it cannot be read. */
  readText(path: string): Promise<string | null>;
  /**
   * Where the symlink at a path leads, as the namespace follows it (its
   * stored target, re-rooted on a mount that reads its links from its own
   * root: RuntimeFsBridge.linkLeadsTo), or null when the path is not a symlink.
   */
  linkTarget(path: string): Promise<string | null>;
  /** What is at a path, following symlinks, or null. */
  stat(path: string): Promise<{ kind: string; size: number } | null>;
}

export interface DataPlanInput {
  cwd: string;
  home: string;
  /** Module map paths. */
  closure: Iterable<string>;
  /** Of those, the files the map carries only as their emit, not as themselves. */
  codeOnly?: Iterable<string>;
  refs: readonly StaticFsRefs[];
  /** Paths learned from earlier misses (absolute or keys). */
  learned?: Iterable<string>;
  /** Called with the bytes of each listed page, to pace a long walk. */
  spend?: (units: number) => Promise<void>;
}

export type DataPlanRule =
  | 'package-json' | 'project' | 'convention' | 'package-data' | 'home' | 'typescript' | 'static' | 'entries' | 'learned';

export interface DataPlan {
  paths: string[];
  bytes: number;
  rules: Record<DataPlanRule, { files: number; bytes: number }>;
}

/** Package data this size or larger is a bundle or a binary, not configuration. */
export const PACKAGE_DATA_MAX_BYTES = 256 * 1024;

const CODE_FILE = /\.(?:c|m)?(?:j|t)sx?$|\.map$|\.d\.(?:c|m)?ts$|\.node$|\.wasm$/;
const DECLARATION_FILE = /\.d\.(?:c|m)?ts$/;
/** Directory names whose contents are dependencies, VCS state or regenerable caches. */
const PROJECT_EXCLUDED = new Set([
  'node_modules', '.git', '.hg', '.svn', '.nimbus', '.next', '.nuxt', '.output', '.astro',
  '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.vite', '.vercel', '.wrangler', 'coverage',
]);
/** $HOME-relative caches: package stores and regenerable state, not configuration. */
const HOME_EXCLUDED = [
  '.cache/', '.npm/', '.bun/install/', '.nimbus/', '.pnpm-store/', '.yarn/cache/', '.yarn/berry/', '.node-gyp/',
  '.local/share/pnpm/', '.local/state/',
];
const CONVENTION = [
  /^package\.json$/, /^(?:ts|js)config(?:\..*)?\.json$/, /^\.env(?:\..*)?$/, /^\.npmrc$/, /^\.nvmrc$/,
  /\.config\.(?:c|m)?(?:j|t)s$/, /\.config\.json$/, /^\.[\w-]+rc(?:\.(?:json|js|cjs|mjs|ya?ml|toml))?$/,
  /^(?:package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.package-lock\.json|\.modules\.yaml)$/,
  /^\.browserslistrc$/, /^\.editorconfig$/, /^\.gitignore$/,
];

function key(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function parentOf(k: string): string {
  const i = k.lastIndexOf('/');
  return i < 0 ? '' : k.slice(0, i);
}

function baseOf(k: string): string {
  return k.slice(k.lastIndexOf('/') + 1);
}

/** The package directory a path sits in: up to the name after its last node_modules. */
export function packageRootOf(k: string): string | null {
  const at = k.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const rest = k.slice(at + 'node_modules/'.length).split('/');
  const take = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= take) return null;
  return k.slice(0, at) + 'node_modules/' + rest.slice(0, take).join('/');
}

function joinKey(base: string, rel: string): string {
  const out = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/** One `exports` target: a string, or the first usable branch of a conditions object. */
function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) { const t = exportTarget(v); if (t) return t; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const cond of ['node', 'import', 'module', 'default', 'require']) {
      if (cond in value) { const t = exportTarget((value as Record<string, unknown>)[cond]); if (t) return t; }
    }
  }
  return null;
}

/**
 * Every file a package.json names as an entry, relative to its package:
 * each subpath's `exports` targets under every condition (a dev server
 * resolves for the browser, the process for node), and `module`, `main` and
 * a string `browser`. Subpath patterns name no file until a specifier fills
 * them, so they name none here.
 */
function entryTargets(manifest: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const leaves = (value: unknown) => {
    if (typeof value === 'string') { if (!value.includes('*')) out.add(value); return; }
    if (Array.isArray(value)) { for (const v of value) leaves(v); return; }
    if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v);
  };
  leaves(manifest.exports);
  for (const field of ['module', 'main', 'browser'] as const) {
    if (typeof manifest[field] === 'string') out.add(manifest[field]);
  }
  if (manifest.exports === undefined && manifest.main === undefined) out.add('index.js');
  return [...out];
}

/** Map `./sub` through a package.json `exports` field; null when it does not export it. */
function mapExports(exportsField: unknown, sub: string): string | null {
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    return sub === '.' ? exportTarget(exportsField) : null;
  }
  const table = exportsField as Record<string, unknown>;
  if (!Object.keys(table).some((k) => k.startsWith('.'))) return sub === '.' ? exportTarget(table) : null;
  if (sub in table) return exportTarget(table[sub]);
  let best: { prefix: string; suffix: string; target: unknown } | null = null;
  for (const [pattern, target] of Object.entries(table)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!sub.startsWith(prefix) || !sub.endsWith(suffix) || sub.length < prefix.length + suffix.length) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, suffix, target };
  }
  if (!best) return null;
  const t = exportTarget(best.target);
  if (!t) return null;
  return t.replaceAll('*', sub.slice(best.prefix.length, sub.length - best.suffix.length));
}

/** A directory's package.json, parsed once per plan; null when absent or not JSON. */
async function readManifest(
  source: DataPlanSource,
  dir: string,
  manifests: Map<string, Record<string, unknown> | null>,
): Promise<Record<string, unknown> | null> {
  let manifest = manifests.get(dir);
  if (manifest === undefined) {
    const text = await source.readText(joinKey(dir, 'package.json'));
    try { manifest = text === null ? null : JSON.parse(text) as Record<string, unknown>; } catch { manifest = null; }
    manifests.set(dir, manifest);
  }
  return manifest;
}

async function resolveSpecifier(
  source: DataPlanSource,
  fromDir: string,
  spec: string,
  manifests: Map<string, Record<string, unknown> | null>,
): Promise<string | null> {
  const parts = spec.split('/');
  const nameLen = spec.startsWith('@') ? 2 : 1;
  if (parts.length < nameLen) return null;
  const name = parts.slice(0, nameLen).join('/');
  const sub = parts.slice(nameLen).join('/');
  for (let dir = fromDir; ; dir = parentOf(dir)) {
    if (baseOf(dir) !== 'node_modules') {
      const pkgDir = joinKey(dir, 'node_modules/' + name);
      const manifest = await readManifest(source, pkgDir, manifests);
      if (manifest) {
        const mapped = manifest.exports !== undefined ? mapExports(manifest.exports, sub ? './' + sub : '.') : null;
        if (mapped) return joinKey(pkgDir, mapped);
        return sub ? joinKey(pkgDir, sub) : null;
      }
    }
    if (dir === '') return null;
  }
}

/** The resolver's filesystem (require-resolution.ts) over the plan's source. */
function resolutionFs(source: DataPlanSource): RequireFs {
  return {
    exists: async (path) => (await source.stat(path)) !== null,
    isDirectory: async (path) => (await source.stat(path))?.kind === 'directory',
    readFileString: async (path) => {
      const text = await source.readText(path);
      if (text === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    },
    stat: async (path) => {
      const found = await source.stat(path);
      return found === null ? null : { size: found.size };
    },
  };
}

/**
 * DataPlanSource.linkTarget over a process's bridge: where the symlink at
 * `path` leads as the namespace follows it, or null when it is no link. A
 * missing or unreadable component is not a link: the lookup ends there.
 */
export async function linkTargetOf(fs: Pick<RuntimeFsBridge, 'readlink' | 'linkLeadsTo'>, path: string): Promise<string | null> {
  try {
    const text = await fs.readlink(path);
    return text === null ? null : await fs.linkLeadsTo(path, text);
  } catch {
    return null;
  }
}

/** Symlinks a lookup follows before it gives up (Linux's MAXSYMLINKS). */
const MAX_LINK_HOPS = 40;

/**
 * A key with every symlink along it replaced by its target, as a lookup
 * resolves it, asking the source one component at a time; null past
 * MAX_LINK_HOPS (ELOOP).
 */
async function throughLinks(source: DataPlanSource, k: string): Promise<string | null> {
  let path = k;
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    const segs = path.split('/');
    let followed = false;
    for (let i = 1; i <= segs.length; i++) {
      const at = segs.slice(0, i).join('/');
      const target = await source.linkTarget('/' + at);
      if (target === null) continue;
      const base = target.startsWith('/') ? key(target) : joinKey(parentOf(at), target);
      path = joinKey(base, segs.slice(i).join('/'));
      followed = true;
      break;
    }
    if (!followed) return path;
  }
  return null;
}

/**
 * The plan for one launch. Walks the namespace once, in pages.
 */
export async function planFacetData(source: DataPlanSource, input: DataPlanInput): Promise<DataPlan> {
  const cwd = key(input.cwd);
  const home = key(input.home);
  const cwdPrefix = cwd ? cwd + '/' : '';
  const homeDot = home ? home + '/.' : '.';

  const closureRoots = new Set<string>();
  let typescriptRoot: string | null = null;
  for (const path of input.closure) {
    const root = packageRootOf(key(path));
    if (root === null) continue;
    closureRoots.add(root);
    if (typescriptRoot === null && root.endsWith('node_modules/typescript')) typescriptRoot = root;
  }
  const conventionDirs = new Set<string>([joinKey(cwd, 'node_modules')]);
  for (let d = cwd; ; d = parentOf(d)) { conventionDirs.add(d); if (d === '') break; }
  // What the map holds as the file itself: its paths but the code-only ones.
  const closure = new Set<string>();
  for (const path of input.closure) closure.add(key(path));
  for (const path of input.codeOnly ?? []) closure.delete(key(path));

  // Static references, as keys: each exact path, and whether any site reads
  // it synchronously.
  const exact = new Map<string, boolean>();
  const note = (k: string, sync: boolean) => exact.set(k, exact.get(k) === true || sync);
  const listed = new Set<string>();
  const patterns: { dir: string; prefix: string; suffix: string }[] = [];
  const manifests = new Map<string, Record<string, unknown> | null>();
  for (const refs of input.refs) {
    for (const r of refs.exact) note(key(r.path), r.sync);
    for (const r of refs.cwdRelative) note(joinKey(cwd, r.path), r.sync);
    for (const p of refs.listed) listed.add(key(p));
    for (const p of refs.patterns) patterns.push({ dir: key(p.dir), prefix: p.prefix, suffix: p.suffix });
  }
  const learned = new Set<string>();
  for (const p of input.learned ?? []) learned.add(key(p));

  const rules = Object.fromEntries(
    (['package-json', 'project', 'convention', 'package-data', 'home', 'typescript', 'static', 'entries', 'learned'] as DataPlanRule[])
      .map((r) => [r, { files: 0, bytes: 0 }]),
  ) as DataPlan['rules'];
  const paths: string[] = [];
  const planned = new Set<string>();
  let bytes = 0;
  const take = (entry: DataPlanEntry, rule: DataPlanRule) => {
    if (planned.has(entry.path)) return;
    planned.add(entry.path);
    paths.push(entry.path);
    bytes += entry.size;
    rules[rule].files++;
    rules[rule].bytes += entry.size;
  };

  // Directories a reference expands to: a listed directory.
  const expanded = new Set<string>();
  const underExpanded = (k: string): boolean => {
    for (let d = parentOf(k); d !== ''; d = parentOf(d)) {
      if (expanded.has(d)) return true;
      if (baseOf(d) === 'node_modules') return false;
    }
    return false;
  };
  const homeKept = (k: string) => {
    const rel = k.slice(home ? home.length + 1 : 0) + '/';
    return !HOME_EXCLUDED.some((prefix) => rel.startsWith(prefix));
  };
  /**
   * Whether a file lies in a dependency, VCS or cache directory below `dir`,
   * or in a cache of the home directory it is in ($HOME, or /home/<user>).
   */
  const excludedBelow = (dir: string, k: string): boolean => {
    const rel = k.slice(dir === '' ? 0 : dir.length + 1).split('/');
    if (rel.slice(0, -1).some((seg) => PROJECT_EXCLUDED.has(seg))) return true;
    const segs = k.split('/');
    const userHome = home !== '' && k.startsWith(home + '/') ? home
      : segs[0] === 'home' && segs.length > 2 ? 'home/' + segs[1] : null;
    if (userHome === null) return false;
    const inHome = k.slice(userHome.length + 1) + '/';
    return HOME_EXCLUDED.some((prefix) => inHome.startsWith(prefix));
  };
  /**
   * Whether a file is one a pattern `dir/prefix*suffix` can name. A hole with
   * a known prefix or suffix fills one name in `dir`: a file there, or the
   * files directly in a directory there. A bare hole under a
   * named directory (`join(dir, x)`) may be a relative path of any depth: the
   * directory's files, minus dependency, VCS and cache directories. A bare
   * hole at the root (`'/' + x`) names the whole filesystem, which nothing
   * static bounds: it matches nothing and the read is a run-time one.
   */
  const patternMatch = (k: string): boolean => {
    const dir = parentOf(k);
    const name = baseOf(k);
    for (const p of patterns) {
      if (p.prefix === '' && p.suffix === '') {
        if (p.dir !== '' && k.startsWith(p.dir + '/') && !excludedBelow(p.dir, k)) return true;
        continue;
      }
      const named = (n: string) => n.startsWith(p.prefix) && n.endsWith(p.suffix) && n.length >= p.prefix.length + p.suffix.length;
      if (p.dir === dir && named(name)) return true;
      // A matched name may be a directory the code lists: its own files, one level.
      if (dir !== '' && p.dir === parentOf(dir) && named(baseOf(dir)) && !excludedBelow(p.dir, k)) return true;
    }
    return false;
  };
  const declarations: DataPlanEntry[] = [];
  const packageRoots = new Set<string>();
  // Directories a home or project symlink points at, whose files the rule
  // that took the link would have taken had they been in place.
  const linkedDirs: { target: string; rule: DataPlanRule }[] = [];
  /**
   * A statically named file is worth holding when the module map does not
   * already hold it, and it is data-sized or the code reads it synchronously
   * by that name: such a read cannot wait for bytes of any size. Its bytes
   * count toward the plan's storage, which the launch admits or refuses.
   */
  /** Sync-read paths the walk found as files under their own name. */
  const seenFiles = new Set<string>();
  const staticWorthy = (entry: DataPlanEntry) => !closure.has(entry.path)
    && (entry.size < PACKAGE_DATA_MAX_BYTES || exact.get(entry.path) === true);

  let after: string | null = null;
  for (;;) {
    const page = await source.list(after);
    if (input.spend) await input.spend(page.entries.length * 64);
    for (const raw of page.entries) {
      const k = key(raw.path);
      const entry = { path: k, kind: raw.kind, size: raw.size };
      if (entry.kind === 'directory') {
        if (listed.has(k)) expanded.add(k);
        if (packageRootOf(k + '/x') === k) packageRoots.add(k);
        continue;
      }
      const segs = k.split('/');
      if (entry.kind === 'symlink') {
        if (raw.linkTarget === undefined) continue;
        const inProject = (cwdPrefix === '' || k.startsWith(cwdPrefix))
          && !(cwdPrefix === '' ? segs : k.slice(cwdPrefix.length).split('/')).slice(0, -1).some((x) => PROJECT_EXCLUDED.has(x));
        const inHome = k.startsWith(homeDot) && homeKept(k) && !segs.includes('node_modules');
        if (inProject || inHome) {
          const target = raw.linkTarget.startsWith('/') ? key(raw.linkTarget) : joinKey(parentOf(k), raw.linkTarget);
          linkedDirs.push({ target, rule: inProject ? 'project' : 'home' });
        }
        continue;
      }
      if (entry.kind !== 'file') continue;
      if (exact.get(k) === true) seenFiles.add(k);
      const name = baseOf(k);
      if (name === 'package.json' && !segs.includes('.git')) { take(entry, 'package-json'); continue; }
      if (cwdPrefix === '' || k.startsWith(cwdPrefix)) {
        const rel = cwdPrefix === '' ? segs : k.slice(cwdPrefix.length).split('/');
        if (!rel.slice(0, -1).some((s) => PROJECT_EXCLUDED.has(s))) { take(entry, 'project'); continue; }
      }
      if (conventionDirs.has(parentOf(k)) && CONVENTION.some((re) => re.test(name))) { take(entry, 'convention'); continue; }
      const root = packageRootOf(k);
      if (root !== null && closureRoots.has(root) && !CODE_FILE.test(name) && entry.size < PACKAGE_DATA_MAX_BYTES
        && !k.slice(root.length + 1).includes('node_modules/')) {
        take(entry, 'package-data');
        continue;
      }
      if (k.startsWith(homeDot) && homeKept(k) && !segs.includes('node_modules') && !segs.includes('.git')) {
        take(entry, 'home');
        continue;
      }
      if (typescriptRoot !== null) {
        if (root === typescriptRoot && parentOf(k) === typescriptRoot + '/lib' && /^lib\..*\.d\.ts$/.test(name)) { take(entry, 'typescript'); continue; }
        if (k.includes('node_modules/@types/')) { take(entry, 'typescript'); continue; }
        if (root !== null && DECLARATION_FILE.test(name)) declarations.push(entry);
      }
      if ((exact.has(k) || listed.has(parentOf(k)) || patternMatch(k) || underExpanded(k)) && staticWorthy(entry)) {
        take(entry, 'static');
        continue;
      }
      if (learned.has(k)) { take(entry, 'learned'); continue; }
    }
    if (page.next === null) break;
    after = page.next;
  }

  // What @types depends on (undici-types for @types/node): their declarations.
  if (typescriptRoot !== null && declarations.length > 0) {
    const typeDeps = new Set<string>();
    const typesRoots = new Set<string>();
    for (const p of paths) {
      if (!p.endsWith('/package.json') || !p.includes('node_modules/@types/')) continue;
      const root = packageRootOf(p);
      if (root !== null && root + '/package.json' === p) typesRoots.add(root);
    }
    for (const root of typesRoots) {
      const text = await source.readText(root + '/package.json');
      try {
        const deps = (JSON.parse(text ?? '{}') as { dependencies?: Record<string, string> }).dependencies ?? {};
        for (const dep of Object.keys(deps)) typeDeps.add(dep);
      } catch { /* not a manifest */ }
    }
    for (const entry of declarations) {
      const root = packageRootOf(entry.path)!;
      const name = root.slice(root.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (typeDeps.has(name)) take(entry, 'typescript');
    }
  }

  // A synchronous read of a path through a symlink reads the file the link
  // leads to, which the walk saw under its own name: hold that file. Only
  // such a read's own path is resolved, one component at a time; the
  // namespace's links are never collected.
  for (const [k, sync] of exact) {
    if (!sync || planned.has(k) || seenFiles.has(k)) continue;
    const target = await throughLinks(source, k);
    if (target === null || target === k || planned.has(target)) continue;
    const found = await source.stat(target);
    if (found === null || found.kind !== 'file') continue;
    const entry = { path: target, kind: 'file', size: found.size };
    if (!closure.has(target)) take(entry, 'static');
  }

  // Specifiers resolve through package.json files, so only those whose
  // package exists are looked up.
  for (const refs of input.refs) {
    for (const r of refs.resolves) {
      const name = r.spec.split('/').slice(0, r.spec.startsWith('@') ? 2 : 1).join('/');
      let exists = false;
      for (let d = key(r.from); !exists; d = parentOf(d)) {
        if (packageRoots.has(joinKey(d, 'node_modules/' + name))) exists = true;
        if (d === '') break;
      }
      if (!exists) continue;
      const resolved = await resolveSpecifier(source, key(r.from), r.spec, manifests);
      if (resolved === null || planned.has(resolved)) continue;
      const found = await source.stat(resolved);
      if (found === null || found.kind !== 'file') continue;
      const entry = { path: resolved, kind: 'file', size: found.size };
      if (staticWorthy(entry)) take(entry, 'static');
    }
  }

  // The working dir's dependencies' entries, each the file Node's resolver
  // loads for it (require-resolution.ts, as the module-map walk resolves): a
  // `main` without its extension, or naming a directory with a package.json
  // of its own.
  const files = resolutionFs(source);
  const projectManifest = await readManifest(source, cwd, manifests);
  const dependencies = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const named = projectManifest?.[field];
    if (named && typeof named === 'object') for (const name of Object.keys(named)) dependencies.add(name);
  }
  for (const name of dependencies) {
    let pkgDir: string | null = null;
    for (let d = cwd; pkgDir === null; d = parentOf(d)) {
      if (packageRoots.has(joinKey(d, 'node_modules/' + name))) pkgDir = joinKey(d, 'node_modules/' + name);
      if (d === '') break;
    }
    if (pkgDir === null) continue;
    const manifest = await readManifest(source, pkgDir, manifests);
    if (manifest === null) continue;
    for (const rel of entryTargets(manifest)) {
      const resolved = await resolveFile(files, joinKey(pkgDir, rel));
      const k = resolved === null ? null : await throughLinks(source, resolved);
      if (k === null) continue;
      const found = await source.stat(k);
      if (found === null || found.kind !== 'file') continue;
      if (found.size < PACKAGE_DATA_MAX_BYTES && !closure.has(k)) take({ path: k, kind: 'file', size: found.size }, 'entries');
    }
  }

  // The files behind symlinked directories the project or home rule reached.
  if (linkedDirs.length > 0) {
    after = null;
    for (;;) {
      const page = await source.list(after);
      if (input.spend) await input.spend(page.entries.length * 64);
      for (const raw of page.entries) {
        if (raw.kind !== 'file') continue;
        const k = key(raw.path);
        for (const { target, rule } of linkedDirs) {
          if (k === target || k.startsWith(target + '/')) {
            if (!k.slice(target.length).split('/').some((x) => x === 'node_modules' || x === '.git')) {
              take({ path: k, kind: 'file', size: raw.size }, rule);
            }
            break;
          }
        }
      }
      if (page.next === null) break;
      after = page.next;
    }
  }

  return { paths, bytes, rules };
}
