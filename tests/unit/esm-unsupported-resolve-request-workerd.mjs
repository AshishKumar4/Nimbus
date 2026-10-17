// @serial
// @tier slow — drives a local workerd
// A relative specifier that is no URL against its importer's (`//[`): Node's
// ERR_UNSUPPORTED_RESOLVE_REQUEST, whose own cause is the URL parser's
// ERR_INVALID_URL with the input and the base, from import.meta.resolve and
// import() at run time, and from a static import the launch staged
// (esm-stage's refusal, rebuilt by the shims); a staged refusal of another
// kind takes no cause from Object.prototype; and with Reflect.apply and
// Error.captureStackTrace replaced by throwers, the resolver's errors are
// still its own (their stacks captured through the launch's captures).
// Host Node is the oracle.
import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const show = `const show = (label, e) => {
  const c = e.cause;
  console.log(label, e.name, e.code, e.message);
  console.log(' cause', c && c.name, c && c.code, c && c.message, c && c.input, c && c.base, c && Object.keys(c).join(), Object.keys(e).join(), Object.getOwnPropertyDescriptor(e, 'cause')?.enumerable);
};
`;

const files = {
  'package.json': '{ "type": "module", "imports": { "#ok": "./bad.mjs" } }\n',
  'bad.mjs': "import '//[';\n",
  'missing.mjs': "import './nowhere.mjs';\n",
  'main.mjs': `${show}
try { import.meta.resolve('//['); } catch (e) { show('meta', e); }
try { await import('//['); } catch (e) { show('import()', e); }
try { await import('./bad.mjs'); } catch (e) { show('static', e); }
// A staged refusal of another kind takes no cause a program gave Object.prototype.
Object.defineProperty(Object.prototype, 'invalidUrl', { value: { input: 'x', base: 'y' }, configurable: true });
try { await import('./missing.mjs'); } catch (e) { show('polluted', e); }
delete Object.prototype.invalidUrl;
const apply = Reflect.apply;
const capture = Error.captureStackTrace;
const thrower = () => { throw new Error('a replaced built-in was called'); };
for (const [owner, key, saved] of [[Reflect, 'apply', apply], [Error, 'captureStackTrace', capture]]) {
  owner[key] = thrower;
  try { import.meta.resolve('#/x'); } catch (e) { console.log(key, 'replaced:', e.name, e.code, e.message); }
  try { import.meta.resolve('//['); } catch (e) { console.log(key, 'replaced:', e.name, e.code, e.cause?.code); }
  owner[key] = saved;
}
`,
};

await matchNodeInWorkerd('esm-unsupported-resolve-request', '/home/user/badurl', files, ['node main.mjs']);
console.log('ok - esm-unsupported-resolve-request-workerd');
