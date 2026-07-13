// Nimbus build stub: bun:sqlite is unreachable on the node/workerd target —
// opencode's database layer selects the node:sqlite client (sqlite.node.ts),
// which Nimbus bridges to the VFS-backed sql.js shim. Fail loud if anything
// still lands here.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is unavailable on Nimbus (node:sqlite is the supported driver)")
  }
}
export default Database
