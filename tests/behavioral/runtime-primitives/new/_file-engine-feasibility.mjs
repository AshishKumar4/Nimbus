// Which platform record attributes a process's CPU and memory: each case in a
// session of its own, printed with its session id and window for GraphQL.
import { mintSession, deleteSession, Terminal } from '../../_driver.mjs';

const cases = {
  control: ['true'],
  'node-oneshot-cpu': ["node -e 'let x=0;for(let i=0;i<3e9;i++)x+=i;console.log(x>0)'"],
  'node-oneshot-mem': ["node -e 'const a=[];for(let i=0;i<64;i++)a.push(new Uint8Array(1<<20).fill(1));setTimeout(()=>console.log(a.length),3000)'"],
  'python-c-cpu': ['nimbus install python3', 'python3 -c "x=0\nfor i in range(3*10**6): x+=i\nprint(x>0)"'],
  'python-script-cpu': ['nimbus install python3', "printf 'x=0\\nfor i in range(3*10**6): x+=i\\nprint(x>0)\\n' > cpu.py", 'python3 cpu.py'],
  'node-resident-cpu': ["printf 'require(\"http\").createServer((q,s)=>s.end(\"x\")).listen(3000,()=>{let x=0;for(let i=0;i<3e9;i++)x+=i;console.log(x>0);process.exit(0)})\\n' > srv.js", 'node srv.js'],
};
const only = process.env.CASES ? process.env.CASES.split(',') : Object.keys(cases);
await Promise.all(only.map(async (name) => {
  const sid = await mintSession();
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(60_000);
    const steps = cases[name];
    for (const line of steps.slice(0, -1)) await t.run(line, 300_000);
    const start = new Date().toISOString();
    const r = await t.run(steps[steps.length - 1], 600_000);
    console.log(JSON.stringify({ name, sid, start, end: new Date().toISOString(), elapsed: r.elapsed, exit: r.exitCode, tail: r.output.slice(-200) }));
  } finally {
    await t.close().catch(() => {});
    if (process.env.KEEP !== '1') await deleteSession(sid).catch(() => {});
  }
}));
