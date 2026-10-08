// What Node 22.22.3 says of a TypeScript file it will not run, and the module
// that says it when the file is required or imported. Kept apart from
// typescript-strip.ts, which loads amaro, so that a session never bundles it.
import { unknownFileExtensionMessage } from '../_shared/esm-resolver.js';
/** What Node's ES loader says of TypeScript it does not take (`--no-experimental-strip-types`). */
export function unknownExtensionRefusal(path) {
    return {
        code: 'ERR_UNKNOWN_FILE_EXTENSION',
        message: unknownFileExtensionMessage(path),
        filename: path, startLine: 0, snippet: '',
    };
}
/** The refusal of a file under node_modules, which Node does not strip. */
export function nodeModulesRefusal(path) {
    return {
        code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
        message: `Stripping types is currently unsupported for files under node_modules, for "${path}"`,
        filename: path, startLine: 0, snippet: '',
    };
}
/**
 * The module of a TypeScript file Node refuses: requiring or importing it
 * throws Node's error, with amaro's snippet before its stack where it shows
 * the place, and no arrow of the generated code (node-shims.ts
 * __nimbusGeneratedNodeError).
 */
export function typeScriptRefusalShim(refusal) {
    const Base = refusal.code === 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' ? 'Error'
        : refusal.code === 'ERR_UNKNOWN_FILE_EXTENSION' ? 'TypeError' : 'SyntaxError';
    const decoration = refusal.snippet === '' ? null : `${refusal.filename}:${refusal.startLine}\n${refusal.snippet}`;
    return `throw __nimbusNodeError(${Base}, ${JSON.stringify(refusal.code)}, ${JSON.stringify(refusal.message)}, undefined, ${JSON.stringify(decoration)});\n`;
}
