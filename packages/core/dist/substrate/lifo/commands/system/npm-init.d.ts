/**
 * npm-init.ts — the package.json `npm init` writes: npm 10.9.8's, as its
 * init-package-json 7.0.2 builds it with every prompt at its default
 * (lib/default-input.js under `yes`, which npm also takes when stdin is not a
 * terminal), assigned over the package.json that is there, then the
 * @npmcli/package-json normalize steps init asks for (bin, gypfile, serverjs,
 * scriptpath, fillTypes) and the normalize-package-data fixes a new
 * package's fields reach (keywords, name, version, repository with the
 * bugs and homepage a hosted one has). It is written in the file's own
 * indent and line ending (json-parse-even-better-errors), and npm's message
 * says so.
 *
 * Named limits: npm's init.* and scope configs are at their defaults (none is
 * read), and normalize-package-data's other fixes of a package.json that was
 * already there are not made.
 */
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
/** What `npm init` writes in `dir`: the file, its text, and what npm prints. */
export declare function npmInitPackage(vfs: VFS, dir: string): Promise<{
    path: string;
    text: string;
    message: string;
}>;
//# sourceMappingURL=npm-init.d.ts.map