// Scratch diagnosis: measure the security-related API delta, without hostile input.
// Runs only on armada through remote-unit; reference runtimes never run locally.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=mkdtempSync(join(tmpdir(),'astro-node-security-'));
const version='22.23.4';
const archive=join(root,'node.tar.xz');
const sample=String.raw`
const tls=require('node:tls'),zlib=require('node:zlib'),dns=require('node:dns');
const resolver=new dns.Resolver();
let dnsNul='no synchronous rejection';
try{resolver.resolve4('example.com'+String.fromCharCode(0)+'.invalid',()=>{});resolver.cancel();}catch(e){dnsNul={code:e.code,message:e.message};}
const result={
  version:process.version,
  versions:{node:process.versions.node,v8:process.versions.v8,modules:process.versions.modules},
  brotliBlockSwitch:zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH??null,
  tlsNonCanonical:['127.1','0127.0.0.1','0x7f.0.0.1'].map(host=>{
    const e=tls.checkServerIdentity(host,{subjectaltname:'DNS:'+host});
    return {host,result:e?.code??'accepted',reason:e?.reason??null};
  }),dnsNul,
};console.log(JSON.stringify(result));
`;
function run(command,args,timeout=120000){
  const result=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,`${command}: ${result.error?.message??''}\n${result.stderr}`);
  return result.stdout;
}
try{
  run('curl',['-fsSL','--retry','2','--max-time','90','-o',archive,`https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz`]);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),'1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce');
  run('tar',['-xJf',archive,'-C',root]);
  const current=JSON.parse(run('node',['-e',sample],15000));
  const next=JSON.parse(run(join(root,`node-v${version}-linux-x64/bin/node`),['-e',sample],15000));
  console.log('CURRENT_ORACLE',JSON.stringify(current));
  console.log('ASTRO_MINIMUM',JSON.stringify(next));
  assert.equal(next.version,'v22.23.4');
  assert.ok(next.tlsNonCanonical.every(c=>c.result==='ERR_TLS_CERT_ALTNAME_INVALID'));
}finally{
  rmSync(root,{recursive:true,force:true});
}
