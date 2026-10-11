import parseArgv from 'yargs-parser/browser';
/** OpenCode's default command is a TUI, even when its first operand names a project. */
export declare function classifyOpenCodeInvocation(argv: string[]): 'oneshot' | 'attached' | 'server' | 'dual';
export declare function parseOpenCodeArgv(argv: string[]): parseArgv.DetailedArguments;
export type OpenCodeTransportPlan = {
    cwd: string;
    serveArgv: string[];
    attachArgv: string[];
    port?: number;
};
/** Lossless supported default-TUI options, or a named refusal before any spawn. */
export declare function buildOpenCodeTransportPlan(argv: string[], cwd: string, env?: Record<string, string>): OpenCodeTransportPlan | {
    error: string;
};
//# sourceMappingURL=opencode-invocation.d.ts.map