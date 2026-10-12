// Pair this same input on the base and result; every launch writes fresh ES
// modules, and each executes 50,000 interpreted calls (600,000 in total).
const fs = require('fs');
const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
const dir = '/home/user/frames-bench/late-' + token;
fs.mkdirSync(dir, { recursive: true });
const N = 12;
for (let i = 0; i < N; i++) {
  const prev = i > 0 ? `import { result as previous } from './m${i - 1}.mjs';\n` : '';
  fs.writeFileSync(`${dir}/m${i}.mjs`, `${prev}export function step(x) { return (x + 1) | 0; }\nexport function work(n) { let value = 0; for (let j = 0; j < n; j++) value = step(value); return value; }\nexport const result = work(50000);\n`);
}
import(`${dir}/m${N - 1}.mjs`).then((m) => {
  if (m.result !== 50000) throw new Error('interpreted workload did not finish');
  console.log(m.result);
  fs.rmSync(dir, { recursive: true, force: true });
});
