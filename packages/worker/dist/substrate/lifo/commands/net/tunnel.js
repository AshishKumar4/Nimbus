import { Buffer } from '../../node-compat/buffer.js';
import { waitForAbort, waitForSignalOrTimeout } from '../signal.js';
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
function createTunnelImpl(kernel) {
    return async (ctx) => {
        const options = parseArgs(ctx.args);
        // Handle --help
        if ('help' in options && options.help) {
            ctx.stdout.write('Usage: tunnel [options]\n\n');
            ctx.stdout.write('Expose Lifo HTTP servers through a tunnel\n\n');
            ctx.stdout.write('Options:\n');
            ctx.stdout.write('  --server <url>    Tunnel server URL (default: ws://localhost:3005)\n');
            ctx.stdout.write('  --port, -p <num>  Default port (routes all requests to this port)\n');
            ctx.stdout.write('  -v, --verbose     Verbose logging\n');
            ctx.stdout.write('  -h, --help        Show this help\n\n');
            ctx.stdout.write('Examples:\n');
            ctx.stdout.write('  tunnel --port 5173                    Route all traffic to port 5173\n');
            ctx.stdout.write('  tunnel --server=ws://example.com:3005 Custom tunnel server\n\n');
            ctx.stdout.write('Without --port, uses path-based routing:\n');
            ctx.stdout.write('  http://localhost:3005/8080/ → Port 8080 inside lifo\n');
            ctx.stdout.write('  http://localhost:3005/3000/api/users → Port 3000, path /api/users\n\n');
            ctx.stdout.write('With --port 5173:\n');
            ctx.stdout.write('  http://localhost:3005/ → Port 5173, path /\n');
            ctx.stdout.write('  http://localhost:3005/src/main.ts → Port 5173, path /src/main.ts\n');
            return 0;
        }
        if (!kernel?.portRegistry) {
            ctx.stderr.write('tunnel: portRegistry not available\n');
            return 1;
        }
        const { server, port: defaultPort, verbose } = options;
        if (typeof WebSocket === 'undefined') {
            ctx.stderr.write('tunnel: WebSocket is not available in this runtime\n');
            return 1;
        }
        const WebSocketConstructor = WebSocket;
        let ws = null;
        let reconnecting = false;
        function log(message) {
            if (verbose) {
                ctx.stdout.write(`[tunnel] ${message}\n`);
            }
        }
        function logActivePorts() {
            const ports = Array.from(kernel.portRegistry.keys()).sort((a, b) => a - b);
            if (ports.length === 0) {
                ctx.stdout.write('No active servers to tunnel\n');
                return;
            }
            ctx.stdout.write(`\nTunneling ${ports.length} server(s):\n`);
            for (const port of ports) {
                if (defaultPort) {
                    ctx.stdout.write(`  - Port ${port}: http://localhost:3005/\n`);
                }
                else {
                    ctx.stdout.write(`  - Port ${port}: http://localhost:3005/${port}/\n`);
                }
            }
            ctx.stdout.write('\n');
        }
        function sendError(requestId, statusCode, message) {
            if (!ws || ws.readyState !== WebSocketConstructor.OPEN)
                return;
            const response = {
                type: 'response',
                requestId,
                statusCode,
                headers: { 'Content-Type': 'text/plain' },
                body: Buffer.from(message).toString('base64'),
            };
            ws.send(JSON.stringify(response));
        }
        function closeWebSocket(socket) {
            if (socket)
                socket.close();
        }
        async function handleMessage(data) {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'request') {
                    const { requestId, method, url, headers, body } = message;
                    log(`Received request: ${method} ${url}`);
                    let port;
                    let actualPath;
                    if (defaultPort) {
                        // Default port mode: all requests go to the default port
                        port = defaultPort;
                        actualPath = url || '/';
                    }
                    else {
                        // Path-based routing: /PORT/path
                        const match = url.match(/^\/(\d+)(\/.*)?$/);
                        if (!match) {
                            sendError(requestId, 400, 'Invalid URL format. Use /PORT/path or run tunnel with --port <num>');
                            return;
                        }
                        port = parseInt(match[1], 10);
                        actualPath = match[2] || '/';
                    }
                    // Lookup handler in portRegistry
                    const handler = kernel.portRegistry.get(port);
                    if (!handler) {
                        sendError(requestId, 404, `No server listening on port ${port}`);
                        return;
                    }
                    // Create virtual request/response
                    const vReq = {
                        method,
                        url: actualPath,
                        headers,
                        body: Buffer.from(body || '', 'base64').toString(),
                    };
                    const vRes = {
                        statusCode: 200,
                        headers: {},
                        body: '',
                    };
                    try {
                        // Call the virtual server handler
                        handler(vReq, vRes);
                        if (vRes._donePromise) {
                            const result = await waitForSignalOrTimeout(vRes._donePromise, ctx.signal, 25_000);
                            if (result.type === 'aborted') {
                                return;
                            }
                            if (result.type === 'timeout') {
                                ctx.stderr.write(`[tunnel] TIMEOUT waiting for response: ${method} ${actualPath}\n`);
                                sendError(requestId, 504, `Gateway timeout: server did not respond for ${actualPath}`);
                                return;
                            }
                        }
                        // Send response back through tunnel
                        const response = {
                            type: 'response',
                            requestId,
                            statusCode: vRes.statusCode,
                            headers: vRes.headers,
                            body: Buffer.from(vRes.body).toString('base64'),
                        };
                        ws?.send(JSON.stringify(response));
                        log(`Sent response: ${vRes.statusCode}`);
                    }
                    catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        ctx.stderr.write(`[tunnel] ERROR for ${method} ${actualPath}: ${errorMessage}\n`);
                        sendError(requestId, 500, `Internal server error: ${errorMessage}`);
                    }
                }
            }
            catch (error) {
                ctx.stderr.write(`tunnel: Error processing message: ${error}\n`);
            }
        }
        function connect() {
            if (reconnecting || ctx.signal.aborted)
                return;
            ctx.stdout.write(`Connecting to tunnel server at ${server}...\n`);
            ws = new WebSocketConstructor(server);
            ws.addEventListener('open', () => {
                reconnecting = false;
                ctx.stdout.write(`Connected to tunnel server\n`);
                const httpUrl = server.replace('ws://', 'http://').replace('wss://', 'https://');
                if (defaultPort) {
                    ctx.stdout.write(`Tunnel ready — all traffic → port ${defaultPort}\n`);
                    ctx.stdout.write(`  Open: ${httpUrl}\n`);
                }
                else {
                    ctx.stdout.write(`Tunnel ready at ${httpUrl}\n`);
                }
                logActivePorts();
            });
            ws.addEventListener('message', (event) => {
                const data = typeof event.data === 'string'
                    ? Buffer.from(event.data)
                    : event.data;
                handleMessage(data);
            });
            ws.addEventListener('close', () => {
                if (!ctx.signal.aborted) {
                    ctx.stdout.write('Disconnected from tunnel server\n');
                    ctx.stdout.write('Reconnecting in 5 seconds...\n');
                    reconnecting = true;
                    setTimeout(() => {
                        reconnecting = false;
                        connect();
                    }, 5000);
                }
            });
            ws.addEventListener('error', (event) => {
                const errorMessage = event instanceof ErrorEvent ? event.message : 'Connection error';
                ctx.stderr.write(`tunnel: WebSocket error: ${errorMessage}\n`);
            });
        }
        // Initial connection
        connect();
        await waitForAbort(ctx.signal);
        ctx.stdout.write('\nShutting down tunnel...\n');
        closeWebSocket(ws);
        return 0;
    };
}
export function createTunnelCommand(kernel) {
    return createTunnelImpl(kernel);
}
// Default command (no kernel)
const command = createTunnelImpl();
export default command;
