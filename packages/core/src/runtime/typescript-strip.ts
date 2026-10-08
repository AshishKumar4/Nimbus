// Node 22.22.3's TypeScript (lib/internal/modules/typescript.js): amaro's strip
// replaces types with whitespace, so lines and columns stay put; its transform
// (--experimental-transform-types) moves code, and with --enable-source-maps
// the result carries its source map. Runs in the transform facet.

import { typeScriptFormat, type PackageType } from './module-format.js';

/** Why Node will not run a TypeScript file; `snippet` (with `filename` and `startLine`) where amaro shows the place. */
export interface TypeScriptRefusal {
  code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' | 'ERR_INVALID_TYPESCRIPT_SYNTAX' | 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' | 'ERR_UNKNOWN_FILE_EXTENSION';
  message: string;
  filename: string;
  startLine: number;
  snippet: string;
}

/** Stripped code and the format Node runs it in, or why Node refuses it. */
export type StrippedTypeScript = { code: string; format: 'module' | 'commonjs' } | { refusal: TypeScriptRefusal };

export interface TypeScriptStripOptions {
  mode: 'strip-only' | 'transform';
  sourceMap: boolean;
}

/** How Node takes a launch's TypeScript: stripped so, or as JavaScript (`--no-experimental-strip-types`). */
export type NodeTypeScript = TypeScriptStripOptions | 'javascript';

// Loaded on the first strip: the esbuild facet runs this runtime too, with no amaro module.
let amaro: Promise<typeof import('amaro')> | null = null;

export async function stripTypeScript(
  code: string, filename: string, { mode, sourceMap }: TypeScriptStripOptions, packageType: PackageType,
): Promise<StrippedTypeScript> {
  const { transformSync } = await (amaro ??= import('amaro'));
  let output: { code: string; map?: string };
  try {
    output = transformSync(code, { mode, filename, sourceMap });
  } catch (error) {
    const swc: Record<string, unknown> = typeof error === 'object' && error !== null ? { ...error } : {};
    const kind = swc.code === 'UnsupportedSyntax' ? 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
      : swc.code === 'InvalidSyntax' ? 'ERR_INVALID_TYPESCRIPT_SYNTAX' : null;
    if (kind === null) throw error;
    return {
      refusal: {
        code: kind,
        message: String(Reflect.get(error as object, 'message')),
        filename: String(swc.filename ?? filename),
        startLine: Number(swc.startLine ?? 1),
        snippet: String(swc.snippet ?? ''),
      },
    };
  }
  const format = typeScriptFormat(filename, () => packageType, () => output.code) ?? 'commonjs';
  if (!output.map) return { code: output.code, format };
  return { code: `${output.code}\n\n//# sourceMappingURL=data:application/json;base64,${base64Utf8(output.map)}`, format };
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
