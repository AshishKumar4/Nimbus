/**
 * _shared/null-body-status.ts — the statuses whose response has no body, as
 * Fetch names them (a "null body status"), for every layer that relays a
 * response into a Response: the Response constructor refuses a body for any
 * of them, an empty one included.
 */
export declare function isNullBodyStatus(status: number): boolean;
//# sourceMappingURL=null-body-status.d.ts.map