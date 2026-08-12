import { z } from 'zod/v4';
const ProcessPidSchema = z.coerce.number().int().positive().safe();
const ProcessTerminalSizeSchema = z.object({
    columns: z.coerce.number().int().min(1).max(1000),
    rows: z.coerce.number().int().min(1).max(1000),
});
export const ProcessSignalNameSchema = z.enum([
    'SIGHUP',
    'SIGINT',
    'SIGQUIT',
    'SIGILL',
    'SIGTRAP',
    'SIGABRT',
    'SIGBUS',
    'SIGFPE',
    'SIGKILL',
    'SIGUSR1',
    'SIGSEGV',
    'SIGUSR2',
    'SIGPIPE',
    'SIGALRM',
    'SIGTERM',
    'SIGCHLD',
    'SIGCONT',
    'SIGSTOP',
    'SIGTSTP',
    'SIGTTIN',
    'SIGTTOU',
    'SIGURG',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGVTALRM',
    'SIGPROF',
    'SIGWINCH',
    'SIGIO',
    'SIGPWR',
    'SIGSYS',
]);
export function parseProcessPid(value) {
    const parsed = ProcessPidSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export function parseProcessTerminalSize(value) {
    const parsed = ProcessTerminalSizeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
export function parseProcessSignalName(value) {
    const parsed = ProcessSignalNameSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
const ProcessInputFrameSchema = z.object({
    type: z.literal('input'),
    data: z.unknown().optional().transform((value) => value == null ? '' : String(value)),
}).passthrough();
const ProcessStdinEndFrameSchema = z.object({
    type: z.literal('stdin-end'),
}).passthrough();
const ProcessResizeFrameSchema = z.object({
    type: z.literal('resize'),
}).merge(ProcessTerminalSizeSchema).passthrough();
const ProcessSignalFrameSchema = z.object({
    type: z.literal('signal'),
    signal: ProcessSignalNameSchema,
}).passthrough();
export const ProcessLogClientFrameSchema = z.discriminatedUnion('type', [
    ProcessInputFrameSchema,
    ProcessStdinEndFrameSchema,
    ProcessResizeFrameSchema,
    ProcessSignalFrameSchema,
]);
export function parseProcessLogClientFrame(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const parsed = ProcessLogClientFrameSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
