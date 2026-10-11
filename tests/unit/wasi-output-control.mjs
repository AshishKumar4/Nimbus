import assert from 'node:assert/strict';
import { outputControlReader, OUTPUT_CONTROL_MAX_BYTES } from '../../packages/core/src/runtime/wasi/output-control.ts';
const frames = [{ key: 'incomplete', prefix: '__INCOMPLETE__' }, { key: 'exit', prefix: '__EXIT__', suffix: ':' }];
const bytes = Buffer.concat([Buffer.from([255,254,0]),Buffer.from('hello__EXIT__7:tail__INCOMPLETE__'),Buffer.from([128])]);
const expected = Buffer.concat([Buffer.from([255,254,0]),Buffer.from('hellotail'),Buffer.from([128])]);
for (let split=0;split<=bytes.length;split++) {
  const reader=outputControlReader(frames);
  const output=Buffer.concat([reader.feed(bytes.subarray(0,split)),reader.feed(bytes.subarray(split)),reader.finish()]);
  assert.deepEqual(output,expected,'control filtering preserves every non-control byte at split '+split);
  assert.deepEqual(reader.values,{exit:'7',incomplete:''});
}
const partial=outputControlReader(frames);
assert.equal(Buffer.from(partial.feed(Buffer.from('ordinary__EX'))).toString(),'ordinary');
assert.equal(Buffer.from(partial.finish()).toString(),'__EX','a partial prefix is ordinary output at end of input');
const bounded=outputControlReader(frames);
assert.throws(()=>bounded.feed(Buffer.from('__EXIT__'+'1'.repeat(OUTPUT_CONTROL_MAX_BYTES+1))),/byte bound/);
console.log('wasi-output-control: split frames, binary output, partial prefixes and bounded control metadata');
