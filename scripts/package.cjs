const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
const target=process.argv[2]||'linux-x64';
cp.execFileSync(process.execPath,[path.join(__dirname,'fetch-runtime.cjs'),target],{cwd:root,stdio:'inherit'});
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
cp.execFileSync(process.execPath,[path.join(root,'node_modules/@vscode/vsce/vsce'),'package','--target',target,'--pre-release','--no-dependencies','--out',`artifacts/${pkg.name}-${pkg.version}-${target}.vsix`],{cwd:root,stdio:'inherit'});

const artifact=path.join(root,`artifacts/${pkg.name}-${pkg.version}-${target}.vsix`);
const digest=require("node:crypto").createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
fs.writeFileSync(`${artifact}.sha256`,`${digest}  ${path.basename(artifact)}\n`);
