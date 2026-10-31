// Acquisition verifier: Node standard library only. Never imports installed packages.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,realpathSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function verifyNpmConfigs(directory='/acquisition-config') {
 const dir=lstatSync(directory);assert(dir.isDirectory()&&!dir.isSymbolicLink());assert.equal(dir.uid,process.getuid());
 const configs=['user','global'].map(layer=>{
  const path=join(directory,layer+'.npmrc'),stat=lstatSync(path);
  assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.uid,process.getuid());assert.equal(stat.nlink,1);assert.equal(stat.mode&0o777,0o600);assert.equal(stat.size,0);
  const bytes=readFileSync(path);assert.equal(bytes.length,0);
  return {layer,path,bytes:0,sha256:hash(bytes),inode:stat.ino,device:stat.dev};
 });
 assert.notEqual(configs[0].path,configs[1].path);assert(configs[0].device!==configs[1].device||configs[0].inode!==configs[1].inode,'npm config layers share a file');
 return configs;
}
export function prepareNpmConfigs(directory='/acquisition-config') {
 // Fresh task-owned paths only: never read, reuse or truncate an existing npm config.
 mkdirSync(directory,{mode:0o700});
 for(const layer of ['user','global'])writeFileSync(join(directory,layer+'.npmrc'),'',{flag:'wx',mode:0o600});
 return verifyNpmConfigs(directory);
}
export function validateRegistryLock(lock) {
 for(const [p,x] of Object.entries(lock.packages)) if(p) {
  assert(p.startsWith('node_modules/')&&!p.split('/').includes('..'));
  const u=new URL(x.resolved);assert.equal(u.protocol,'https:');assert.equal(u.hostname,'registry.npmjs.org');assert.equal(u.port,'');assert.equal(u.username,'');assert.equal(u.password,'');
  assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(x.version));assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(x.integrity));
 } return true;
}
export function validateInstalled(installed,lock) {
 const seen=new Set();for(const x of installed){assert(!seen.has(x.path),'duplicate package');seen.add(x.path);assert(lock.packages[x.path],'non-lock package '+x.path);assert.equal(x.version,lock.packages[x.path].version,x.path);}
 for(const [p,x] of Object.entries(lock.packages))if(p&&!x.optional)assert(seen.has(p),'missing required '+p);
 return true;
}
export function treeFiles(root) {
 const out={};
 function visit(dir) {
  for(const name of readdirSync(dir).sort()) {const p=join(dir,name),s=lstatSync(p),relative=p.slice(root.length+1);
   if(s.isSymbolicLink()) {assert(realpathSync(p).startsWith(root+'/'),'escaping symlink');out[relative]={symlink:realpathSync(p).slice(root.length+1)};}
   else if(s.isDirectory()) visit(p);else {assert(s.isFile(),'nonregular payload');out[relative]={sha256:hash(readFileSync(p)),bytes:s.size};}
  }
 } visit(root);return out;
}
export function acquire(root='/probe') {
 assert.equal(process.version,'v24.20.0');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
 const tooling=join(root,'tooling'),lockBytes=readFileSync(join(tooling,'package-lock.json')),packageBytes=readFileSync(join(tooling,'package.json'));
 assert.equal(hash(lockBytes),'34d3a864ec1bdcd9b96a7236239abef874a47fdc33e4318c0474c67d6bb91ae1');
 assert.equal(hash(packageBytes),'6e0e2fadbf2d5bacb5edf3df90650245e3a0c2baec7ed6b4a69f3a6b7c9a7bc4');
 const lock=JSON.parse(lockBytes);validateRegistryLock(lock);
 if(process.argv.includes('--preflight')) return;
 const tree=treeFiles(tooling),installed=[];
 function modules(base) {if(!existsSync(base))return;for(const n of readdirSync(base)) {if(n.startsWith('.'))continue;const group=n.startsWith('@')?readdirSync(join(base,n)).map(s=>n+'/'+s):[n];for(const name of group){const dir=join(base,name),p=dir.slice(tooling.length+1),meta=JSON.parse(readFileSync(join(dir,'package.json'))),expected=lock.packages[p];assert(expected,'non-lock package '+p);assert.equal(meta.version,expected.version,p);installed.push({path:p,version:meta.version,integrity:expected.integrity});modules(join(dir,'node_modules'));}}}
 modules(join(tooling,'node_modules'));
 validateInstalled(installed,lock);
 for(const p of ['node_modules/@cloudflare/workerd-linux-64','node_modules/miniflare/node_modules/@img/sharp-linux-x64','node_modules/miniflare/node_modules/@img/sharp-libvips-linux-x64'])assert(installed.some(i=>i.path===p),'missing required platform payload '+p);
 // npm ci validates registry tarball SRI. Record exact extracted files for offline recheck.
 // No custom downloader, solver, tar installer, lifecycle script or online repair.
 writeFileSync(join(root,'frozen-tree.json'),JSON.stringify(tree));
 const osRelease=readFileSync('/etc/os-release','utf8');assert(/^ID=debian$/m.test(osRelease));assert(/^VERSION_CODENAME=trixie$/m.test(osRelease));
 const npmConfigs=verifyNpmConfigs();
 assert.equal(process.env.npm_config_userconfig,npmConfigs[0].path);assert.equal(process.env.npm_config_globalconfig,npmConfigs[1].path);
 const evidence={schema:1,npmConfigs,osRelease,node:process.version,npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,glibc:process.report.getReport().header.glibcVersionRuntime,installed,packageSha256:hash(packageBytes),lockSha256:hash(lockBytes),treeSha256:hash(Buffer.from(JSON.stringify(tree))),tarballIntegrity:'trusted bundled npm ci with unchanged lock SRI; npm cache verify recorded in build output',lifecycleScripts:false,optionalPayloads:'Exact locked optional installs recorded; unused features remain untested'};
 assert(evidence.glibc);writeFileSync(join(root,'acquisition.json'),JSON.stringify(evidence));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 if(process.argv.slice(2).join(' ')==='--prepare-npm-config')console.log('D0_NPM_CONFIG '+JSON.stringify(prepareNpmConfigs()));
 else acquire();
}
