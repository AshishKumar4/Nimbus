/**
 * public-directory-do.ts — the NimbusPublicDirectory Durable Object class.
 *
 * Lives apart from `public-directory.ts` so the session-side helpers and
 * the router-side stub stay importable outside workerd — this file alone
 * needs `cloudflare:workers` for `DurableObject`. The wrangler binding
 * name and migration entry are `NimbusPublicDirectory`.
 */
import { DurableObject } from 'cloudflare:workers';
import { type PublicDirectoryEntry } from './public-directory.js';
export declare class NimbusPublicDirectory extends DurableObject {
    private store;
    bind(capability: string, entry: PublicDirectoryEntry): Promise<void>;
    unbind(capability: string): Promise<void>;
    resolve(capability: string): Promise<PublicDirectoryEntry | null>;
}
//# sourceMappingURL=public-directory-do.d.ts.map