const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {closeAction, matches, records, identityKey} = require('../out/lifecycle');
const {prefix, safeName, reserveName, parseSessions, Shpool, lockWorkspace} = require('../out/backend');
const r = {id:'stable-id',workspace:'ws',persistent:true,sessionName:'project-2',backend:{executable:'/bin/shpool',socket:'/tmp/socket'},cwd:'/tmp',startedAt:123};
const s = {name:'project-2',startedAt:123,status:'Disconnected',attachments:[]};
for (const [label,reason] of [['Unknown',0],['Shutdown',1],['Extension',4],['missing',undefined]]) {
  test(`${label}: never kill or delete identity`,()=>{
    assert.equal(closeAction(reason,r,s,10),'keep');
    assert.equal(closeAction(reason,r,undefined,10),'keep');
  });
}
test('User: kill exact known generation after backing client has exited',()=>assert.equal(closeAction(3,r,s,10),'kill'));
test('User: refuse kill of another attachment or shell generation',()=>{
  assert.equal(closeAction(3,r,{...s,attachments:[11]},10),'remove');
  assert.equal(closeAction(3,r,{...s,startedAt:456},10),'remove');
  assert.equal(closeAction(3,{...r,startedAt:undefined},s,10),'remove');
});
test('Process: inner shell exit removes metadata without redundant kill',()=>assert.equal(closeAction(2,r,undefined,10),'remove'));
test('Process: detach/failed attach/crashed client retains existing shell identity',()=>assert.equal(closeAction(2,r,s,10),'keep'));
test('matching ignores display rename and requires token, executable, socket and session',()=>{
  const options={name:'user-renamed',shellPath:r.backend.executable,shellArgs:new Shpool(r.backend).args(r.sessionName),env:{[identityKey]:r.id}};
  assert.equal(matches(r,options),true);
  for (const changes of [{shellPath:'/bin/bash'},{env:{}},{shellArgs:['attach','project-2']},{env:{[identityKey]:'different'}}]) assert.equal(matches(r,{...options,...changes}),false);
});
test('state validation rejects foreign/malformed/duplicate metadata',()=>{
  assert.deepEqual(records([r,r,{...r,id:'other',workspace:'foreign'},{...r,id:'bad',sessionName:'../oops'}],'ws'),[r]);
  assert.deepEqual(records({},'ws'),[]);
});
test('safe names normalize unicode/whitespace/templates and supply fallback',()=>{
  for (const name of ['ResearchClawBench','hello world','../{workspace}','研究','-danger','école']) assert.ok(safeName(`${prefix(name)}-1`));
  assert.equal(prefix('ResearchClawBench'),'ResearchClawBench');
  assert.equal(prefix('研究'),'persistent');
  assert.equal(safeName('-bad'),false);
});
test('concurrent windows reserve unique names, including same-basename workspaces',async()=>{
  const root=await mkdtemp(join(tmpdir(),'shpool-names-'));
  try {
    const names=await Promise.all(Array.from({length:12},(_,i)=>reserveName(root,'project',`workspace-${i}`,['project-1'])));
    assert.equal(new Set(names).size,12);
    assert.ok(!names.includes('project-1'));
    const again=await reserveName(root,'project','workspace-0',[]);
    assert.equal(again,'project-1'); // external name disappeared, never reserved by us
    assert.equal(await reserveName(root,'project','workspace-0',[]),'project-14');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('real OS workspace lock prevents concurrent owners and releases cleanly',async()=>{
  const root=await mkdtemp(join(tmpdir(),'shpool-lock-'));
  let release;
  try {
    release=await lockWorkspace(root,'workspace');
    await assert.rejects(lockWorkspace(root,'workspace'),/already has an active/);
    release(); release=undefined;
    await new Promise(r=>setTimeout(r,100));
    release=await lockWorkspace(root,'workspace');
  } finally {release?.();await new Promise(r=>setTimeout(r,100));await rm(root,{recursive:true,force:true});}
});
test('JSON parser fails closed on missing fields; never interprets errors as empty sessions',()=>{
  const source={sessions:[{name:'project-2',started_at_unix_ms:123,status:'Attached',attachments:[{pid:10}]}]};
  assert.deepEqual(parseSessions(JSON.stringify(source)),[{...s,status:'Attached',attachments:[10]}]);
  assert.throws(()=>parseSessions('not json'));
  assert.throws(()=>parseSessions('{}'));
  assert.throws(()=>parseSessions('{"sessions":[{"name":"x"}]}'));
});
test('direct attach arguments contain no shell wrapper or program startup command',()=>{
  assert.deepEqual(new Shpool(r.backend).args('project-2'),['--socket','/tmp/socket','attach','--dir','.','project-2']);
  assert.deepEqual(new Shpool(r.backend).args('project-2',true),['--socket','/tmp/socket','attach','--force','--dir','.','project-2']);
  assert.throws(()=>new Shpool(r.backend).args('../bad'));
});

test('durable atomic metadata survives an empty VS Code mirror and preserves removal tombstone',async()=>{
  const {loadState,writeState}=require('../out/backend');
  const root=await mkdtemp(join(tmpdir(),'shpool-state-'));
  try{
    assert.equal(await loadState(root,'ws'),undefined);
    await writeState(root,'ws',[r]);assert.deepEqual(await loadState(root,'ws'),[r]);
    await writeState(root,'ws',[]);assert.deepEqual(await loadState(root,'ws'),[]);
    assert.equal(await loadState(root,'other-ws'),undefined);
  }finally{await rm(root,{recursive:true,force:true})}
});
