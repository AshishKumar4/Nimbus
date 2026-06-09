const SIGNAL_NUMBERS = new Map([
    ['HUP', 1],
    ['INT', 2],
    ['QUIT', 3],
    ['KILL', 9],
    ['TERM', 15],
    ['STOP', 19],
    ['TSTP', 20],
    ['CONT', 18],
]);
const SIGNAL_NAMES = new Map(Array.from(SIGNAL_NUMBERS.entries()).map(([name, number]) => [number, name]));
export function parseSignalName(raw) {
    const normalized = raw.trim().toUpperCase().replace(/^SIG/, '');
    if (SIGNAL_NUMBERS.has(normalized))
        return normalized;
    const number = Number.parseInt(normalized, 10);
    if (Number.isNaN(number))
        return null;
    return SIGNAL_NAMES.get(number) ?? null;
}
export function formatSignalList() {
    return Array.from(SIGNAL_NAMES.entries())
        .sort(([a], [b]) => a - b)
        .map(([number, name]) => `${String(number).padStart(2, ' ')}) ${name}`)
        .join('\n') + '\n';
}
export function exitCodeForSignal(signal) {
    switch (signal) {
        case 'HUP': return 129;
        case 'INT': return 130;
        case 'QUIT': return 131;
        case 'KILL': return 137;
        case 'TERM':
        case undefined:
            return 143;
        default:
            return 128;
    }
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
