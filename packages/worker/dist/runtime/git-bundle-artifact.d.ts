/**
 * git-bundle-artifact.ts — supervisor-side fetcher for the staged git module
 * the git network facet imports as `git-bundle.js`.
 *
 * scripts/bundle-git.mjs builds one module: vendor/git.generated.mjs, which the
 * supervisor imports, and a byte-identical copy staged under
 * public/_assets/runtime/ for the facet, which only receives modules as source
 * text. Staging keeps that text out of the Worker bundle's size gate.
 */
import { type StagedSourceEnv } from './staged-source.js';
/**
 * The git module's source text for the network facet's `modules` record.
 * Memoized per isolate; a failed fetch clears the memo so the next git
 * operation retries instead of pinning the error.
 */
export declare const fetchGitBundleSource: (env: StagedSourceEnv) => Promise<string>;
//# sourceMappingURL=git-bundle-artifact.d.ts.map