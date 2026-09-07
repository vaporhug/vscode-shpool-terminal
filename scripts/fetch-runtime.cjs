// Build-time only. No downloads or archive extraction happen in the installed extension.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),lock=require('../runtime.lock.json');
const target=process.argv[2]||'linux-x64',asset=lock.targets[target];
if(!asset)throw Error(`Unsupported target: ${target}`);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const output=path.join(root,'vendor',target,'shpool');
if(fs.existsSync(output)&&sha(fs.readFileSync(output))===asset.binarySha256){console.log(`Verified shpool ${lock.version} ${target}`);process.exit(0)}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'shpool-fetch-'));
try{
 const archive=path.join(tmp,'runtime.tar.gz');
 cp.execFileSync('curl',['--fail','--location','--silent','--show-error','--retry','2','--max-time','120',asset.url,'--output',archive],{stdio:'inherit'});
 if(sha(fs.readFileSync(archive))!==asset.archiveSha256)throw Error('Official archive checksum mismatch');
 // Read exactly one fixed archive member to stdout; no archive-controlled paths are written.
 const binary=cp.execFileSync('tar',['-xOf',archive,'shpool'],{maxBuffer:64*1024*1024});
 if(sha(binary)!==asset.binarySha256)throw Error('Pinned binary checksum mismatch');
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,binary,{mode:0o755});
 console.log(`Verified shpool ${lock.version} ${target}`);
}finally{fs.rmSync(tmp,{recursive:true,force:true})}
