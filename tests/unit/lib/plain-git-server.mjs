// Tests that drive the facet's single-stream clone (the cf-git path a server
// without `filter` gets) answer the fast path's discovery here: an upload-pack
// advertisement for any example.invalid URL, offering no filter, so prepare
// declines the fast path and runs the stubbed git bundle.

const encoder = new TextEncoder();
const pkt = (text) => {
  const body = encoder.encode(text);
  return (body.byteLength + 4).toString(16).padStart(4, '0') + text;
};

export function answerPlainDiscovery() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'example.invalid' && url.pathname.endsWith('/info/refs')) {
      const head = '1'.repeat(40);
      const body = pkt('# service=git-upload-pack\n') + '0000' +
        pkt(`${head} HEAD\0multi_ack side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main\n`) +
        pkt(`${head} refs/heads/main\n`) + '0000';
      return new Response(body, { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    }
    return realFetch(input, init);
  };
  return () => { globalThis.fetch = realFetch; };
}
