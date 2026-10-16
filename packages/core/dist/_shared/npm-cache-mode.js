/** npm-registry-fetch getCacheMode: offline over prefer-offline over prefer-online. */
export function npmCacheMode(flat) {
    return flat.offline === true ? 'only-if-cached'
        : flat.preferOffline === true ? 'force-cache'
            : flat.preferOnline === true ? 'no-cache'
                : 'default';
}
/** make-fetch-happen's NotCachedError (code ENOTCACHED): `url` read in 'only-if-cached' with no cached copy. */
export function notCachedMessage(url) {
    return `request to ${url} failed: cache mode is 'only-if-cached' but no cached response is available.`;
}
