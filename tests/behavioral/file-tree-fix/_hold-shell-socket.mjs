// Runs before shell scripts. Lifecycle events use the shell's on* boundary.
export function holdShellSocket() {
  const Real = window.WebSocket;
  let release;
  let released = new Promise((resolve) => { release = resolve; });
  const held = { sockets: 0, sendsWhileHeld: 0, treeTexts: [] };
  window.__probeHeld = held;
  window.__probeReleaseWs = () => release();
  window.__probeHoldNextWs = () => { released = new Promise((resolve) => { release = resolve; }); };
  function Held(url, protocols) {
    const at = new URL(url, location.href);
    if (!/\/s\/[^/]+\/ws$/.test(at.pathname) || at.search) return new Real(url, protocols);
    held.sockets++;
    let real = null;
    let closed = false;
    const facade = {
      onopen: null, onmessage: null, onclose: null, onerror: null,
      get readyState() { return real ? real.readyState : closed ? Real.CLOSED : Real.CONNECTING; },
      get url() { return url; },
      send(data) {
        if (!real) { held.sendsWhileHeld++; throw new DOMException('Still in CONNECTING state.', 'InvalidStateError'); }
        real.send(data);
      },
      close(code, reason) { if (real) real.close(code, reason); else closed = true; },
    };
    released.then(() => {
      if (closed) return;
      real = new Real(url, protocols);
      for (const type of ['open', 'message', 'close', 'error']) {
        real.addEventListener(type, (event) => facade[`on${type}`]?.call(facade, event));
      }
    });
    return facade;
  }
  Object.assign(Held, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Held.prototype = Real.prototype;
  window.WebSocket = Held;
  let last = null;
  new MutationObserver(() => {
    const text = document.getElementById('treeBody')?.textContent ?? null;
    if (text !== null && text !== last) { last = text; held.treeTexts.push(text); }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}
