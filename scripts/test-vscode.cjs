// Run in an isolated official VS Code Desktop. No existing profile/server is changed.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const code=process.env.VSCODE_EXECUTABLE;
if(!code||!path.isAbsolute(code))throw Error('Set VSCODE_EXECUTABLE to the official VS Code Desktop executable (absolute path).');
const binary=process.env.SHPOOL_TEST_BINARY||path.resolve(__dirname,'../vendor/linux-x64/shpool');
const extension=path.resolve(__dirname,'..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vscode-shpool-vscode-'));
console.log('Isolated test directory:',root);
const lock=require('../runtime.lock.json');
const socket=path.join(root,'run','vscode-shpool',`${lock.version}-${lock.targets['linux-x64'].binarySha256.slice(0,8)}`,'shpool.sock');
fs.mkdirSync(path.dirname(socket),{recursive:true,mode:0o700});
const user=path.join(root,'user');fs.mkdirSync(path.join(user,'User'),{recursive:true});
const workspace=path.join(root,'test-project');fs.mkdirSync(workspace);
fs.writeFileSync(path.join(user,'User/settings.json'),JSON.stringify({
 'security.workspace.trust.enabled':false,'telemetry.telemetryLevel':'off','update.mode':'none',
 'terminal.integrated.enablePersistentSessions':true,'terminal.integrated.persistentSessionReviveProcess':'onExitAndWindowClose',
 'terminal.integrated.confirmOnExit':'never','terminal.integrated.confirmOnKill':'never',
 'workbench.startupEditor':'none','window.restoreWindows':'all',
}));
fs.writeFileSync(path.join(root,'shpool.toml'),'shell = "/bin/bash"\nnorc = true\nprompt_prefix = ""\n');
const logfile=fs.openSync(path.join(root,'driver.log'),'a');
const daemon=cp.spawn(binary,['--socket',socket,'--config-file',path.join(root,'shpool.toml'),'daemon'],{stdio:['ignore',logfile,logfile]});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const vsix=process.env.VSCODE_TEST_VSIX;
if(vsix){
 const cli=path.join(path.dirname(code),'bin/code');
 cp.execFileSync(cli,['--no-sandbox',`--user-data-dir=${user}`,`--extensions-dir=${root}/extensions`,'--install-extension',path.resolve(vsix),'--force'],{stdio:'inherit'});
}
const args=['--no-sandbox','--disable-gpu','--disable-workspace-trust','--skip-welcome','--skip-release-notes',`--user-data-dir=${user}`,`--shared-data-dir=${root}/shared`,`--extensions-dir=${root}/extensions`,...(vsix?[]:[`--extensionDevelopmentPath=${extension}`]),`--extensionDevelopmentPath=${extension}/tests/vscode-fixture`,workspace];
const env={...process.env,SHPOOL_VSCODE_TEST_ROOT:root,SHPOOL_TEST_BINARY:binary,SHPOOL_TEST_SOCKET:socket,XDG_RUNTIME_DIR:path.join(root,'run'),XDG_STATE_HOME:path.join(root,'state')};
// Electron's CLI is a shell script in some distributions. Pass argv as an array either way.
async function launch(crash=false){
 const child=cp.spawn(code,args,{env,detached:true,stdio:['ignore',logfile,logfile]});
 const poll=crash?setInterval(()=>{
  const log=fs.existsSync(path.join(root,'events.jsonl'))?fs.readFileSync(path.join(root,'events.jsonl'),'utf8'):'';
  if(log.includes('"ready-to-crash"')){clearInterval(poll);process.kill(-child.pid,'SIGKILL');}
 },200):undefined;
 const timeout=setTimeout(()=>child.kill('SIGKILL'),90000);
 const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}))});clearTimeout(timeout);clearInterval(poll);
 if(crash)assert.equal(status.signal,'SIGKILL');else {assert.equal(status.signal,null,'VS Code exceeded timeout');assert.equal(status.code,0);}
 const events=fs.readFileSync(path.join(root,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(!events.some(e=>e.event==='failure'),JSON.stringify(events.filter(e=>e.event==='failure')));
 return events;
}
(async()=>{
 try{
  for(let i=0;i<50&&!fs.existsSync(socket);i++)await delay(100);
  let events=await launch();assert.ok(events.some(e=>e.event==='ready-to-close'&&e.phase===1));
  const list=()=>JSON.parse(cp.execFileSync(binary,['--socket',socket,'list','--json'],{encoding:'utf8'})).sessions;
  assert.equal(list().length,1,'window close must keep shell alive');
  events=await launch(true);assert.ok(events.some(e=>e.event==='ready-to-crash'));
  assert.equal(list().length,1,'crash must keep shell alive');
  events=await launch();assert.ok(events.some(e=>e.event==='ready-to-close'&&e.phase===3));
  for(const event of events.filter(e=>e.event==='pass'))console.log('PASS:',event.test);
  console.log('Evidence:',path.join(root,'events.jsonl'));
 }finally{
  try{const sessions=JSON.parse(cp.execFileSync(binary,['--socket',socket,'list','--json'],{encoding:'utf8'})).sessions;for(const s of sessions)cp.execFileSync(binary,['--socket',socket,'kill',s.name])}catch{}
  daemon.kill();fs.closeSync(logfile);
 }
})().catch(e=>{console.error(e);process.exitCode=1});
