const DEFAULT_COMPAT_DATE = '2025-06-01';
export function generateWorkerSource(fnSource, opts) {
    const lines = [
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        '',
    ];
    if (opts?.context) {
        for (const [key, value] of Object.entries(opts.context)) {
            lines.push(`const ${key} = ${JSON.stringify(value)};`);
        }
        lines.push('');
    }
    lines.push(`const __fn__ = ${fnSource};`);
    lines.push('');
    const callExpr = opts?.passEnv
        ? '__fn__(...args, this.env)'
        : '__fn__(...args)';
    lines.push('export default class extends WorkerEntrypoint {', '  execute(...args) {', `    const result = ${callExpr};`, '    // Transparently await async/promise-returning functions.', '    if (result instanceof Promise) {', '      return result;', '    }', '    return result;', '  }', '}');
    return lines.join('\n');
}
export function buildWorkerCode(fnSource, opts, sourceOpts) {
    const moduleSource = generateWorkerSource(fnSource, sourceOpts);
    const code = {
        compatibilityDate: opts?.compatibilityDate ?? DEFAULT_COMPAT_DATE,
        compatibilityFlags: opts?.compatibilityFlags,
        mainModule: 'worker.js',
        modules: {
            'worker.js': moduleSource,
        },
        env: opts?.env,
    };
    // WorkerCode.globalOutbound: omitted = inherit, null = sandboxed, ServiceStub = redirect.
    // Distinguish explicit `{ globalOutbound: undefined }` (inherit) from key-absent (sandbox).
    if (opts && 'globalOutbound' in opts) {
        if (opts.globalOutbound !== undefined) {
            code.globalOutbound = opts.globalOutbound;
        }
        // else: explicitly undefined — omit key to inherit parent network
    }
    else {
        code.globalOutbound = null;
    }
    return code;
}
