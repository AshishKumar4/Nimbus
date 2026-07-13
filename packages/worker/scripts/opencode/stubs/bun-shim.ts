// Nimbus build stub: opencode imports { fileURLToPath, pathToFileURL } (and
// type-only SystemError) from "bun"; on the node/workerd target these come
// from node:url.
export { fileURLToPath, pathToFileURL } from "node:url"
export type SystemError = Error & { code?: string; errno?: number; syscall?: string; path?: string }
// @opentui/solid's build-plugin module reaches this via a type-level import
// chain on the node target; registering Bun plugins is meaningless here.
export const plugin = () => {}
export type BunPlugin = unknown
