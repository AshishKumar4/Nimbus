/**
 * git/pack/remote-failure.ts — a git server that could not be reached, or
 * refused, as git says it (remote-curl.c discover_refs and run_slot, http.c
 * handle_curl_result).
 *
 * The facet records what failed (remoteFailureOf): for the discovery, the
 * transport (no answer), or the HTTP status the server answered with, and
 * the text it sent with it when that is plain text; for the request for the
 * pack (git's RPC, a POST), the status or the transport alone, its body
 * never read, as git discards it. Every failing answer is taken in by one
 * capture (answeredFailure). The command says it in git's words, the
 * credentials it offered taken out (remoteFailureText), and exits as git
 * does (128; a pull, whose fetch is git's child, 1).
 */
/** Why a request to the git server failed. */
export type RemoteFailure = 
/** No answer: the connection, DNS, TLS or the stream failed. `detail` says how. */
{
    kind: 'transport';
    detail: string;
}
/** An answer with a failing status; `message` is its body when that is text/plain (show_http_message). */
 | {
    kind: 'status';
    status: number;
    message?: string;
}
/** The request for the pack failed: the status it was answered with (null: no answer), and curl's words for it. */
 | {
    kind: 'rpc';
    status: number | null;
    detail: string;
};
/** Which request failed: the discovery (GET info/refs), or the request for the pack (a POST, git's RPC). */
export type RemoteRequest = 'discovery' | 'rpc';
/** A failure the server answered: its status. */
type AnsweredFailure = Exclude<RemoteFailure, {
    kind: 'transport';
}>;
/**
 * transport_anonymize_url: `url` without the user name and password its
 * authority may carry.
 */
export declare function anonymizeUrl(url: string): string;
/** The credentials a request offered: the user name (git's prompt names it), and whether a password (or token) came with it. */
export interface OfferedCredentials {
    username: string;
    password: boolean;
}
/** The user name and password a URL's authority carries ('' for none). */
export declare function urlCredentials(url: string): {
    username: string;
    password: string;
};
/** A URL's credentials form one pair and take precedence over the caller's pair, as git's transport does. */
export declare function selectRemoteCredentials(url: string, supplied?: ReturnType<typeof urlCredentials>): ReturnType<typeof urlCredentials>;
/**
 * `text` (what a server sent, to be printed) with the credentials it may
 * echo taken out: each URL's user name and password, and every secret
 * offered (a password, a token) wherever it appears.
 */
export declare function redactCredentials(text: string, secrets: readonly string[]): string;
/**
 * git's lines for `failure` of the repository at `url` (as configured or
 * given), `credentials` what the request offered: the server's plain-text
 * message as `remote:` lines (credentials and `secrets` taken out), then
 * git's own.
 */
export declare function remoteFailureText(url: string, failure: RemoteFailure, credentials: OfferedCredentials, secrets?: readonly string[]): string;
/** What git says of a remote that names neither a configured remote nor a repository (transport.c, connect.c). */
export declare function noSuchRemoteText(remote: string): string;
/**
 * The failure an answer with a failing `status` is, its body read or let
 * go: a discovery's message is its body's first MESSAGE_BYTES when that is
 * text/plain; the request for the pack's body is never read (rpc_in).
 */
export declare function answeredFailure(request: RemoteRequest, status: number, contentType: string | null | undefined, body: AsyncIterable<Uint8Array> | null | undefined): Promise<AnsweredFailure>;
/** No answer to `request`: the transport's words for why. */
export declare function transportFailure(request: RemoteRequest, detail: string): RemoteFailure;
/**
 * What `error`, the facet's failure, says failed at the git server: an
 * UploadPackError's (Nimbus's requests: upload-pack.ts, receive-pack.ts);
 * undefined when it is not the server's failure.
 */
export declare function remoteFailureOf(error: unknown): RemoteFailure | undefined;
export {};
//# sourceMappingURL=remote-failure.d.ts.map