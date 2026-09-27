const SIGNAL_NUMBERS = new Map<string, number>([
  'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1',
  'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP',
  'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
].map((name, index) => [name, index + 1]));
for (let number = 34; number <= 64; number++) {
  const name = number === 34 ? 'RTMIN' : number === 64 ? 'RTMAX'
    : number <= 49 ? `RTMIN+${number - 34}` : `RTMAX-${64 - number}`;
  SIGNAL_NUMBERS.set(name, number);
}

const SIGNAL_NAMES = new Map<number, string>(
  Array.from(SIGNAL_NUMBERS.entries()).map(([name, number]) => [number, name]),
);

export type SignalAbortReason = {
  kind: 'signal';
  signal: string;
  exitCode: number;
};

export function parseSignalName(raw: string): string | null {
  const normalized = raw.trim().toUpperCase().replace(/^SIG/, '');
  if (SIGNAL_NUMBERS.has(normalized)) return normalized;
  if (normalized === '0') return '0';
  if (!/^\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return SIGNAL_NAMES.get(number) ?? null;
}

export function formatSignalList(): string {
  let result = '';
  let column = 0;
  for (const [number, name] of SIGNAL_NAMES) {
    result += `${String(number).padStart(2, ' ')}) SIG${name}`;
    result += ++column % 5 === 0 ? '\n' : '\t';
  }
  return result.endsWith('\n') ? result : result.slice(0, -1) + '\n';
}

export function signalOperand(raw: string): string | null {
  if (/^\d+$/.test(raw)) return SIGNAL_NAMES.get(Number(raw) >= 128 ? Number(raw) - 128 : Number(raw)) ?? null;
  const name = parseSignalName(raw);
  const number = name === null ? undefined : SIGNAL_NUMBERS.get(name);
  return number === undefined ? null : String(number);
}

export function exitCodeForSignal(signal?: string): number {
  return 128 + (SIGNAL_NUMBERS.get(signal ?? 'TERM') ?? 0);
}

export function signalAbortReason(signal?: string): SignalAbortReason {
  const normalized = signal ? parseSignalName(signal) : 'TERM';
  const name = normalized ?? 'TERM';
  return { kind: 'signal', signal: name, exitCode: exitCodeForSignal(name) };
}

export function exitCodeForAbortSignal(signal: AbortSignal, fallback = 130): number {
  return isSignalAbortReason(signal.reason) ? signal.reason.exitCode : fallback;
}

function isSignalAbortReason(value: unknown): value is SignalAbortReason {
  if (!value || typeof value !== 'object') return false;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  const signal = Object.getOwnPropertyDescriptor(value, 'signal')?.value;
  const exitCode = Object.getOwnPropertyDescriptor(value, 'exitCode')?.value;
  return kind === 'signal'
    && typeof signal === 'string'
    && typeof exitCode === 'number';
}
