// The CI command boundary: forward both streams, keep a bounded diagnostic
// tail, and account for launch errors and signals in the same verdict shape.
import { spawn } from 'node:child_process';

export const OUTPUT_CAP = 256 * 1024;

export function step(name, cwd, command, args, { write = (chunk) => process.stderr.write(chunk) } = {}) {
  const began = Date.now();
  return new Promise((resolve) => {
    let output = '';
    const keep = (chunk) => {
      write(chunk);
      output = (output + chunk.toString()).slice(-OUTPUT_CAP);
    };
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => keep(`\n${command} could not start: ${error.message}\n`));
    child.on('close', (code, signal) => {
      if (signal) keep(`\n${command} was killed by ${signal}\n`);
      resolve({ name, exitCode: code ?? 128, seconds: (Date.now() - began) / 1000, output });
    });
  });
}
