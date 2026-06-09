import type { ProcessInputStore } from './process-input.js';
import type { ProcessLogClientFrame } from './process-io-protocol.js';
import {
  parseProcessPid,
  parseProcessSignalName,
  parseProcessTerminalSize,
} from './process-io-protocol.js';

export interface ProcessInputHost {
  processInput: ProcessInputStore;
}

function rejectedPid(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export async function writeProcessInput(
  host: ProcessInputHost,
  pid: number,
  data: string,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  const text = String(data ?? '');
  const queued = host.processInput.write(n, text);
  return { ok: queued.ok, pid: n };
}

export async function endProcessInput(
  host: ProcessInputHost,
  pid: number,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  host.processInput.end(n);
  return { ok: true, pid: n };
}

export async function resizeProcess(
  host: ProcessInputHost,
  pid: number,
  columns: number,
  rows: number,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  const size = parseProcessTerminalSize({ columns, rows });
  if (!size) return { ok: false, pid: n };
  const resized = host.processInput.resize(n, size.columns, size.rows);
  return { ok: resized.ok, pid: n };
}

export async function signalProcess(
  host: ProcessInputHost,
  pid: number,
  signal: string,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  const parsed = parseProcessSignalName(signal);
  if (!parsed) return { ok: false, pid: n };
  const signaled = host.processInput.signal(n, parsed);
  return { ok: signaled.ok, pid: n };
}

export async function applyProcessClientFrame(
  host: ProcessInputHost,
  pid: number,
  frame: ProcessLogClientFrame,
): Promise<{ ok: boolean; pid: number; type: ProcessLogClientFrame['type'] }> {
  if (frame.type === 'input') {
    return { ...(await writeProcessInput(host, pid, frame.data)), type: frame.type };
  }
  if (frame.type === 'stdin-end') {
    return { ...(await endProcessInput(host, pid)), type: frame.type };
  }
  if (frame.type === 'resize') {
    return { ...(await resizeProcess(host, pid, frame.columns, frame.rows)), type: frame.type };
  }
  return { ...(await signalProcess(host, pid, frame.signal)), type: frame.type };
}
