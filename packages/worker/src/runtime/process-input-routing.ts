/**
 * process-input-routing.ts — the single zod-validated protocol path for
 * process-terminal client frames (`input` / `stdin-end` / `resize` /
 * `signal`). Both WebSocket surfaces (the `/api/logs/<pid>` upgrade
 * handler and the hibernatable `webSocketMessage` dispatcher) and the
 * programmatic SDK RPCs route through these helpers.
 */

import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import type { ProcessLogClientFrame } from './process-io-protocol.js';
import {
  parseProcessPid,
  parseProcessSignalName,
  parseProcessTerminalSize,
} from './process-io-protocol.js';

/** The slice of the process supervisor the frame router drives. */
export type ProcessInputController = Pick<
  SessionProcessSupervisor,
  'writeInput' | 'endInput' | 'resize' | 'signal'
>;

function rejectedPid(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

export async function writeProcessInput(
  processes: ProcessInputController,
  pid: number,
  data: string,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  const text = String(data ?? '');
  const queued = processes.writeInput(n, text);
  return { ok: queued.ok, pid: n };
}

export async function endProcessInput(
  processes: ProcessInputController,
  pid: number,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  processes.endInput(n);
  return { ok: true, pid: n };
}

export async function resizeProcess(
  processes: ProcessInputController,
  pid: number,
  columns: number,
  rows: number,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  const size = parseProcessTerminalSize({ columns, rows });
  if (!size) return { ok: false, pid: n };
  const resized = processes.resize(n, size.columns, size.rows);
  return { ok: resized.ok, pid: n };
}

export async function signalProcess(
  processes: ProcessInputController,
  pid: number,
  signal: string,
): Promise<{ ok: boolean; pid: number }> {
  const n = parseProcessPid(pid);
  if (n === null) return { ok: false, pid: rejectedPid(pid) };
  const parsed = parseProcessSignalName(signal);
  if (!parsed) return { ok: false, pid: n };
  const signaled = processes.signal(n, parsed);
  return { ok: signaled.ok, pid: n };
}

export async function applyProcessClientFrame(
  processes: ProcessInputController,
  pid: number,
  frame: ProcessLogClientFrame,
): Promise<{ ok: boolean; pid: number; type: ProcessLogClientFrame['type'] }> {
  if (frame.type === 'input') {
    return { ...(await writeProcessInput(processes, pid, frame.data)), type: frame.type };
  }
  if (frame.type === 'stdin-end') {
    return { ...(await endProcessInput(processes, pid)), type: frame.type };
  }
  if (frame.type === 'resize') {
    return { ...(await resizeProcess(processes, pid, frame.columns, frame.rows)), type: frame.type };
  }
  return { ...(await signalProcess(processes, pid, frame.signal)), type: frame.type };
}
