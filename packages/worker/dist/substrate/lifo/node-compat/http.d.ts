import { EventEmitter } from './events.js';
import type { VirtualRequestHandler, VirtualResponse } from '../kernel/index.js';
/** Extended VirtualResponse with a done promise for async middleware */
export interface VirtualResponseWithDone extends VirtualResponse {
    _donePromise?: Promise<void>;
}
interface RequestOptions {
    hostname?: string;
    host?: string;
    port?: number | string;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
}
declare class IncomingMessage extends EventEmitter {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    method?: string;
    url?: string;
    httpVersion: string;
    httpVersionMajor: number;
    httpVersionMinor: number;
    complete: boolean;
    aborted: boolean;
    readable: boolean;
    socket: {
        remoteAddress: string;
        remotePort: number;
        encrypted: boolean;
        destroy: () => void;
    };
    connection: {
        remoteAddress: string;
        encrypted: boolean;
    };
    constructor(statusCode: number, statusMessage: string, headers: Record<string, string>);
    setEncoding(_enc: string): this;
    resume(): this;
    pause(): this;
    destroy(): this;
}
declare class ClientRequest extends EventEmitter {
    private options;
    private body;
    private aborted;
    private portRegistry?;
    private protocol;
    constructor(options: RequestOptions, cb?: (res: IncomingMessage) => void, portRegistry?: Map<number, VirtualRequestHandler>, protocol?: 'http:' | 'https:');
    write(data: string): void;
    end(data?: string): void;
    abort(): void;
    private execute;
    setTimeout(_ms: number, cb?: () => void): this;
}
declare class ServerResponse extends EventEmitter {
    statusCode: number;
    statusMessage: string;
    headersSent: boolean;
    finished: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    private _headers;
    private _body;
    private _vRes;
    socket: {
        destroy: () => void;
        writable: boolean;
        readable: boolean;
        remoteAddress: string;
    } | null;
    _donePromise: Promise<void>;
    private _doneResolve;
    constructor(vRes: {
        statusCode: number;
        headers: Record<string, string>;
        body: string;
    });
    writeHead(statusCode: number, reasonOrHeaders?: string | Record<string, string | string[]>, headers?: Record<string, string | string[]>): this;
    setHeader(name: string, value: string | string[]): this;
    getHeader(name: string): string | string[] | undefined;
    getHeaders(): Record<string, string | string[]>;
    getHeaderNames(): string[];
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    appendHeader(name: string, value: string | string[]): this;
    flushHeaders(): void;
    write(data: string | Uint8Array): boolean;
    end(data?: string | Uint8Array | (() => void), _encoding?: string, cb?: () => void): void;
    cork(): void;
    uncork(): void;
}
export declare const ACTIVE_SERVERS: unique symbol;
declare class Server extends EventEmitter {
    private portRegistry;
    private _port;
    private _closeResolve;
    private _promise;
    private _activeServers;
    constructor(portRegistry: Map<number, VirtualRequestHandler>, activeServers: Server[], requestHandler?: (req: unknown, res: unknown) => void);
    listen(port: number, ...rest: unknown[]): this;
    close(callback?: () => void): this;
    address(): {
        port: number;
        address: string;
        family: string;
    } | null;
    getPromise(): Promise<void> | null;
}
export declare function createHttp(portRegistry?: Map<number, VirtualRequestHandler>, protocol?: 'http:' | 'https:'): {
    request: (urlOrOptions: string | RequestOptions, optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void), cb?: (res: IncomingMessage) => void) => ClientRequest;
    get: (urlOrOptions: string | RequestOptions, optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void), cb?: (res: IncomingMessage) => void) => ClientRequest;
    createServer: (requestHandler?: (req: unknown, res: unknown) => void) => Server;
    IncomingMessage: typeof IncomingMessage;
    ClientRequest: typeof ClientRequest;
    Server: typeof Server;
    ServerResponse: typeof ServerResponse;
    [ACTIVE_SERVERS]: Server[];
};
export declare function request(urlOrOptions: string | RequestOptions, optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void), cb?: (res: IncomingMessage) => void): ClientRequest;
export declare function get(urlOrOptions: string | RequestOptions, optionsOrCb?: RequestOptions | ((res: IncomingMessage) => void), cb?: (res: IncomingMessage) => void): ClientRequest;
export declare function createServer(): never;
declare const _default: {
    request: typeof request;
    get: typeof get;
    createServer: typeof createServer;
    IncomingMessage: typeof IncomingMessage;
    ClientRequest: typeof ClientRequest;
};
export default _default;
//# sourceMappingURL=http.d.ts.map