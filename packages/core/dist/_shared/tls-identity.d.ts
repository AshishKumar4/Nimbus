/**
 * tls-identity.ts — tls.checkServerIdentity as Node v22.23.4's lib/tls.js
 * makes it (checkServerIdentity, check, splitHost, unfqdn,
 * splitEscapedAltNames), over src/cares_wrap.cc CanonicalizeIP and libuv's
 * inet_pton and inet_ntop (deps/uv/src/inet.c), ported line for line.
 * scripts/bundle-facet-workers.mjs compiles it into the guest's shims
 * (TLS_IDENTITY_PREAMBLE), whose node:tls answers checkServerIdentity with
 * it. workerd's is an older Node's: it matched a host that is an IP address
 * only once IDNA maps it ('127.1') against a certificate for 127.0.0.1, and
 * a DNS name as written rather than in its ASCII form.
 *
 * What lib/tls.js takes from its primordials, and what the binding does in
 * C, runs on the built-ins captured before any program code
 * (primordials.ts); the rest calls the methods a program can replace, as
 * lib/tls.js does. What Node reads from its other modules (lib/internal/net.js
 * isIP, lib/internal/url.js domainToASCII) the caller gives.
 */
/** What checkServerIdentity reads of a peer certificate. */
export interface CertificateNames {
    readonly subject?: {
        readonly CN?: string | string[];
    };
    readonly subjectaltname?: string;
}
/** What lib/tls.js reads from Node's other modules. */
export interface TlsIdentityHost {
    /** lib/internal/net.js isIP: 4, 6, or 0. */
    isIP(input: string): number;
    /** lib/internal/url.js domainToASCII: the ASCII form, or '' for no domain. */
    domainToASCII(domain: string): string;
}
/** tls.checkServerIdentity: undefined when `cert` names `hostname`, else the error that says why. */
export type CheckServerIdentity = (hostname: string, cert: CertificateNames) => Error | undefined;
/** Node's tls.checkServerIdentity, reading isIP and domainToASCII from `host`. */
export declare function createCheckServerIdentity(host: TlsIdentityHost): CheckServerIdentity;
//# sourceMappingURL=tls-identity.d.ts.map