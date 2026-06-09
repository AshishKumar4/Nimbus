import type { ProcessSignalName } from './process-io-protocol.js';

interface InputWaiter {
  resolve: (packet: ProcessInputPacket) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProcessInputPacket {
  data: string;
  ended: boolean;
  resize?: { columns: number; rows: number };
  signal?: ProcessSignalName;
}

interface InputState {
  packets: ProcessInputPacket[];
  closed: boolean;
  bytes: number;
  waiters: InputWaiter[];
  columns: number;
  rows: number;
}

export interface ProcessInputStoreOptions {
  maxQueuedBytes?: number;
}

const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

export class ProcessInputStore {
  private readonly maxQueuedBytes: number;
  private pids = new Map<number, InputState>();

  constructor(options: ProcessInputStoreOptions = {}) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  }

  private createState(): InputState {
    return { packets: [], closed: false, bytes: 0, waiters: [], columns: 80, rows: 24 };
  }

  open(pid: number): void {
    if (!isValidPid(pid) || this.pids.has(pid)) return;
    this.pids.set(pid, this.createState());
  }

  has(pid: number): boolean {
    return this.pids.has(pid);
  }

  write(pid: number, data: string): { ok: boolean } {
    if (!isValidPid(pid)) return { ok: false };
    const state = this.pids.get(pid);
    if (!state) return { ok: false };
    if (state.closed) return { ok: false };

    const text = String(data);
    if (state.bytes + text.length > this.maxQueuedBytes) return { ok: false };

    return this.enqueue(state, { data: text, ended: false }, text.length);
  }

  resize(pid: number, columns: number, rows: number): { ok: boolean } {
    if (!isValidPid(pid)) return { ok: false };
    const state = this.pids.get(pid);
    if (!state) return { ok: false };
    if (state.closed) return { ok: false };
    state.columns = columns;
    state.rows = rows;
    return this.enqueue(state, { data: '', ended: false, resize: { columns, rows } }, 0);
  }

  signal(pid: number, signal: ProcessSignalName): { ok: boolean } {
    if (!isValidPid(pid)) return { ok: false };
    const state = this.pids.get(pid);
    if (!state) return { ok: false };
    if (state.closed) return { ok: false };
    return this.enqueue(state, { data: '', ended: false, signal }, 0);
  }

  terminalSize(pid: number): { columns: number; rows: number } | null {
    const state = this.pids.get(pid);
    return state ? { columns: state.columns, rows: state.rows } : null;
  }

  private enqueue(state: InputState, packet: ProcessInputPacket, bytes: number): { ok: boolean } {
    const waiter = state.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(packet);
      return { ok: true };
    }

    const last = state.packets[state.packets.length - 1];
    if (packet.resize && last?.resize && !last.data && !last.ended && !last.signal) {
      state.packets[state.packets.length - 1] = packet;
      return { ok: true };
    }

    state.packets.push(packet);
    state.bytes += bytes;
    return { ok: true };
  }

  end(pid: number): void {
    const state = this.pids.get(pid);
    if (!state || state.closed) return;
    state.closed = true;
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve({ data: '', ended: true });
    }
  }

  close(pid: number): void {
    this.end(pid);
    this.pids.delete(pid);
  }

  async read(pid: number, waitMs = 1000): Promise<ProcessInputPacket> {
    if (!isValidPid(pid)) return { data: '', ended: true };
    const state = this.pids.get(pid);
    if (!state) return { data: '', ended: true };

    const next = state.packets.shift();
    if (next !== undefined) {
      state.bytes -= next.data.length;
      return next;
    }
    if (state.closed) return { data: '', ended: true };

    return new Promise((resolve) => {
      const waiter: InputWaiter = {
        resolve,
        timer: setTimeout(() => {
          const idx = state.waiters.indexOf(waiter);
          if (idx >= 0) state.waiters.splice(idx, 1);
          resolve({ data: '', ended: false });
        }, Math.max(0, Math.min(waitMs, 5000))),
      };
      state.waiters.push(waiter);
    });
  }
}
