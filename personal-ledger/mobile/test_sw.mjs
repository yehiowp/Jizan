import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {files,releaseVersion} from './prepare.mjs';
const code=readFileSync(new URL('./dist/sw.js',import.meta.url),'utf8');
function worker({login=false,redirected=false}={}){const handlers={},stores=new Map(),calls=[];let offline=false;const caches={async open(name){if(!stores.has(name))stores.set(name,new Map());const map=stores.get(name);return {async put(req,res){map.set(req.url,res.clone())},async match(req){return map.get(req.url)?.clone()}}},async keys(){return [...stores.keys()]},async delete(name){return stores.delete(name)}};
  const fetch=async req=>{calls.push(req.url);if(offline)throw Error('offline');const response=new Response(req.url.endsWith('/')||req.url.endsWith('index.html')?(login?'login required':'<meta name="ledger-app-shell" content="1">'):'synthetic asset',{status:200});Object.defineProperty(response,'url',{value:req.url});if(redirected)Object.defineProperty(response,'redirected',{value:true});return response;};
  const self={location:new URL('https://ledger.test/sw.js'),clients:{async claim(){}},addEventListener(type,fn){handlers[type]=fn}};vm.runInNewContext(code,{self,caches,fetch,Request,Response,URL,Set,Error});return {handlers,stores,calls,setOffline:()=>offline=true,run(type,event={}){let promise;handlers[type]({...event,waitUntil:p=>promise=p,respondWith:p=>promise=p});return promise}};
}
test('release cache name is content-versioned',()=>{assert.match(code,/personal-ledger-shell-[a-f0-9]{16}/);assert.doesNotMatch(code,/skipWaiting/)});
test('prepared shell and assets reload without any network',async()=>{const w=worker();await w.run('install');await w.run('activate');w.setOffline();for(const path of ['/','/app.mjs','/core.mjs','/apple-pay-guide.html']){const response=await w.run('fetch',{request:new Request('https://ledger.test'+path)});assert.equal(response.status,200);assert.ok((await response.text()).length>0)}});
test('login response cannot be cached as ledger shell',async()=>{const w=worker({login:true});await assert.rejects(w.run('install'),/Login page cannot/)});
test('service worker leaves cross-origin and non-GET requests untouched',()=>{const w=worker();assert.equal(w.run('fetch',{request:new Request('https://external.test/a')}),undefined);assert.equal(w.run('fetch',{request:new Request('https://ledger.test/',{method:'POST',body:'private'})}),undefined)});
test('installed shell is served from one cache version without asking the network',async()=>{const w=worker();await w.run('install');await w.run('activate');const installed=w.calls.length;assert.equal(installed,10);
  for(const path of ['/','/index.html','/app.mjs','/style.css','/?source=homescreen#top']){const response=await w.run('fetch',{request:new Request('https://ledger.test'+path)});assert.equal(response.status,200)}
  assert.equal(w.calls.length,installed);
  const other=await w.run('fetch',{request:new Request('https://ledger.test/not-cached.json')});assert.equal(await other.text(),'synthetic asset');assert.equal(w.calls.length,installed+1);});
test('redirected shell is stored as a clean copy that navigation can use',async()=>{const w=worker({redirected:true});await w.run('install');await w.run('activate');w.setOffline();
  const response=await w.run('fetch',{request:new Request('https://ledger.test/')});assert.equal(response.redirected,false);assert.match(await response.text(),/ledger-app-shell/);});
test('offline navigation to an unknown in-scope page falls back to the ledger shell',async()=>{const w=worker();await w.run('install');await w.run('activate');w.setOffline();
  const page=await w.run('fetch',{request:{method:'GET',mode:'navigate',url:'https://ledger.test/old-bookmark'}});assert.match(await page.text(),/ledger-app-shell/);
  await assert.rejects(w.run('fetch',{request:{method:'GET',mode:'cors',url:'https://ledger.test/missing.json'}}),/offline/);});
test('activation removes only older ledger shell caches',async()=>{const w=worker();w.stores.set('personal-ledger-shell-0000000000000000',new Map());w.stores.set('another-app-cache',new Map());await w.run('install');await w.run('activate');
  const names=[...w.stores.keys()];assert.equal(names.includes('personal-ledger-shell-0000000000000000'),false);assert.equal(names.includes('another-app-cache'),true);assert.equal(names.filter(n=>n.startsWith('personal-ledger-shell-')).length,1);});
test('offline cache version matches the current app files (run `node prepare.mjs` after editing dist/)',()=>{assert.ok(code.includes(`const CACHE='personal-ledger-shell-${releaseVersion()}';`),'dist/ changed without refreshing the offline cache version; run node prepare.mjs')});
test('service worker caches exactly the released files and everything the pages load',()=>{
  const assets=JSON.parse(code.match(/const ASSETS=(\[[^\]]+\]);/)[1].replaceAll("'",'"'));
  assert.deepEqual([...assets].sort(),['./',...files].sort());
  const referenced=new Set();
  for(const page of ['index.html','apple-pay-guide.html'])for(const m of readFileSync(new URL(`./dist/${page}`,import.meta.url),'utf8').matchAll(/(?:href|src)="\.\/([^"#?]*)"/g))if(m[1])referenced.add(m[1]);
  for(const module of ['app.mjs','core.mjs','store.mjs'])for(const m of readFileSync(new URL(`./dist/${module}`,import.meta.url),'utf8').matchAll(/from\s*'\.\/([^']+)'/g))referenced.add(m[1]);
  const manifest=JSON.parse(readFileSync(new URL('./dist/manifest.webmanifest',import.meta.url),'utf8'));for(const icon of manifest.icons)referenced.add(icon.src.replace(/^\.\//,''));
  for(const file of referenced)assert.ok(files.includes(file),`${file} is loaded by the app but missing from the offline cache list`);
});
