const STANDARD_SIGNALS = [
    ['HUP', 'terminate'], ['INT', 'terminate'], ['QUIT', 'terminate'], ['ILL', 'terminate'], ['TRAP', 'terminate'],
    ['ABRT', 'terminate'], ['BUS', 'terminate'], ['FPE', 'terminate'], ['KILL', 'terminate'], ['USR1', 'terminate'],
    ['SEGV', 'terminate'], ['USR2', 'terminate'], ['PIPE', 'terminate'], ['ALRM', 'terminate'], ['TERM', 'terminate'],
    ['STKFLT', 'terminate'], ['CHLD', 'ignore'], ['CONT', 'continue'], ['STOP', 'stop'], ['TSTP', 'stop'],
    ['TTIN', 'stop'], ['TTOU', 'stop'], ['URG', 'ignore'], ['XCPU', 'terminate'], ['XFSZ', 'terminate'],
    ['VTALRM', 'terminate'], ['PROF', 'terminate'], ['WINCH', 'ignore'], ['IO', 'terminate'], ['PWR', 'terminate'], ['SYS', 'terminate'],
];
const SIGNALS = new Map(STANDARD_SIGNALS.map(([name, disposition], index) => [name, { number: index + 1, disposition }]));
for (let number = 34; number <= 64; number++) {
    const name = number === 34 ? 'RTMIN' : number === 64 ? 'RTMAX'
        : number <= 49 ? `RTMIN+${number - 34}` : `RTMAX-${64 - number}`;
    SIGNALS.set(name, { number, disposition: 'terminate' });
}
const SIGNAL_NAMES = new Map(Array.from(SIGNALS.entries()).map(([name, { number }]) => [number, name]));
export function parseSignalName(raw) {
    const normalized = raw.trim().toUpperCase().replace(/^SIG/, '');
    if (SIGNALS.has(normalized))
        return normalized;
    if (normalized === '0')
        return '0';
    if (!/^\d+$/.test(normalized))
        return null;
    const number = Number(normalized);
    return SIGNAL_NAMES.get(number) ?? null;
}
export function formatSignalList() {
    let result = '';
    let column = 0;
    for (const [number, name] of SIGNAL_NAMES) {
        result += `${String(number).padStart(2, ' ')}) SIG${name}`;
        result += ++column % 5 === 0 ? '\n' : '\t';
    }
    return result.endsWith('\n') ? result : result.slice(0, -1) + '\n';
}
export function signalOperand(raw) {
    if (/^\d+$/.test(raw))
        return SIGNAL_NAMES.get(Number(raw) >= 128 ? Number(raw) - 128 : Number(raw)) ?? null;
    const name = parseSignalName(raw);
    const number = name === null ? undefined : SIGNALS.get(name)?.number;
    return number === undefined ? null : String(number);
}
export function exitCodeForSignal(signal) {
    return 128 + (SIGNALS.get(signal ?? 'TERM')?.number ?? 0);
}
/** A process a write to a closed pipe ended, as SIGPIPE ends one. */
export const KILLED_BY_SIGPIPE = { status: exitCodeForSignal('PIPE'), signal: 'PIPE' };
export function signalDisposition(signal) {
    return signal === '0' ? 'ignore' : SIGNALS.get(signal)?.disposition;
}
export function signalAbortReason(signal) {
    const normalized = signal ? parseSignalName(signal) : 'TERM';
    const name = normalized ?? 'TERM';
    return { kind: 'signal', signal: name, exitCode: exitCodeForSignal(name) };
}
export function exitCodeForAbortSignal(signal, fallback = 130) {
    return isSignalAbortReason(signal.reason) ? signal.reason.exitCode : fallback;
}
function isSignalAbortReason(value) {
    if (!value || typeof value !== 'object')
        return false;
    const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
    const signal = Object.getOwnPropertyDescriptor(value, 'signal')?.value;
    const exitCode = Object.getOwnPropertyDescriptor(value, 'exitCode')?.value;
    return kind === 'signal'
        && typeof signal === 'string'
        && typeof exitCode === 'number';
}
