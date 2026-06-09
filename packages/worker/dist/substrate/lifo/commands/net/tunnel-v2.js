import { WebSocketTunnel } from '../../kernel/network/tunnel/WebSocketTunnel.js';
import { waitForAbort } from '../signal.js';
function parseArgs(args) {
    let server = 'ws://localhost:3005';
    let port = null;
    let verbose = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help' || args[i] === '-h') {
            return { help: true };
        }
        else if (args[i].startsWith('--server=')) {
            server = args[i].slice('--server='.length);
        }
        else if (args[i] === '--server' && args[i + 1]) {
            server = args[++i];
        }
        else if (args[i].startsWith('--port=')) {
            port = parseInt(args[i].slice('--port='.length), 10);
        }
        else if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
            port = parseInt(args[++i], 10);
        }
        else if (args[i] === '-v' || args[i] === '--verbose') {
            verbose = true;
        }
    }
    return { server, port, verbose };
}
export function createTunnelCommandV2(kernel) {
    return async (ctx) => {
        const options = parseArgs(ctx.args);
        // Handle --help
        if ('help' in options && options.help) {
            ctx.stdout.write(`Usage: tunnel [options]

Expose Lifo HTTP servers through a WebSocket tunnel

Options:
  --server <url>    Tunnel server URL (default: ws://localhost:3005)
  --port, -p <num>  Default port (routes all requests to this port)
  -v, --verbose     Verbose logging
  -h, --help        Show this help

Examples:
  # Path-based routing (default):
  tunnel
  # Access: http://localhost:3005/3000/ → Port 3000
  #         http://localhost:3005/8080/ → Port 8080

  # Default port mode (for Vite, webpack-dev-server, etc.):
  tunnel --port 5173
  # Access: http://localhost:3005/ → Port 5173

Without --port, uses path-based routing:
  http://localhost:3005/3000/         → Port 3000 inside Lifo
  http://localhost:3005/8080/api      → Port 8080, path /api
  http://localhost:3005/3000/users    → Port 3000, path /users

With --port 5173:
  http://localhost:3005/              → Port 5173, path /
  http://localhost:3005/src/main.ts   → Port 5173, path /src/main.ts
  (Perfect for Vite dev server!)\n`);
            return 0;
        }
        const { server, port: defaultPort, verbose } = options;
        function log(message) {
            if (verbose) {
                ctx.stdout.write(`[tunnel] ${message}\n`);
            }
        }
        // Check if tunnel already exists
        const existingTunnel = kernel.networkStack.getTunnel('wst0');
        if (existingTunnel) {
            ctx.stderr.write('Tunnel already active. Use Ctrl+C to stop it first.\n');
            return 1;
        }
        // Create WebSocket tunnel
        const tunnelId = kernel.networkStack.getNextTunnelId();
        const tunnel = new WebSocketTunnel(tunnelId, server, kernel.networkStack, kernel.portRegistry, 'default', defaultPort);
        ctx.stdout.write(`Connecting to tunnel server at ${server}...\n`);
        log('Creating WebSocket tunnel');
        try {
            // Add tunnel to network stack
            kernel.networkStack.addTunnel('wst0', tunnel);
            // Bring tunnel up (connects WebSocket)
            await tunnel.up();
            ctx.stdout.write(`✓ Connected to tunnel server\n`);
            const httpUrl = server.replace('ws://', 'http://').replace('wss://', 'https://');
            if (defaultPort) {
                ctx.stdout.write(`Tunnel ready — all traffic → port ${defaultPort}\n`);
                ctx.stdout.write(`  Open: ${httpUrl}\n`);
            }
            else {
                ctx.stdout.write(`Tunnel ready at ${httpUrl}\n`);
                // Show active ports
                const ports = tunnel.getActivePorts();
                if (ports.length === 0) {
                    ctx.stdout.write('\nNo active servers to tunnel\n');
                    ctx.stdout.write('Start a server first: node server.js\n');
                }
                else {
                    ctx.stdout.write(`\nTunneling ${ports.length} server(s):\n`);
                    for (const port of ports) {
                        ctx.stdout.write(`  - Port ${port}: ${httpUrl}/${port}/\n`);
                    }
                }
            }
            ctx.stdout.write('\nPress Ctrl+C to stop tunnel\n\n');
            log('Tunnel is active');
            // Monitor connection status
            const checkInterval = setInterval(() => {
                if (!tunnel.isConnected()) {
                    log('Connection lost, reconnecting...');
                }
                else {
                    log('Connection active');
                }
            }, verbose ? 10000 : 60000);
            await waitForAbort(ctx.signal);
            clearInterval(checkInterval);
            ctx.stdout.write('\nShutting down tunnel...\n');
            await tunnel.down();
            await kernel.networkStack.removeTunnel('wst0');
            ctx.stdout.write('Tunnel closed\n');
            return 0;
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            ctx.stderr.write(`tunnel: ${msg}\n`);
            // Cleanup on error
            try {
                await tunnel.down();
                await kernel.networkStack.removeTunnel('wst0');
            }
            catch {
                // Ignore cleanup errors
            }
            return 1;
        }
    };
}
