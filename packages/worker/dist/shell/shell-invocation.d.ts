export type ShellName = 'sh' | 'bash';
export type ShellInvocationOptions = {
    errexit?: boolean;
    nounset?: boolean;
    pipefail?: boolean;
};
export type ShellInvocation = {
    kind: 'command';
    body: string;
    args: string[];
    options: ShellInvocationOptions;
} | {
    kind: 'script';
    path: string;
    args: string[];
    options: ShellInvocationOptions;
} | {
    kind: 'stdin';
    args: string[];
    options: ShellInvocationOptions;
};
export type ShellInvocationParseResult = {
    ok: true;
    invocation: ShellInvocation;
} | {
    ok: false;
    error: string;
    exitCode: number;
};
export declare function parseShellInvocation(shellName: ShellName, rawArgs: string[] | undefined): ShellInvocationParseResult;
//# sourceMappingURL=shell-invocation.d.ts.map