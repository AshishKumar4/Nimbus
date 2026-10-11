// The harness models a native socket close, not an RPC promise cancellation.
export class HostWatchSocket extends EventTarget {
  constructor() {
    super(); this.readyState = 1;
    /** @type {HostWatchSocket | undefined} */
    this.peer = undefined;
    this.accepted = false;
    /** @type {Event[]} */
    this.pending = [];
  }
  accept() { this.accepted = true; for (const event of this.pending.splice(0)) this.dispatchEvent(event); }
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is closed');
    const event = new MessageEvent('message', { data });
    queueMicrotask(() => { if (this.peer?.accepted) this.peer.dispatchEvent(event); else this.peer?.pending.push(event); });
  }
  close(code = 1000, reason = '') {
    for (const socket of [this, this.peer]) {
      if (!socket || socket.readyState === 3) continue;
      socket.readyState = 3;
      queueMicrotask(() => {
        const event = new Event('close');
        Object.assign(event, { code, reason });
        socket.dispatchEvent(event);
      });
    }
  }
}

const NativeResponse = globalThis.Response;
export function installHostWatchSocket() {
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new HostWatchSocket(); this[1] = new HostWatchSocket();
      this[0].peer = this[1]; this[1].peer = this[0];
    }
  };
  globalThis.Response = class extends NativeResponse {
    static [Symbol.hasInstance](value) { return value instanceof NativeResponse; }
    constructor(body, init) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, 'status', { value: 101 });
      if (init?.webSocket) Object.defineProperty(this, 'webSocket', { value: init.webSocket });
    }
  };
}
