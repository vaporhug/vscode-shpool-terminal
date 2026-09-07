const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
for(const name of fs.readdirSync(path.join(__dirname,'../tests')).filter(n=>n.endsWith('.test.cjs')).sort())
 cp.execFileSync(process.execPath,[path.join(__dirname,'../tests',name)],{stdio:'inherit'});
