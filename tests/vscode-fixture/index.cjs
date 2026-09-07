// Test-only driver. It may run shell commands in its own isolated test terminals.
const v=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.env.SHPOOL_VSCODE_TEST_ROOT;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const record=(event,data={})=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({event,...data})+'\n');
const sessions=()=>JSON.parse(cp.execFileSync(process.env.SHPOOL_TEST_BINARY,['--socket',process.env.SHPOOL_TEST_SOCKET,'list','--json'],{encoding:'utf8'})).sessions;
async function until(fn,seconds=30){const end=Date.now()+seconds*1000;while(Date.now()<end){const result=await fn();if(result)return result;await delay(200)}throw Error('Timed out: '+fn.toString())}
const persistent=()=>v.window.terminals.filter(t=>!!t.creationOptions.env?.VSCODE_SHPOOL_TERMINAL_ID);
exports.activate=async context=>{
 if(!root)return;
 v.window.onDidOpenTerminal(t=>record('open',{name:t.name,options:t.creationOptions}));
 v.window.onDidCloseTerminal(t=>record('close',{name:t.name,exit:t.exitStatus}));
 try{
  await v.extensions.getExtension('vaporhug.vscode-shpool-terminal').activate();
  // Test coordination uses a file: VS Code's workspaceState promise is not a disk flush.
  const phaseFile=path.join(root,'test-phase');
  const phase=fs.existsSync(phaseFile)?Number(fs.readFileSync(phaseFile,'utf8')):0;
  record('activate',{phase,version:v.version,terminals:v.window.terminals.map(t=>({name:t.name,options:t.creationOptions}))});
  if(phase===0){
   const normal=v.window.createTerminal({name:'ordinary-zsh',shellPath:'/usr/bin/zsh'});normal.show();
   // The native action's profileName shortcut only searches detected shell profiles.
   // Its contributed-profile menu passes this same config object to the action.
   for(let i=0;i<3;i++)await v.commands.executeCommand('workbench.action.terminal.newWithProfile',{config:{extensionIdentifier:'vaporhug.vscode-shpool-terminal',id:'shpool.persistent',title:'Shpool Persistent'}});
   const bash=v.window.createTerminal({name:'ordinary-bash',shellPath:'/bin/bash'});bash.show();
   await until(()=>persistent().length===3&&sessions().length===3);
   const [a,b,c]=persistent().sort((a,b)=>a.name.localeCompare(b.name));
   assert.deepEqual([a.name,b.name,c.name],['test-project-1','test-project-2','test-project-3']);
   assert.equal(normal.creationOptions.shellPath,'/usr/bin/zsh');assert.equal(bash.creationOptions.shellPath,'/bin/bash');
   assert.ok(a.creationOptions.shellArgs.every(s=>!s.includes('codex')));
   record('pass',{test:'1-4 profiles, names, mixed terminals'});
   a.sendText(`echo $$ > '${root}/shell.pid'; while true; do date +%s >> '${root}/heartbeat'; sleep 0.2; done`);
   b.sendText(`echo $$ > '${root}/shell2.pid'; while true; do sleep 1; done`);
   await until(()=>fs.existsSync(path.join(root,'heartbeat'))&&fs.existsSync(path.join(root,'shell2.pid')));
   await delay(2200); // let production observer persist generation
   const generation=sessions().find(s=>s.name===a.name).started_at_unix_ms;
   const shellPid=Number(fs.readFileSync(path.join(root,'shell.pid'),'utf8').trim());
   await context.workspaceState.update('generation',generation);await context.workspaceState.update('shellPid',shellPid);
   b.show();await delay(200);await v.commands.executeCommand('workbench.action.terminal.kill');
   await until(()=>!sessions().some(s=>s.name===b.name));
   const pid2=Number(fs.readFileSync(path.join(root,'shell2.pid'),'utf8').trim());
   await until(()=>{try{return fs.readFileSync(`/proc/${pid2}/stat`,'utf8').split(') ')[1][0]==='Z'}catch{return true}});
   assert.ok(sessions().some(s=>s.name===a.name)&&sessions().some(s=>s.name===c.name));
   record('pass',{test:'8,13 native Kill Terminal kills only project-2 and its running shell'});
   c.sendText('exit');await until(()=>!sessions().some(s=>s.name===c.name));
   await delay(2000);record('pass',{test:'9 shell exit'});
   await v.commands.executeCommand('workbench.action.terminal.newWithProfile',{config:{extensionIdentifier:'vaporhug.vscode-shpool-terminal',id:'shpool.persistent',title:'Shpool Persistent'}});
   await until(()=>sessions().some(s=>s.name==='test-project-4'));await delay(2000);
   await v.commands.executeCommand('workbench.action.terminal.newWithProfile',{config:{extensionIdentifier:'vaporhug.vscode-shpool-terminal',id:'shpool.persistent',title:'Shpool Persistent'}});
   const immediate=await until(()=>persistent().find(t=>t.name==='test-project-5'));
   immediate.show();await v.commands.executeCommand('workbench.action.terminal.kill');
   await until(()=>!sessions().some(s=>s.name==='test-project-5'));
   record('pass',{test:'immediate native trash cleans a prepared session without waiting for observation'});
   await context.workspaceState.update('phase',1);
   fs.writeFileSync(phaseFile,'1');
   void v.commands.executeCommand('workbench.action.reloadWindow').then(undefined,()=>{});
  }else{
   await until(()=>sessions().some(s=>s.name==='test-project-1')&&v.window.terminals.some(t=>t.name==='test-project-1'));
   await delay(7000); // includes native restore and fallback grace
   if(phase===1){
    const native=v.window.terminals.find(t=>t.name==='test-project-4');assert.ok(native);
    record('native-restored-options',{options:native.creationOptions});
    native.show();await delay(200);await v.commands.executeCommand('workbench.action.terminal.kill');
    await until(()=>!sessions().some(s=>s.name==='test-project-4'));
    record('pass',{test:'native-reconnected terminal identity survives incomplete creationOptions; User kill succeeds'});
   }
   assert.equal(v.window.terminals.filter(t=>t.name==='test-project-1').length,1);
   assert.equal(sessions().length,1);
   assert.equal(sessions()[0].started_at_unix_ms,context.workspaceState.get('generation'));
   process.kill(context.workspaceState.get('shellPid'),0);
   assert.ok(!v.window.terminals.some(t=>['test-project-2','test-project-3'].includes(t.name)));
   const before=fs.statSync(path.join(root,'heartbeat')).size;await delay(800);assert.ok(fs.statSync(path.join(root,'heartbeat')).size>before);
   record('pass',{test:phase===1?'6 reload keeps PID, no duplicate, no resurrection':phase===2?'7 reopen keeps PID and auto attaches':'10 crash recovery keeps PID and auto attaches',terminals:v.window.terminals.map(t=>({name:t.name,options:t.creationOptions}))});
   await context.workspaceState.update('phase',phase+1);
   fs.writeFileSync(phaseFile,String(phase+1));
   if(phase===2){record('ready-to-crash');return;}
   if(phase===3){
    v.window.terminals.find(t=>t.name==='test-project-1').show();await delay(200);
    await v.commands.executeCommand('workbench.action.terminal.kill');
    await until(()=>sessions().length===0);
    record('pass',{test:'restored terminal maps to original session and native Kill Terminal cleans it'});
   }
   record('ready-to-close',{phase});
   void v.commands.executeCommand('workbench.action.quit').then(undefined,()=>{});
  }
 }catch(error){record('failure',{error:error.stack||String(error)});void v.commands.executeCommand('workbench.action.quit').then(undefined,()=>{})}
};
