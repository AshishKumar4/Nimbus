// W12 mock for the DO replica/primary fork.
//
// Models the subset of DurableObjectState.storage that W12 cares about:
//   - storage.primary           — undefined on primary, RpcStub-like on replica
//   - storage.enableReplicas()  — wiki SPEC API (returns void; may throw)
//   - storage.configureReadReplication({mode}) — alternate API name
//   - storage.getCurrentBookmark()  — returns string opaque bookmark
//
// Plus minimal storage.kv (get/put), storage.sql (CREATE/SELECT pass-through),
// alarm stubs, and acceptWebSocket — just enough for NimbusSession's ctor +
// _handleFetch preflight to run end-to-end without touching the real workerd.
//
// The point of these tests is *correctness of replica routing*, not
// SqliteVFS or process-logs round-tripping. So the SQL surface here is
// deliberately thin — anything the replica path doesn't exercise is a
// no-op.

class FakePrimaryStub {
  constructor() {
    this.calls = [];
  }
  async fetch(request) {
    // Capture for assertions. Real RpcStub re-runs the fetch handler on
    // the primary's isolate; here we just record the call and reply with
    // a marker so probes can verify the primary saw it.
    let bodyText = '';
    try { if (request && request.body) bodyText = await request.clone().text(); } catch {}
    const url = (typeof request === 'string') ? request : (request?.url || '');
    const method = (typeof request === 'object' && request?.method) || 'GET';
    this.calls.push({ url, method, bodyText });
    return new Response(JSON.stringify({
      __primary: true,
      url,
      method,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Nimbus-Primary-Handled': '1' },
    });
  }
}

class MockSql {
  constructor() { this._tables = new Map(); this.execLog = []; }
  exec(stmt /* , ...params */) {
    this.execLog.push(stmt.trim());
    return [];
  }
}

class MockStorage {
  constructor(opts = {}) {
    this.sql = new MockSql();
    this.kv = new Map();
    this._opts = opts;
    if (opts.isReplica) {
      this.primary = new FakePrimaryStub();
    }
    if (opts.bookmark != null) {
      this._bookmark = String(opts.bookmark);
    }
    this._enableReplicasCalled = 0;
    this._configureReadReplicationArgs = null;

    // API surface configurability — probes pick which APIs are present.
    if (!opts.noEnableReplicasApi) {
      this.enableReplicas = () => {
        this._enableReplicasCalled++;
        if (opts.enableReplicasThrows) throw new Error(opts.enableReplicasThrows);
      };
    }
    if (opts.alternateConfigureApi) {
      this.configureReadReplication = (args) => {
        this._configureReadReplicationArgs = args;
        if (opts.configureThrows) throw new Error(opts.configureThrows);
      };
    }
    if (opts.bookmark != null) {
      this.getCurrentBookmark = () => this._bookmark;
    }
  }
  async put(k, v) { this.kv.set(k, v); }
  async get(k) { return this.kv.get(k); }
  async delete(k) { return this.kv.delete(k); }
  transactionSync(fn) { return fn(); }
  async setAlarm(_t) {}
  async getAlarm() { return null; }
  async deleteAlarm() {}
}

class MockCtx {
  constructor(opts = {}) {
    this.storage = new MockStorage(opts);
    this._opts = opts;
    this._waitUntilPromises = [];
    this._acceptedSockets = [];
    this.id = { name: opts.idName || 'test-session', toString() { return 'mock-id'; } };
  }
  waitUntil(p) { this._waitUntilPromises.push(p); }
  acceptWebSocket(ws, tags) { this._acceptedSockets.push({ ws, tags }); }
  setWebSocketAutoResponse() {}
  setHibernatableWebSocketEventTimeout() {}
  abort() {}
  blockConcurrencyWhile(fn) { return fn(); }
}

export function makePrimaryCtx(opts = {}) {
  return new MockCtx({ ...opts, isReplica: false });
}
export function makeReplicaCtx(opts = {}) {
  return new MockCtx({ ...opts, isReplica: true });
}
export function makeUnsupportedCtx(opts = {}) {
  // Pre-GA runtime: no enableReplicas, no configureReadReplication, no primary.
  return new MockCtx({ ...opts, isReplica: false, noEnableReplicasApi: true });
}
export { MockCtx, MockStorage, FakePrimaryStub };
