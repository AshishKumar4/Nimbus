import { DEFAULT_HOME, DEFAULT_HOSTNAME } from '../../../constants.js';
import { readHeapMemory, uptimeSeconds } from '../utils/system-info.js';

export function createOs(env: Record<string, string>) {
  return {
    arch: () => 'wasm',
    platform: () => 'lifo',
    type: () => 'Lifo',
    release: () => '0.1.0',
    hostname: () => DEFAULT_HOSTNAME,
    homedir: () => env.HOME || DEFAULT_HOME,
    tmpdir: () => '/tmp',
    cpus: () => {
      const count = navigator.hardwareConcurrency || 4;
      return Array.from({ length: count }, () => ({
        model: 'Browser CPU',
        speed: 2400,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
      }));
    },
    totalmem: () => readHeapMemory()?.total ?? 4 * 1024 * 1024 * 1024,
    freemem: () => {
      const memory = readHeapMemory();
      return memory ? memory.total - memory.used : 2 * 1024 * 1024 * 1024;
    },
    uptime: () => uptimeSeconds(),
    loadavg: () => [0, 0, 0],
    networkInterfaces: () => ({}),
    userInfo: () => ({
      uid: 1000,
      gid: 1000,
      username: env.USER || 'user',
      homedir: env.HOME || DEFAULT_HOME,
      shell: env.SHELL || '/bin/sh',
    }),
    EOL: '\n',
    endianness: () => 'LE' as const,
    constants: {
      signals: {} as Record<string, number>,
      errno: {} as Record<string, number>,
    },
  };
}
