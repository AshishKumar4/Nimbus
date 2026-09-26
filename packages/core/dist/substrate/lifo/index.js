// Kernel
export { Kernel } from './kernel/index.js';
// Network Stack
export { NetworkStack } from './kernel/network/index.js';
// Tunnels
export { VETHPair } from './kernel/network/tunnel/VETHPair.js';
export { WebSocketTunnel } from './kernel/network/tunnel/WebSocketTunnel.js';
// Bridge
export { Bridge } from './kernel/network/Bridge.js';
// Filesystem: the namespace is core/src/vfs (CompositeVFS), bound by ProcessFiles.
export { getMimeType, getFileCategory, isBinaryMime } from './utils/mime.js';
// Commands
export { CommandRegistry, createDefaultRegistry } from './commands/registry.js';
// Factory commands
export { createPsCommand } from './commands/system/ps.js';
export { createTopCommand } from './commands/system/top.js';
export { createKillCommand } from './commands/system/kill.js';
export { createWatchCommand } from './commands/system/watch.js';
export { createHelpCommand } from './commands/system/help.js';
export { createNodeCommand } from './commands/system/node.js';
export { createCurlCommand } from './commands/net/curl.js';
export { createTunnelCommandV2 } from './commands/net/tunnel-v2.js';
export { createIfconfigCommand } from './commands/net/ifconfig.js';
export { createRouteCommand } from './commands/net/route.js';
export { createNetstatCommand } from './commands/net/netstat.js';
export { createHostCommand } from './commands/net/host.js';
export { createIPCommand } from './commands/net/ip.js';
export { createLifoPkgCommand, rehydrateGlobalPackages } from './commands/system/lifo.js';
export { NPM_VERSION, createNpmCommand, createNpxCommand } from './commands/system/npm.js';
// Shell
export { Shell } from './shell/Shell.js';
export { JobTable } from './shell/jobs.js';
export { ProcessRegistry } from './shell/ProcessRegistry.js';
export { lex } from './shell/lexer.js';
export { parse, ParseError } from './shell/parser.js';
export { TokenKind } from './shell/types.js';
export { HeadlessTerminal } from './sandbox/HeadlessTerminal.js';
// Lifo runtime
export { createLifoCommand, readLifoManifest, registerLifoWasmModule } from './pkg/lifo-runtime.js';
export { linkPackage, unlinkPackage, loadDevLinks } from './pkg/lifo-dev.js';
// Node compatibility
export { createModuleMap, ProcessExitError } from './node-compat/index.js';
export { Buffer } from './node-compat/buffer.js';
// Path utilities
export { resolve, dirname, join, normalize, basename, extname } from './utils/path.js';
