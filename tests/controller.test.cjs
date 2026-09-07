const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const backend=require('../out/backend');
const runtime=require('../out/runtime');
runtime.bundledBackend=async()=>({executable:'/bin/shpool',socket:'/tmp/test.sock'});
runtime.runtimeLock=async()=>({version:'0.11.4'});
const {stateKey}=require('../out/lifecycle');
let h;
const noOp=()=>({dispose(){}});
const api={
  env:{language:'en'},
  workspace:{isTrusted:true,name:'test-project',workspaceFolders:[{uri:{fsPath:'/tmp'}}],getConfiguration(){return {get(_k,v){return v}}}},
  TerminalExitReason:{Unknown:0,Shutdown:1,Process:2,User:3,Extension:4},
  TerminalProfile:class {constructor(options){this.options=options}},
  window:{
    get terminals(){return h.terminals},
    createOutputChannel(){return {appendLine(v){h.log.push(v)},dispose(){}}},
    registerTerminalProfileProvider(_id,p){h.provider=p;return noOp()},
    onDidOpenTerminal(fn){h.open=fn;return noOp()},onDidCloseTerminal(fn){h.close=fn;return noOp()},
    createTerminal(options){return h.make(options)},
    showErrorMessage(v){h.errors.push(v);return Promise.resolve()},
    showWarningMessage(v,action){h.warnings.push({v,action});return Promise.resolve(h.consent? action:undefined)},
  },
  commands:{registerCommand(id,fn){h.commands[id]=fn;return noOp()}},
};
const original=Module._load;
Module._load=function(id,...rest){if(id==='vscode')return api;return original.call(this,id,...rest)};
const extension=require('../out/extension');
Module._load=original;
backend.discover=async()=>({executable:'/bin/shpool',socket:'/tmp/test.sock'});
backend.lockWorkspace=async()=>{if(h.lockError)throw Error('lock busy');return ()=>{}};
backend.loadState=async()=>h.disk;
backend.writeState=async(_root,_workspace,value)=>{if(h.diskError)throw Error('disk failed');h.disk=structuredClone(value)};
backend.reserveName=async(_root,base,_ws,existing)=>{let n=1;while(existing.includes(`${base}-${n}`))n++;return `${base}-${n}`};
backend.Shpool.prototype.list=async function(){if(h.listError)throw Error('daemon unavailable');return [...h.sessions.values()]};
backend.Shpool.prototype.create=async function(name){const s={name,startedAt:++h.pid*100,status:'Disconnected',attachments:[]};h.sessions.set(name,s);return s};
backend.Shpool.prototype.kill=async function(name){h.kills.push(name);h.sessions.delete(name)};
async function setup(saved,disk){
  h={terminals:[],sessions:new Map(),commands:{},errors:[],warnings:[],log:[],kills:[],value:saved||[],disk,pid:10};
  h.context={subscriptions:[],workspaceState:{get(k){return k===stateKey?structuredClone(h.value):undefined},async update(k,v){if(h.mirrorError)throw Error('mirror failed');if(k===stateKey)h.value=structuredClone(v)}}};
  h.make=options=>{
    const pid=++h.pid;
    const t={name:options.name,creationOptions:options,processId:Promise.resolve(pid),show(){},dispose(){h.end(t,4)}};
    h.terminals.push(t);
    const name=options.shellArgs?.at(-1);
    if(options.shellPath==='/bin/shpool'){
      const old=h.sessions.get(name);
      h.sessions.set(name,{name,startedAt:old?.startedAt||pid*100,status:'Attached',attachments:[pid]});
    }
    h.open(t);return t;
  };
  h.end=(t,reason,remove=false)=>{
    h.terminals=h.terminals.filter(v=>v!==t);
    const name=t.creationOptions.shellArgs?.at(-1),s=h.sessions.get(name);
    if(s){s.attachments=[];s.status='Disconnected'}
    if(remove)h.sessions.delete(name);
    t.exitStatus={reason,code:0};h.close(t);
  };
  await extension.activate(h.context);
  h.flush=()=>h.commands['shpool.restore']();
  h.create=async()=>{const p=await h.provider.provideTerminalProfile({isCancellationRequested:false});const t=h.make(p.options);await h.flush();return t};
  return h;
}
const finish=()=>{extension.deactivate();for(const d of h.context.subscriptions)d.dispose()};
test('actual controller: native profile, three names, mixed ordinary shells, exact User kill and rename',async()=>{
  await setup();try{
    const ordinary=h.make({name:'zsh',shellPath:'/bin/zsh'});
    const a=await h.create(),b=await h.create(),c=await h.create();
    assert.deepEqual([a.name,b.name,c.name],['test-project-1','test-project-2','test-project-3']);
    assert.equal(a.creationOptions.isTransient,false);
    b.name='misleading-display-name';h.end(b,3);await h.flush();
    assert.deepEqual(h.kills,['test-project-2']);
    assert.deepEqual(h.value.map(r=>r.sessionName),['test-project-1','test-project-3']);
    h.end(ordinary,3);await h.flush();assert.equal(h.kills.length,1);
  }finally{finish()}
});
test('actual controller: Process removes exited shell, but retains failed attach or surviving shell',async()=>{
  await setup();try{
    const a=await h.create();h.end(a,2,true);await h.flush();
    assert.equal(h.value.length,0);assert.deepEqual(h.kills,[]);
    const b=await h.create();h.end(b,2);await h.flush();
    assert.equal(h.value.length,1);assert.deepEqual(h.kills,[]);
  }finally{finish()}
});
for(const reason of [0,1,4])test(`actual controller: reason ${reason} never kills and keeps metadata`,async()=>{
  await setup();try{const t=await h.create();h.end(t,reason);await h.flush();assert.equal(h.value.length,1);assert.deepEqual(h.kills,[])}finally{finish()}
});
test('actual controller: saved metadata restores same name once; missing daemon sessions become fresh shells',async()=>{
  await setup();await h.create();const saved=h.value;finish();
  await setup(saved);try{
    await h.flush();await h.flush();
    assert.equal(h.terminals.length,1);assert.equal(h.terminals[0].name,'test-project-1');
    assert.equal(h.terminals[0].creationOptions.shellArgs.includes('--force'),false);
  }finally{finish()}
});
test('actual controller: occupied session prompts once, never steals without explicit consent',async()=>{
  await setup();await h.create();const saved=h.value;finish();
  await setup(saved);try{
    h.sessions.set('test-project-1',{name:'test-project-1',startedAt:saved[0].startedAt,status:'Attached',attachments:[999]});
    await h.flush();assert.equal(h.terminals.length,0);assert.equal(h.warnings.length,1);assert.equal(h.kills.length,0);
    h.consent=true;await h.flush();await h.flush();
    assert.equal(h.terminals.length,1);assert.ok(h.terminals[0].creationOptions.shellArgs.includes('--force'));
    assert.equal(h.terminals[0].creationOptions.isTransient,true,'one-time force consent must not become an automatic force revive');
  }finally{finish()}
});
test('actual controller: list failure on User retains deletion intent without issuing blind kill',async()=>{
  await setup();try{
    const t=await h.create();h.listError=true;h.end(t,3);await h.flush();
    assert.equal(h.value.length,0);assert.equal(h.kills.length,0);assert.ok(h.errors.length);
  }finally{finish()}
});
test('actual controller: cancelled profile never records a terminal',async()=>{
  await setup();try{
    assert.equal(await h.provider.provideTerminalProfile({isCancellationRequested:true}),undefined);assert.equal(h.value.length,0);
  }finally{finish()}
});
test('actual controller: durable identities override a lost or stale workspaceState mirror',async()=>{
  await setup();await h.create();const saved=h.disk;finish();
  await setup([],saved);try{await h.flush();assert.equal(h.terminals.length,1)}finally{finish()}
  await setup(saved,[]);try{await h.flush();assert.equal(h.terminals.length,0);assert.equal(h.kills.length,0)}finally{finish()}
});

test('immediate trash before observation still kills the prepared generation',async()=>{
 await setup();try{const p=await h.provider.provideTerminalProfile({isCancellationRequested:false});const t=h.make(p.options);h.end(t,3);await h.flush();assert.deepEqual(h.kills,['test-project-1']);assert.equal(h.disk.length,0)}finally{finish()}
});
test('durable write failure prevents launch and kill',async()=>{
 await setup();try{h.diskError=true;assert.equal(await h.provider.provideTerminalProfile({isCancellationRequested:false}),undefined);assert.equal(h.sessions.size,0);assert.deepEqual(h.kills,[])}finally{finish()}
});
test('mirror failure does not discard authoritative identities',async()=>{
 await setup();try{h.mirrorError=true;await h.create();assert.equal(h.disk.length,1);assert.equal(h.terminals.length,1)}finally{finish()}
});
test('early User close waits for disappearing attachment when processId is unpublished',async()=>{
 await setup();try{
  const p=await h.provider.provideTerminalProfile({isCancellationRequested:false});const t=h.make(p.options);
  t.processId=Promise.resolve(undefined);h.end(t,3);h.sessions.get(t.name).attachments=[999];
  setTimeout(()=>{const s=h.sessions.get(t.name);if(s)s.attachments=[]},50);
  await h.flush();assert.deepEqual(h.kills,[t.name]);
 }finally{finish()}
});
