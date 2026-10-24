import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { NamespaceFs, ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
type EditorFs = Pick<NamespaceFs, 'exists' | 'isDirectory' | 'readFile' | 'mkdir' | 'writeFile' | 'readdir'>;
/**
 * The editor pane's views of the session's namespace: `files`, which it
 * reads and saves, and `tree`, which it lists. The tree reads what has
 * landed, so listing a directory a process holds asks the process for nothing.
 */
export declare function editorViews(namespace: ProcessFiles, cred: VfsCred): {
    files: EditorFs;
    tree: EditorFs;
};
/**
 * The frame answering `msg`, computed again once a delegation it meets is
 * recalled (withRecall): the editor's reads and writes wait for a process
 * holding the subtree rather than failing; its listings (`views.tree`, a
 * `landed` view) read what has landed and wait for nothing. Any other
 * failure is the frame's error.
 */
export declare function serveEditorFs(views: {
    files: EditorFs;
    tree: EditorFs;
}, msg: any): Promise<any>;
export {};
//# sourceMappingURL=editor-fs.d.ts.map