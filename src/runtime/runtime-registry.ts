/**
 * runtime-registry.ts — shared shell-command factory for runtime
 * dispatchers (node, bun, and future native-WASM / Python / Ruby /
 * AssemblyScript runtimes).
 *
 * Why this exists
 * ───────────────
 * `node` and `bun` shell-command handlers in src/session/init.ts
 * shared ~85% of their code: argv parsing for --version / --help /
 * -e / script-path, VFS lookup, shebang strip, esbuild transform for
 * .ts/.tsx/.jsx, dispatch to the runner. The duplication had drifted
 * — only `node` had the primitive #1 nodeFlagSpan fix
 * (init.ts:233-243), only `node` had primitive-#2 binSpawn ctx
 * propagation (init.ts:391-403), only `bun` had install / run
 * subcommand routing.
 *
 * `buildRuntimeHandler` returns a single shell-handler function that
 * encodes the shared contract. Per-runtime variation is supplied
 * via the `RuntimeSpec` parameter:
 *
 *   - name + version + helpText
 *   - run(): runner fn (runNodeScript / runBunScript / wasm-runner)
 *   - subcommands: optional map of `<verb> → handler` for
 *     bun-style `bun install`, `bun run` (node has none today)
 *   - transform(): optional code rewriter (bun prepends BUN_SHIM_PREAMBLE)
 *   - supportsBinSpawn: true for node (the .bin handler propagates
 *     a callerPid); other runtimes use a plain spawn flow.
 *
 * Anti-requirements observed
 * ──────────────────────────
 *   - NO setTimeout / NO retry / NO defensive-catch added.
 *   - NO behavioral change vs the pre-refactor handlers — every
 *     runtime-specific quirk is preserved exactly.
 *   - Per-runtime test parity: existing primitives-extension probes
 *     (#1 npx / #2 .bin) and runtime-pkg probes (G1-G4) MUST still
 *     pass against the refactored handlers — the contract is
 *     observable behaviour, not implementation shape.
 */

import type { FacetManager } from '../facets/manager.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { EsbuildService } from './esbuild-service.js';

/**
 * Result shape that runtime-registry expects from a runner. Mirrors
 * the existing RunFreshResult / RunBunResult shapes — kept narrow so
 * future runtimes don't have to plumb runtime-internal state.
 */
export interface RuntimeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Options the handler passes to the runner. Mirrors RunFreshOpts.
 */
export interface RuntimeRunOpts {
  argv: string[];
  env: Record<string, string> | undefined;
  cwd: string | undefined;
  filename: string;
  dirname: string;
  command: string;
  /** Primitive #1/G4 hooks. node-runner consumes these; other
   *  runtimes ignore them safely. */
  skipSpawn?: boolean;
  callerPid?: number;
}

export interface RuntimeSpec {
  /** Shell-command name: 'node' / 'bun' / 'wasm-runner' / 'python'. */
  name: string;
  /** Output of `<name> --version`. Includes the leading 'v' if the
   *  runtime convention does (Node: 'v20.0.0'; Bun: '1.1.42'). */
  version: string;
  /** Multi-line help text for `<name> --help`. */
  helpText: string;
  /**
   * Runner function. Usually wraps facetMgr.exec / facetMgr.spawn.
   * For native-WASM, this is a thin WebAssembly.instantiate +
   * function-call helper.
   */
  run(facetMgr: FacetManager, code: string, opts: RuntimeRunOpts): Promise<RuntimeRunResult>;
  /**
   * Optional pre-execution code transform. Used by Bun to prepend
   * BUN_SHIM_PREAMBLE; native-WASM runtimes typically skip
   * this entirely and route around the read-script-from-VFS path
   * (see `bypassesScriptRead`).
   */
  transformCode?(code: string, scriptPath: string): string;
  /**
   * Subcommand router. When the first positional arg is a key in
   * this map, the handler is invoked instead of the standard
   * script-execution flow. Used by `bun install`, `bun run <script>`.
   */
  subcommands?: Record<string, (ctx: any, registry: ShellRegistry) => Promise<number>>;
  /**
   * When true, the runtime treats the args list as a binary file
   * path (NOT a JS script). Used by `wasm-runner` — the args[0] is a
   * .wasm path, args[1+] are the function name + integer args.
   * The handler skips the read-and-transform-script flow and calls
   * `run()` with a synthetic empty `code` — runtimes that set this
   * flag implement the actual bytes-load inside their runner.
   */
  bypassesScriptRead?: boolean;
  /**
   * Primitive #1 / G4 — when true, the script-execution branch
   * propagates `ctx.__nimbusBinSpawn` into RuntimeRunOpts. Only
   * `node` enables this; bun's runFresh chain doesn't share PID
   * state with the .bin handler today. Future runtimes set this
   * iff they share the runFresh contract.
   */
  supportsBinSpawn?: boolean;
}

/**
 * Minimal registry shape we depend on. Avoids importing the full
 * @lifo-sh/core type tree (the shell registry's runtime shape is a
 * few methods on a Map-like class).
 */
export interface ShellRegistry {
  resolve(name: string): Promise<any> | any;
}

/**
 * Build a shell-handler function for a runtime. The returned function
 * is the value passed to `registry.register('<name>', handler)`.
 *
 * Captures `vfs`, `facetMgr`, `esbuild`, `getEsbuild` (for lazy init)
 * + the spec. The same factory is used for every runtime; the only
 * runtime-specific code lives in `spec`.
 */
export function buildRuntimeHandler(
  spec: RuntimeSpec,
  ctx0: {
    vfs: SqliteVFS;
    facetMgr: FacetManager;
    /** Lazy esbuild initialiser. Called once per first .ts/.tsx/.jsx
     *  invocation — the host owns the init lifecycle. */
    getEsbuild(): EsbuildService;
    registry: ShellRegistry;
  },
): (ctx: any) => Promise<number> {
  const { vfs, facetMgr, getEsbuild, registry } = ctx0;

  return async function runtimeHandler(ctx: any): Promise<number> {
    const args: string[] = ctx.args || [];
    const name = spec.name;

    // ── Subcommand dispatch ──
    //
    // BEFORE flag-span computation: subcommands like `bun install`
    // have their first positional arg as the verb, NOT a node-style
    // flag. Run the subcommand handler if matched.
    if (spec.subcommands && args.length > 0 && spec.subcommands[args[0]]) {
      return spec.subcommands[args[0]](ctx, registry);
    }

    // ── Flag-span computation (primitive #1) ──
    //
    // Real-Node only treats args UP TO the first non-flag token as
    // CLI flags. Pre-refactor, version/help/eval scanned the entire
    // args array, breaking `node /path/to/tsc --version` (the user's
    // --version was misinterpreted as a node flag).
    let flagSpan = 0;
    while (flagSpan < args.length && args[flagSpan].startsWith('-')) {
      flagSpan++;
      const prev = args[flagSpan - 1];
      // -e / --eval consumes one value; advance past it.
      if ((prev === '-e' || prev === '--eval') && flagSpan < args.length) {
        flagSpan++;
      }
    }
    const flagSlice = args.slice(0, flagSpan);

    // ── --version ──
    if (flagSlice.includes('-v') || flagSlice.includes('--version')) {
      ctx.stdout.write(spec.version + '\n');
      return 0;
    }

    // ── --help ──
    if (flagSlice.includes('--help') || flagSlice.includes('-h')) {
      ctx.stdout.write(spec.helpText);
      if (!spec.helpText.endsWith('\n')) ctx.stdout.write('\n');
      return 0;
    }

    // ── -e / --eval ──
    const evalIdx = flagSlice.indexOf('-e') !== -1
      ? flagSlice.indexOf('-e')
      : flagSlice.indexOf('--eval');
    if (evalIdx !== -1) {
      const code = args[evalIdx + 1];
      if (!code) {
        ctx.stderr.write(`${name}: -e requires an argument\n`);
        return 1;
      }
      const transformed = spec.transformCode ? spec.transformCode(code, '<eval>') : code;
      const result = await spec.run(facetMgr, transformed, {
        argv: args.slice(evalIdx + 2),
        env: ctx.env,
        cwd: ctx.cwd,
        filename: '<eval>',
        dirname: ctx.cwd || '/home/user',
        command: `${name} -e ...`,
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    }

    // ── script path (or .wasm path for bypassesScriptRead) ──
    const scriptIdx = flagSpan;
    const scriptPath = args[scriptIdx];
    if (!scriptPath) {
      ctx.stderr.write(
        `${name}: REPL not supported. Use ${name} -e "code" or ${name} script.${name === 'bun' ? 'js' : 'js'}\n`,
      );
      return 1;
    }

    // Resolve script path against cwd (unless absolute).
    let resolvedPath = scriptPath;
    if (!scriptPath.startsWith('/')) {
      const c = (ctx.cwd || '/home/user').replace(/^\/+/, '');
      resolvedPath = c + '/' + scriptPath;
    } else {
      resolvedPath = scriptPath.replace(/^\/+/, '');
    }

    // `node .` / `bun .` — read package.json main field.
    // Native-WASM runtimes skip this — `wasm-runner .` is meaningless.
    if (!spec.bypassesScriptRead && (scriptPath === '.' || scriptPath === './')) {
      const c = (ctx.cwd || '/home/user').replace(/^\/+/, '');
      const pkgPath = c + '/package.json';
      try {
        const pkg = JSON.parse(vfs.readFileString(pkgPath));
        // bun prefers .module over .main when both exist; node uses .main.
        const main = (name === 'bun' && pkg.module) || pkg.main || 'index.js';
        resolvedPath = c + '/' + main;
      } catch {
        resolvedPath = c + '/index.js';
      }
    }

    // ── bypassesScriptRead branch (wasm-runner) ──
    //
    // The runner takes the path AS-IS (it's a .wasm, not JS source).
    // We don't read or transform here; the runner reads the bytes
    // and instantiates them.
    if (spec.bypassesScriptRead) {
      const filename = '/' + resolvedPath;
      const dirname = filename.includes('/')
        ? filename.substring(0, filename.lastIndexOf('/'))
        : '/';
      // `args.slice(scriptIdx + 1)` are the runner's user args (e.g.
      // [exportName, intArg1, intArg2, ...] for wasm-runner).
      const result = await spec.run(facetMgr, '', {
        argv: args.slice(scriptIdx + 1),
        env: ctx.env,
        cwd: ctx.cwd,
        filename,
        dirname,
        command: `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    }

    // Try common JS extensions if the file doesn't exist verbatim.
    if (!vfs.exists(resolvedPath)) {
      const exts = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];
      for (const ext of exts) {
        if (vfs.exists(resolvedPath + ext)) {
          resolvedPath += ext;
          break;
        }
      }
    }

    let code: string;
    try {
      code = vfs.readFileString(resolvedPath);
    } catch {
      ctx.stderr.write(`${name}: cannot find module '${scriptPath}'\n`);
      return 1;
    }

    // Shebang strip (primitive #1).
    if (code.startsWith('#!')) {
      const nl = code.indexOf('\n');
      code = nl >= 0 ? code.substring(nl + 1) : '';
    }

    // ── ESM-source detection (primitive: type:module entry scripts) ──
    //
    // Nimbus's facet pre-compile loop wraps every entry script in
    // `new Function(...)` which runs it as CJS. A real `node script.js`
    // dispatch honours the nearest package.json's `"type"` field
    // (and the file extension) to decide whether to parse as ESM:
    //
    //   - .mjs  → always ESM
    //   - .cjs  → always CJS
    //   - .js   → ESM iff nearest package.json has "type": "module"
    //
    // Without this, every modern ESM-only npm initialiser
    // (create-vite, create-astro, create-svelte, modern create-*)
    // crashes immediately with "Cannot use import statement outside
    // a module" because their bin entry is `index.js` and the
    // package.json declares `type: module`.
    //
    // We transform to CJS (format: 'cjs') so the facet's `new
    // Function()` runs it as a CJS module body — same path that the
    // bundle's `transformEsmInBundle` (W3.5 Fix B) takes for
    // sub-module ESM files. esbuild's CJS output emits __require /
    // module.exports / exports.X so the facet's pre-compile loop
    // sees ordinary CJS source.
    function isEsmScript(absPath: string, src: string): boolean {
      if (absPath.endsWith('.mjs')) return true;
      if (absPath.endsWith('.cjs')) return false;
      if (!absPath.endsWith('.js')) return false;
      // Walk up dirs looking for the nearest package.json. First one
      // wins (Node spec); we do NOT consult ancestors past it.
      let dir = absPath.replace(/^\/+/, '');
      const slash = dir.lastIndexOf('/');
      dir = slash > 0 ? dir.substring(0, slash) : '';
      const visited = new Set<string>();
      while (dir && !visited.has(dir)) {
        visited.add(dir);
        const pj = dir + '/package.json';
        if (vfs.exists(pj)) {
          try {
            const pkg = JSON.parse(vfs.readFileString(pj));
            return pkg && pkg.type === 'module';
          } catch {
            return false;
          }
        }
        const last = dir.lastIndexOf('/');
        if (last <= 0) break;
        dir = dir.substring(0, last);
      }
      return false;
    }

    const needsEsmTransform =
      resolvedPath.endsWith('.mjs') ||
      (resolvedPath.endsWith('.js') && isEsmScript(resolvedPath, code));

    // esbuild transform for TypeScript / TSX / JSX (both node and bun)
    // AND for ESM `.js` / `.mjs` entry scripts (primitive ESM-detect).
    if (
      resolvedPath.endsWith('.ts') ||
      resolvedPath.endsWith('.tsx') ||
      resolvedPath.endsWith('.jsx') ||
      needsEsmTransform
    ) {
      try {
        const eb = getEsbuild();
        const ext = resolvedPath.split('.').pop()!;
        const loader =
          ext === 'tsx' ? 'tsx' :
          ext === 'jsx' ? 'jsx' :
          ext === 'ts' ? 'ts' :
          'js';
        // Substitute `import.meta.url` at compile-time so esbuild's
        // CJS output doesn't reduce it to `undefined` (its default
        // for unknown import.meta references). The substitution
        // value is a real `file://<absolute-path>` URL — exactly
        // what real Node returns when running this script. Tools
        // that compute `fileURLToPath(import.meta.url)` (create-vite,
        // most modern CLIs) then resolve relative paths against
        // the actual script location.
        //
        // Without this, `create-vite` does
        //   r(import.meta.url) → fileURLToPath(undefined) → throws
        //   → falls into a different code path
        //   → readdirSync(wrong-template-dir) returns []
        //   → "Scaffolding..." but writes no files.
        const absUrl = 'file:///' + resolvedPath.replace(/^\/+/, '');
        const transformed = await eb.transform(code, {
          loader,
          format: 'cjs',
          define: {
            'import.meta.url': JSON.stringify(absUrl),
          },
        });
        code = transformed.code;
      } catch (e: any) {
        ctx.stderr.write(`${name}: transform error for ${scriptPath}: ${e?.message}\n`);
        return 1;
      }
    }

    // Runtime-specific code transform (bun prepends BUN_SHIM_PREAMBLE).
    if (spec.transformCode) code = spec.transformCode(code, resolvedPath);

    const filename = '/' + resolvedPath;
    const dirname = filename.includes('/')
      ? filename.substring(0, filename.lastIndexOf('/'))
      : '/';

    // Primitive #1 / G4 — propagate bin-spawn ctx if the runtime
    // supports it (currently node only).
    const binSpawn = spec.supportsBinSpawn ? (ctx as any).__nimbusBinSpawn : undefined;

    const leadingFlags = args.slice(0, scriptIdx);
    const result = await spec.run(facetMgr, code, {
      argv: [...leadingFlags, filename, ...args.slice(scriptIdx + 1)],
      env: ctx.env,
      cwd: ctx.cwd,
      filename,
      dirname,
      command:
        binSpawn?.command || `${name} ${args.slice(0, scriptIdx + 1).join(' ')}`,
      ...(binSpawn ? { skipSpawn: true, callerPid: binSpawn.callerPid } : {}),
    });
    if (result.stdout) ctx.stdout.write(result.stdout);
    if (result.stderr) ctx.stderr.write(result.stderr);
    return result.exitCode;
  };
}
