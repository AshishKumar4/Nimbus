// A wasm image over bytes a test holds (FacetImage), for tests whose subject
// is not where an image comes from: what a runner's opened file is to a facet
// host, without a filesystem under it. Each is its own image: no two share an
// identity. `reads` counts the host's reads of it.

let held = 0;

export function heldImage(bytes, path = `held-${++held}.wasm`) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const image = {
    path,
    identity: `${path}#${++held}`,
    size: view.byteLength,
    peak: view.byteLength,
    reads: 0,
    async read() {
      image.reads++;
      return view;
    },
  };
  return image;
}
