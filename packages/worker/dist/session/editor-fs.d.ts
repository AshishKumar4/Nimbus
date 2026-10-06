import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
type EditorFs = Pick<CredentialedVfs, 'exists' | 'isDirectory' | 'readFile' | 'mkdir' | 'writeFile' | 'readdir'>;
/**
 * The frame answering `msg`, computed again once a delegation it meets is
 * recalled (withRecall): the editor's reads and writes wait for a command
 * holding the subtree rather than failing. Any other failure is the frame's
 * error.
 */
export declare function serveEditorFs(kernelFs: EditorFs, msg: any): Promise<any>;
export {};
//# sourceMappingURL=editor-fs.d.ts.map