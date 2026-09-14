/**
 * public-directory-do.ts — the NimbusPublicDirectory Durable Object class.
 *
 * Lives apart from `public-directory.ts` so the session-side helpers and
 * the router-side stub stay importable outside workerd — this file alone
 * needs `cloudflare:workers` for `DurableObject`. The wrangler binding
 * name and migration entry are `NimbusPublicDirectory`.
 */
import { DurableObject } from 'cloudflare:workers';
import { PublicDirectoryStore, } from './public-directory.js';
export class NimbusPublicDirectory extends DurableObject {
    store = new PublicDirectoryStore(this.ctx);
    bind(capability, entry) { return this.store.bind(capability, entry); }
    unbind(capability) { return this.store.unbind(capability); }
    resolve(capability) { return this.store.resolve(capability); }
}
