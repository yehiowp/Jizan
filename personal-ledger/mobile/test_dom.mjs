import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from 'jsdom';import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';import {File} from 'node:buffer';
const dom=new JSDOM(readFileSync(new URL('./dist/index.html',import.meta.url),'utf8'),{url:'https://ledger.test/',pretendToBeVisual:true});
const nativeTimeout=globalThis.setTimeout,longTimers=new Set();globalThis.setTimeout=(fn,ms,...args)=>{const id=nativeTimeout(fn,ms,...args);if(ms>=1000)longTimers.add(id);return id};
const win=dom.window;globalThis.window=win;globalThis.document=win.document;globalThis.indexedDB=new IDBFactory();globalThis.File=File;globalThis.isSecureContext=false;Object.defineProperty(globalThis,'navigator',{value:win.navigator,configurable:true});Object.defineProperty(win.navigator,'onLine',{value:true,configurable:true});
win.scrollTo=()=>{};win.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};win.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')};
const $=id=>document.getElementById(id),wait=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('UI operation did not settle')};
await import('./dist/app.mjs');const {read}=await import('./dist/store.mjs');
async function upload(value,button){$(button).click();const text=JSON.stringify(value);Object.defineProperty($('fileInput'),'files',{value:[{name:'synthetic.json',size:Buffer.byteLength(text),text:async()=>text}],configurable:true});$('fileInput').dispatchEvent(new win.Event('change'));await wait(()=>$('importDialog').open||!$('toast').hidden)}
await test('first load is empty and does not seed financial examples',async()=>{assert.equal((await read()).records.length,0);assert.match($('recentList').textContent,/第一筆/);});
await test('manual form saves to IndexedDB and immediately displays record',async()=>{document.querySelector('[data-add="expense"]').click();$('amount').value='125.50';$('merchant').value='合成午餐';$('entryForm').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>!$('entryDialog').open);const s=await read();assert.equal(s.records.length,1);assert.equal(s.records[0].amount,'125.50');assert.match($('recentList').textContent,/合成午餐/);});
await test('failed validation preserves all previous records',async()=>{document.querySelector('[data-add="expense"]').click();$('amount').value='NaN';$('merchant').value='invalid';$('entryForm').dispatchEvent(new win.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>$('formError').textContent.length>0);assert.equal((await read()).records.length,1);$('closeEntry').click();});
await test('Wallet file preview is read only, repeated confirmation deduplicates',async()=>{const r={source:'apple_pay',external_id:'wallet-synthetic',amount:'50.00',currency:'TWD',merchant:'合成咖啡',account:'日常消費',kind:'expense',occurred_at:new Date().toISOString(),force_review:true};await upload(r,'importWalletBtn');await wait(()=>$('importDialog').open);assert.equal((await read()).records.length,1);$('confirmImport').click();await wait(()=>!$('importDialog').open);assert.equal((await read()).records.length,2);await upload(r,'importWalletBtn');await wait(()=>$('importDialog').open);$('confirmImport').click();await wait(()=>!$('importDialog').open);assert.equal((await read()).records.length,2);});
await test('Windows snapshot reconciles local display without removing source data',async()=>{const current=await read(),r=current.records[0],snapshot={format:'personal-ledger-snapshot',version:1,export_id:'snapshot-test',created_at:new Date().toISOString(),entries:[{...r,id:'windows-entry',status:'verified'}],reviews:[],portfolio:[],accepted_sources:[{source:r.source,external_id:r.external_id,entry_id:'windows-entry'}]};await upload(snapshot,'importSnapshotBtn');await wait(()=>$('importDialog').open);$('confirmImport').click();await wait(()=>!$('importDialog').open);assert.equal((await read()).records.length,2);assert.match($('pendingTitle').textContent,/1 筆/);assert.equal($('ledgerList').querySelectorAll('.record').length,2);});
await test('poisoned snapshot is rejected before storage, existing UI remains usable',async()=>{const current=await read(),bad={...current.snapshot,created_at:new Date(Date.now()+1000).toISOString(),portfolio:[null]};$('toast').hidden=true;await upload(bad,'importSnapshotBtn');await wait(()=>!$('toast').hidden);assert.match($('toast').textContent,/未匯入/);assert.equal((await read()).snapshot.portfolio.length,0);assert.equal($('fatal').hidden,true);});
await test('export contains only sources not yet received by Windows',async()=>{let exported;navigator.canShare=()=>true;navigator.share=async value=>{exported=value.files[0]};$('exportBtn').click();await wait(()=>!!exported);const payload=JSON.parse(await exported.text());assert.equal(payload.format,'personal-ledger-transfer');assert.equal(payload.records.length,1);assert.equal(payload.records[0].external_id,'wallet-synthetic');assert.equal((await read()).records.length,2);});
await test('long ledgers render one page at a time while search and filters cover every row',async()=>{
  const current=await read(),entries=Array.from({length:250},(_,i)=>({id:`bulk-${i}`,source:'manual',external_id:`bulk-${i}`,amount:'10.00',currency:'TWD',merchant:i===240?'稀有書店':`商店${i}`,account:'日常消費',kind:i%2?'income':'expense',category:'未分類',status:'verified',occurred_at:new Date(Date.UTC(2026,0,1)-i*3600e3).toISOString()}));
  await upload({format:'personal-ledger-snapshot',version:1,export_id:'bulk',created_at:new Date(Date.now()+5000).toISOString(),entries,reviews:[],portfolio:[],accepted_sources:current.snapshot.accepted_sources},'importSnapshotBtn');
  await wait(()=>$('importDialog').open);$('confirmImport').click();await wait(()=>!$('importDialog').open);
  const list=$('ledgerList'),count=()=>list.querySelectorAll('.record').length,type=text=>{$('search').value=text;$('search').dispatchEvent(new win.Event('input',{bubbles:true}))};
  assert.equal(count(),100);assert.match($('moreRecords').textContent,/100 \/ 251/);assert.equal($('recentList').querySelectorAll('.record').length,5);
  $('moreRecords').click();assert.equal(count(),200);$('moreRecords').click();assert.equal(count(),251);assert.equal($('moreRecords'),null);
  type('稀有');assert.equal(count(),1);assert.match(list.textContent,/稀有書店/);
  type('找不到的商家');assert.equal(count(),0);assert.match(list.textContent,/試試其他搜尋條件/);
  type('');assert.equal(count(),100);
  document.querySelector('[data-filter="income"]').click();assert.equal(count(),100);assert.match($('moreRecords').textContent,/100 \/ 125/);
  document.querySelector('[data-filter="all"]').click();assert.match($('moreRecords').textContent,/100 \/ 251/);
});
await test('a snapshot field named like an internal cache cannot break or hide rows',async()=>{
  const current=await read(),entry={id:'odd',source:'manual',external_id:'odd',amount:'1.00',currency:'TWD',merchant:'欄位測試',account:'日常消費',kind:'expense',category:'未分類',status:'verified',occurred_at:new Date().toISOString(),search:42,phone:true};
  await upload({...current.snapshot,export_id:'odd',created_at:new Date(Date.now()+9000).toISOString(),entries:[entry]},'importSnapshotBtn');
  await wait(()=>$('importDialog').open);$('confirmImport').click();await wait(()=>!$('importDialog').open);
  $('search').value='欄位';$('search').dispatchEvent(new win.Event('input',{bubbles:true}));
  assert.equal($('ledgerList').querySelectorAll('.record').length,1);assert.equal($('fatal').hidden,true);assert.match($('ledgerList').textContent,/已核對/);
  $('search').value='';$('search').dispatchEvent(new win.Event('input',{bubbles:true}));
});
await test('reading or reopening the app does not rewrite the stored ledger',async()=>{
  const put=IDBObjectStore.prototype.put;let writes=0;IDBObjectStore.prototype.put=function(...args){writes++;return put.apply(this,args)};
  try{const before=await read();win.dispatchEvent(new win.Event('pageshow'));await new Promise(r=>setTimeout(r,30));const after=await read();assert.equal(writes,0);assert.equal(after.device_id,before.device_id);assert.deepEqual(after.records,before.records);}
  finally{IDBObjectStore.prototype.put=put}
});
await test('opened in an iPhone browser tab, the app explains installing it and moving existing records',async()=>{
  const reopen=()=>{win.dispatchEvent(new win.Event('pageshow'));return new Promise(r=>setTimeout(r,30))},standalone=value=>Object.defineProperty(win.navigator,'standalone',{value,configurable:true});
  assert.equal($('installBanner').hidden,true);  // not an iPhone browser (no navigator.standalone)
  try{
    standalone(false);await reopen();
    assert.equal($('installBanner').hidden,false);
    const count=(await read()).records.length;assert.ok(count>0);
    assert.match($('installText').textContent,new RegExp(`這裡的 ${count} 筆紀錄`));assert.match($('installText').textContent,/完整備份/);
    $('installHow').click();assert.equal($('helpDialog').open,true);assert.match($('helpDialog').textContent,/加入主畫面/);$('helpDone').click();
    $('installClose').click();assert.equal($('installBanner').hidden,true);
    await reopen();assert.equal($('installBanner').hidden,true);  // stays dismissed on this device
    win.localStorage.removeItem('installHintDismissed');standalone(true);await reopen();
    assert.equal($('installBanner').hidden,true);  // opened from the home screen icon
  }finally{delete win.navigator.standalone;win.localStorage.removeItem('installHintDismissed')}
});
for(const id of longTimers)clearTimeout(id);globalThis.setTimeout=nativeTimeout;dom.window.close();
