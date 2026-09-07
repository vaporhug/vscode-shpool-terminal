const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {bundledBackend}=require('../out/runtime');
const source=path.resolve(__dirname,'..');
test('bundled runtime is pinned, immutable across installs, and isolated from system daemon',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shpool-runtime-'));
 try{
  const state=path.join(root,'state'),socket=path.join(root,'run');
  const [a,b]=await Promise.all([bundledBackend(source,state,socket),bundledBackend(source,state,socket)]);
  assert.deepEqual(a,b);assert.ok(a.executable.startsWith(state));assert.ok(a.socket.includes('/vscode-shpool/0.11.4-'));
  const inode=(await fs.stat(a.executable)).ino;
  const moved=path.join(root,'replacement');await fs.mkdir(moved);await fs.copyFile(path.join(source,'runtime.lock.json'),path.join(moved,'runtime.lock.json'));
  assert.deepEqual(await bundledBackend(moved,state,socket),a,'cached runtime survives removal of old extension files');
  assert.equal((await fs.stat(a.executable)).ino,inode,'never replace a potentially active runtime inode');
  await fs.writeFile(a.executable,'corrupt');
  await assert.rejects(bundledBackend(source,state,socket),/checksum mismatch/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('unsupported target and corrupt bundled runtime fail before execution',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shpool-runtime-'));
 try{
  await fs.copyFile(path.join(source,'runtime.lock.json'),path.join(root,'runtime.lock.json'));
  await fs.mkdir(path.join(root,'vendor/linux-x64'),{recursive:true});await fs.writeFile(path.join(root,'vendor/linux-x64/shpool'),'invalid');
  await assert.rejects(bundledBackend(root,path.join(root,'state'),root),/checksum mismatch/);
  await assert.rejects(bundledBackend(source,root,root,'','darwin-arm64'),/unavailable/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
