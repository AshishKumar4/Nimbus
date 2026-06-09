/**
 * cli/commands/session — `nimbus session new` — mint a session via POST /new.
 *
 * `--token` / `NIMBUS_TOKEN` travels ONLY as `Authorization: Bearer`.
 * The printed attach URL is the server's redirect Location verbatim: on
 * enforced deployments it carries a short-lived single-use bootstrap
 * token (never the caller's long-lived token); on unauthenticated
 * deployments it is the plain `/s/<id>/` URL.
 */
/** Mint a fresh session and print its attach URL. */
export declare function newSession(args: string[]): Promise<number>;
//# sourceMappingURL=session.d.ts.map