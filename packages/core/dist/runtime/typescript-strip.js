// Node 22.23.4's TypeScript (lib/internal/modules/typescript.js): amaro's strip
// replaces types with whitespace, so lines and columns stay put; its transform
// (--experimental-transform-types) moves code, and with --enable-source-maps
// the result carries its source map. Runs in the transform facet.
import { typeScriptFormat } from './module-format.js';
import { base64Utf8 } from '../_shared/crypto.js';
// Loaded on the first strip: the esbuild facet runs this runtime too, with no amaro module.
let amaro = null;
export async function stripTypeScript(code, filename, { mode, sourceMap }, packageType) {
    const { transformSync } = await (amaro ??= import('amaro'));
    let output;
    try {
        output = transformSync(code, { mode, filename, sourceMap });
    }
    catch (error) {
        const swc = typeof error === 'object' && error !== null ? { ...error } : {};
        const kind = swc.code === 'UnsupportedSyntax' ? 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
            : swc.code === 'InvalidSyntax' ? 'ERR_INVALID_TYPESCRIPT_SYNTAX' : null;
        if (kind === null)
            throw error;
        return {
            refusal: {
                code: kind,
                message: String(Reflect.get(error, 'message')),
                filename: String(swc.filename ?? filename),
                startLine: Number(swc.startLine ?? 1),
                snippet: String(swc.snippet ?? ''),
            },
        };
    }
    const format = typeScriptFormat(filename, () => packageType, () => output.code) ?? 'commonjs';
    if (!output.map)
        return { code: output.code, format };
    return { code: `${output.code}\n\n//# sourceMappingURL=data:application/json;base64,${base64Utf8(output.map)}`, format };
}
