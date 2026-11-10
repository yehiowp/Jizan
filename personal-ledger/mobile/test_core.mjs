import test from 'node:test';import assert from 'node:assert/strict';
import {minor,money,normalize,mergeRecords,previewRecords,validateSnapshot,pendingRecords,displayRows,totals,makeTransfer,dateOnly,formatRecordDate,formatTime} from './dist/core.mjs';
const row=(more={})=>({source:'manual',external_id:'test-1',amount:'500.00',currency:'TWD',merchant:'測試商店',account:'日常消費',kind:'expense',occurred_at:'2026-11-10T12:30:00+08:00',...more});
test('integer monetary arithmetic beyond JS safe integer',()=>{assert.equal(minor('90071992547409.91','TWD'),9007199254740991n);assert.equal(money(9007199254740992n,'TWD'),'TWD 90,071,992,547,409.92');assert.throws(()=>minor('0.001','TWD'));assert.throws(()=>minor(1,'TWD'));assert.throws(()=>minor('-1','USD'));});

test('mobile amounts fit the Windows decimal range as well as minor units',()=>{assert.equal(minor('1000000000000000.00','TWD'),100000000000000000n);assert.throws(()=>normalize(row({amount:'1000000000000000.01'})));assert.throws(()=>normalize(row({amount:'1000000000000001',currency:'JPY'})));});
test('invalid date and monetary precision rejected',()=>{for(const changes of [{occurred_at:'2026-02-30T12:00:00+08:00'},{occurred_at:'2026-11-10T12:30:00'},{amount:'NaN'},{amount:'0'},{force_review:'true'}])assert.throws(()=>normalize(row(changes)));});
test('Wallet JSON preserves actual date and review flag',()=>{const r=normalize(row({source:'apple_pay',occurred_at:'2026-11-10T04:30:00.123456Z',force_review:true,provenance:{capture:'shortcut'}}));assert.equal(r.occurred_at,'2026-11-10T04:30:00.123456Z');assert.equal(r.force_review,true);});
test('single object and arrays can be imported',()=>{assert.equal(previewRecords(row()).records.length,1);assert.equal(previewRecords([row(),row({amount:'invalid'})]).errors.length,1);assert.equal(previewRecords({format:'personal-ledger-transfer',version:1,records:[row()]}).records.length,1);});
test('stable identity deduplicates and rejects changed contents atomically',()=>{const first=mergeRecords([],[row()]);const second=mergeRecords(first.records,[row({amount:'500'})]);assert.equal(second.duplicates,1);assert.throws(()=>mergeRecords(first.records,[row({amount:'515'})]));assert.equal(first.records.length,1);});
test('bank snapshot suppresses accepted local records without losing source',()=>{const state={records:[normalize(row())],snapshot:{entries:[{id:'server-1',...row()}],accepted_sources:[{source:'manual',external_id:'test-1',entry_id:'server-1'}]}};assert.equal(pendingRecords(state).length,0);assert.equal(displayRows(state).length,1);assert.equal(state.records.length,1);});
test('received source pending review is not double-counted',()=>{const state={records:[normalize(row())],snapshot:{entries:[],reviews:[{id:'review-1'}],accepted_sources:[{source:'manual',external_id:'test-1',entry_id:null}]}};assert.equal(displayRows(state).length,0);assert.equal(pendingRecords(state).length,0);});
test('summary separates currencies and excludes transfers',()=>{const rows=[row(),row({kind:'income',amount:'1000'}),row({kind:'transfer',amount:'10000'}),row({currency:'USD',amount:'100'})];const t=totals(rows,'TWD');assert.equal(t.expense,50000n);assert.equal(t.income,100000n);assert.equal(t.net,50000n);});
test('snapshot requires correct format and safe fallback minor',()=>{const snapshot={format:'personal-ledger-snapshot',version:1,created_at:'2026-11-10T12:30:00Z',entries:[{id:'e',...row()}],reviews:[],portfolio:[],accepted_sources:[]};assert.equal(validateSnapshot(snapshot).entries[0].amount,'500.00');assert.throws(()=>validateSnapshot({...snapshot,entries:[{...snapshot.entries[0],amount:undefined,amount_minor:9007199254740992}]}));});

test('malformed portfolio cannot be persisted as a snapshot that breaks startup',()=>{const snapshot={format:'personal-ledger-snapshot',version:1,created_at:'2026-11-10T12:30:00Z',entries:[],reviews:[],portfolio:[],accepted_sources:[]};for(const item of [null,0,'BTC',[]])assert.throws(()=>validateSnapshot({...snapshot,portfolio:[item]}),`invalid portfolio row ${JSON.stringify(item)} must be rejected before IndexedDB mutation`);});
test('transfer exports only unacknowledged immutable records',()=>{const state={device_id:'device',records:[normalize(row()),normalize(row({external_id:'test-2'}))],snapshot:{accepted_sources:[{source:'manual',external_id:'test-1'}]}};const t=makeTransfer(state,'export','2026-11-10T12:30:00Z');assert.equal(t.records.length,1);assert.equal(t.records[0].external_id,'test-2');});

test('date-only records keep their calendar date and month without a fabricated clock',()=>{
  const record=row({time_precision:'day',transaction_date:'2026-11-01',posting_date:'2026-11-06',occurred_at:'2026-10-31T00:00:00Z'});
  assert.equal(formatRecordDate(record),'2026-11-01 · 時間未提供');
  assert.equal(totals([record],'TWD','2026-11').expense,50000n);
  assert.equal(totals([record],'TWD','2026-10').expense,0n);
  assert.equal(formatRecordDate(row({time_precision:'day',occurred_at:'2026-11-01T00:00:00+08:00'})),'2026-11-01 · 時間未提供');
  assert.equal(formatRecordDate(row()).includes('時間未提供'),false);
});

test('Wallet metadata survives import without changing stable source identity',()=>{
  const r=normalize(row({source:'apple_pay',time_precision:'day',transaction_date:'2026-11-10',posting_date:'2026-11-11',statement_kind:'purchase'}));
  assert.equal(r.external_id,'test-1');assert.equal(r.transaction_date,'2026-11-10');assert.equal(r.posting_date,'2026-11-11');assert.equal(r.statement_kind,'purchase');
  assert.equal(mergeRecords([r],[r]).duplicates,1);
});

test('date metadata in entries and nested review sources is validated before persistence',()=>{
  const snapshot={format:'personal-ledger-snapshot',version:1,created_at:'2026-11-10T12:30:00Z',entries:[],reviews:[],portfolio:[],accepted_sources:[]};
  for(const invalid of ['2026-02-29','2026-11-31','2026-00-01','2026-13-01','0000-01-01','2026-1-01',0,{}]){
    assert.throws(()=>dateOnly(invalid));
    assert.throws(()=>validateSnapshot({...snapshot,entries:[{id:'e',...row(),time_precision:'day',transaction_date:invalid}]}));
    assert.throws(()=>validateSnapshot({...snapshot,reviews:[{id:'r',reason:'time_uncertain',source:{posting_date:invalid}}]}));
  }
  assert.equal(dateOnly('2024-02-29'),'2024-02-29');
  const current=validateSnapshot({...snapshot,entries:[{id:'e',...row(),time_precision:'day',transaction_date:'2026-11-10',posting_date:'2026-11-11',statement_kind:'fee'}],reviews:[{id:'r',reason:'missing_entry',source:{time_precision:'day',transaction_date:'2026-11-09',posting_date:'2026-11-11'}}]});
  assert.equal(formatRecordDate(current.entries[0]),'2026-11-10 · 時間未提供');
  assert.equal(current.reviews[0].source.posting_date,'2026-11-11');
  assert.doesNotThrow(()=>validateSnapshot({...snapshot,entries:[{id:'old',...row(),transaction_date:null,posting_date:null,statement_kind:null}]}));
  assert.throws(()=>validateSnapshot({...snapshot,entries:[{id:'e',...row(),time_precision:'year'}]}));
});

test('shared time formatter matches per-call locale formatting',()=>{
  const options={month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false};
  for(const value of ['2026-11-10T12:30:00+08:00','2026-01-01T00:00:00Z','2026-12-31T23:59:59.999999Z','2024-02-29T16:05:00-05:00','1999-07-04T09:09:09+09:00']){
    assert.equal(formatTime(value),new Date(value).toLocaleString('zh-TW',options));
    assert.equal(formatRecordDate(row({occurred_at:value})),new Date(value).toLocaleString('zh-TW',options));
  }
  assert.equal(formatTime('not a date'),new Date('not a date').toLocaleString('zh-TW',options));
});

test('display order is newest first and stable for equal times',()=>{
  const entries=Array.from({length:400},(_,i)=>({id:`e${i}`,...row({external_id:`e${i}`,occurred_at:new Date(Date.UTC(2026,0,1+(i*7919)%60,(i*31)%24)).toISOString()})}));
  const records=[normalize(row({external_id:'phone-a',occurred_at:entries[10].occurred_at})),normalize(row({external_id:'phone-b',occurred_at:'2027-01-01T00:00:00Z'}))];
  const state={records,snapshot:{entries,accepted_sources:[]}};
  const expected=[...entries.map(r=>r.id),...records.map(r=>`manual:${r.external_id}`)].map((id,index)=>({id,index,at:Date.parse(index<entries.length?entries[index].occurred_at:records[index-entries.length].occurred_at)})).sort((a,b)=>b.at-a.at||a.index-b.index).map(r=>r.id);
  const shown=displayRows(state);
  assert.deepEqual(shown.map(r=>r.id),expected);
  assert.equal(shown[0].id,'manual:phone-b');assert.equal(shown[0].phone,true);assert.equal(shown.filter(r=>r.phone).length,2);
});
