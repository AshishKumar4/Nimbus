import { deleteSession, makeAsserter, mintSession, Terminal } from '../../_driver.mjs';
import { terminalCommandRunner } from '../../../unit/lib/workerd-probe.mjs';

if (!process.env.BASE) throw new Error('BASE is required');
const a = makeAsserter('node-launch-byte-options');
const sid = await mintSession(), terminal = new Terminal(sid);
const dir = '/home/user/launch-byte';
try {
  await terminal.connect();
  await terminal.waitForPrompt(60_000);
  const run = terminalCommandRunner(terminal);
  await run(`mkdir -p ${dir}`);
  const files = {
    'package.json': JSON.stringify({ type: 'module', imports: { '#mode': { development: './dev.cjs', default: './prod.cjs' } } }),
    'dev.cjs': 'module.exports = "dev";',
    'prod.cjs': 'module.exports = "prod";',
    'pre.cjs': 'globalThis.PRELOAD = "ready";',
    'imp.mjs': 'import { sep } from "node:path"; globalThis.IMPORTED = sep === "/" ? "yes" : "no";',
    'main.cjs': 'console.log("MODE=" + require("#mode")); console.log("PRE=" + (globalThis.PRELOAD ?? "none")); console.log("EXEC=" + JSON.stringify(process.execArgv));',
  };
  for (const [path, content] of Object.entries(files)) {
    // The marker runner appends a command: a heredoc's final delimiter must
    // stand alone, so use the same byte-safe fixture writer as localTerminal.
    const encoded = Buffer.from(content).toString('base64');
    const written = await run(`node -e "require('fs').writeFileSync('${dir}/${path}', Buffer.from('${encoded}', 'base64'))"`);
    a.check(`fixture ${path} written`, written.status === 0, written.stdout.slice(-300));
  }
  const execute = command => run(`cd ${dir} && ${command}`, 120_000);
  const conditions = await execute('node -C development -r ./pre.cjs main.cjs');
  a.check('-C chooses imports and -r runs before the program', conditions.status === 0 && /^MODE=dev$/m.test(conditions.stdout) && /^PRE=ready$/m.test(conditions.stdout), conditions.stdout);
  a.check('execArgv contains the launch options', /^EXEC=\["-C","development","-r","\.\/pre\.cjs"\]$/m.test(conditions.stdout), conditions.stdout);
  const ordinary = await execute('node main.cjs');
  a.check('a different launch keeps default conditions and no preload', ordinary.status === 0 && /^MODE=prod$/m.test(ordinary.stdout) && /^PRE=none$/m.test(ordinary.stdout), ordinary.stdout);
  const printed = await execute(`node -C development -r ./pre.cjs -p 'globalThis.PRELOAD+":"+require("#mode")'`);
  a.check('-p prints the completion after the preload', printed.status === 0 && /^ready:dev$/m.test(printed.stdout), printed.stdout);
  const imported = await execute(`node -r ./pre.cjs --import ./imp.mjs -p 'globalThis.PRELOAD+":"+globalThis.IMPORTED'`);
  a.check('--import and -r share the launched program', imported.status === 0 && /^ready:yes$/m.test(imported.stdout), imported.stdout);
  const environment = await execute(`NODE_OPTIONS='-C development -r ./pre.cjs' node -p 'globalThis.PRELOAD+":"+require("#mode")'`);
  a.check('NODE_OPTIONS launch parsing survives the merge', environment.status === 0 && /^ready:dev$/m.test(environment.stdout), environment.stdout);
  const stdinPrint = await execute(`echo '1+2' | node -p`);
  a.check('-p reads a piped program and prints its completion', stdinPrint.status === 0 && /^3$/m.test(stdinPrint.stdout), stdinPrint.stdout);
  const bytes = await execute(`node -e 'process.stdout.write(Buffer.from([255,0,254]))' | node -C development -r ./pre.cjs -e 'process.stdin.pipe(process.stdout)' | xxd -p`);
  a.check('conditions and preloads keep byte-exact piped stdin/output', bytes.status === 0 && /^ff00fe$/m.test(bytes.stdout), bytes.stdout);
} finally {
  await terminal.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok, cleanup.body.slice(-300));
}
const { fail } = a.summary();
process.exit(fail ? 1 : 0);
