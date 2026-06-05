import type { WorkerCode } from './types.js';

const DEFAULT_COMPAT_DATE = '2025-06-01';

export interface GenerateSourceOptions {
  /**
   * Key/value pairs injected as module-level `const` declarations,
   * so the function body can reference them as if they were in closure scope.
   * Values must be JSON-serializable.
   */
  context?: Record<string, unknown>;

  /** When true, appends `this.env` as the last argument to the user function. */
  passEnv?: boolean;
}

export function generateWorkerSource(
  fnSource: string,
  opts?: GenerateSourceOptions,
): string {
  const lines: string[] = [
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

  lines.push(
    'export default class extends WorkerEntrypoint {',
    '  execute(...args) {',
    `    const result = ${callExpr};`,
    '    // Transparently await async/promise-returning functions.',
    '    if (result instanceof Promise) {',
    '      return result;',
    '    }',
    '    return result;',
    '  }',
    '}',
  );

  return lines.join('\n');
}

export interface WorkerCodeOptions {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  env?: Record<string, unknown>;
  /**
   * Network access: `null` (default) = sandboxed, `undefined` = inherit parent,
   * or a service stub to redirect outbound through.
   */
  globalOutbound?: WorkerCode['globalOutbound'];
}

export function buildWorkerCode(
  fnSource: string,
  opts?: WorkerCodeOptions,
  sourceOpts?: GenerateSourceOptions,
): WorkerCode {
  const moduleSource = generateWorkerSource(fnSource, sourceOpts);

  const code: WorkerCode = {
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
  } else {
    code.globalOutbound = null;
  }

  return code;
}
