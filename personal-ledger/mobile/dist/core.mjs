export const DIGITS={TWD:2,USD:2,HKD:2,EUR:2,GBP:2,CNY:2,SGD:2,AUD:2,CAD:2,CHF:2,JPY:0,KRW:0,BHD:3,KWD:3,USDT:6,USDC:6};
export const MAX_RECORDS=5000,MAX_FILE=20*1024*1024;
export const key=r=>`${r.source}:${r.external_id}`;
const text=(v,label,max=200)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f]/.test(v))throw Error(`${label}未填或格式不正確`);return v.trim()};
export function minor(value,currency){
  const digits=DIGITS[currency];if(digits===undefined)throw Error('不支援的幣別');
  if(typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value))throw Error('金額請用數字字串，小數點使用句點');
  const [whole,fraction='']=value.split('.');if(fraction.length>digits)throw Error(`${currency} 最多 ${digits} 位小數`);
  const n=BigInt(whole)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0')||'0');
  if(n>9000000000000000000n||n>1000000000000000n*10n**BigInt(digits))throw Error('金額超過帳本範圍');return n;
}
export function decimal(value,currency){const d=DIGITS[currency];if(d===undefined)throw Error('不支援的幣別');let n=BigInt(value),sign=n<0n?'-':'';if(n<0n)n=-n;const s=n.toString().padStart(d+1,'0');return sign+(d?s.slice(0,-d)+'.'+s.slice(-d):s)}
export function money(value,currency){const s=decimal(value,currency),[w,f]=s.split('.');return `${currency} ${w.replace(/\B(?=(\d{3})+(?!\d))/g,',')}${f===undefined?'':'.'+f}`}
export function iso(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('時間需要完整日期、時間與時區');const parts=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);const [y,m,d,h,mi,s]=parts.slice(1).map(Number);const test=new Date(Date.UTC(y,m-1,d));if(m<1||m>12||d<1||test.getUTCDate()!==d||h>23||mi>59||s>59)throw Error('日期或時間無效');return value}
export function dateOnly(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('日期需要 YYYY-MM-DD 格式');
  const [year,month,day]=value.split('-').map(Number),date=new Date(0);date.setUTCFullYear(year,month-1,day);
  if(year<1||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw Error('日期無效');return value;
}
function dateMetadata(raw){
  const result={},precision=raw.time_precision??raw.date_precision;
  if(precision!=null){if(!['second','minute','day'].includes(precision))throw Error('時間精度無效');result.time_precision=precision;}
  if(raw.time_precision!=null&&raw.date_precision!=null&&raw.time_precision!==raw.date_precision)throw Error('兩個時間精度欄位不一致');
  for(const field of ['transaction_date','posting_date'])if(raw[field]!=null)result[field]=dateOnly(raw[field]);
  if(raw.statement_kind!=null)result.statement_kind=text(raw.statement_kind,'帳單交易類型',100);
  return result;
}
export function formatRecordDate(record){
  if((record.time_precision??record.date_precision)==='day'){
    const value=record.transaction_date??record.occurred_at?.slice(0,10);
    return value?`${dateOnly(value)} · 時間未提供`:'日期未提供 · 時間未提供';
  }
  return record.occurred_at?new Date(record.occurred_at).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'日期未提供';
}
function recordMonth(record){
  if((record.time_precision??record.date_precision)==='day')return dateOnly(record.transaction_date??record.occurred_at.slice(0,10)).slice(0,7);
  const d=new Date(record.occurred_at);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
export function normalize(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('交易必須是物件');
  if(!['manual','apple_pay'].includes(raw.source))throw Error('手機只接收手動或 Apple Pay 紀錄');
  const currency=text(raw.currency,'幣別',6).toUpperCase(),n=minor(raw.amount,currency);if(n<=0n)throw Error('金額需大於零');
  if(!['expense','income','transfer','investment'].includes(raw.kind??'expense'))throw Error('收支類型無效');
  const precision=raw.time_precision??raw.date_precision??'minute';if(!['second','minute','day'].includes(precision))throw Error('時間精度無效');
  if(raw.force_review!==undefined&&typeof raw.force_review!=='boolean')throw Error('force_review 須為布林值');
  const record={source:raw.source,external_id:text(raw.external_id,'交易識別碼',500),amount:decimal(n,currency),currency,
    merchant:text(raw.merchant,'商家／摘要'),account:text(raw.account,'帳戶'),kind:raw.kind??'expense',occurred_at:iso(raw.occurred_at),
    time_precision:precision,category:raw.category?text(raw.category,'分類'):'未分類',...dateMetadata(raw)};
  if(raw.force_review)record.force_review=true;
  if(raw.source_timezone)record.source_timezone=text(raw.source_timezone,'來源時區',100);
  if(raw.provenance!==undefined){if(!raw.provenance||typeof raw.provenance!=='object'||Array.isArray(raw.provenance)||new TextEncoder().encode(JSON.stringify(raw.provenance)).length>2000)throw Error('來源備註格式或長度無效');record.provenance=raw.provenance;}
  return record;
}
const identity=r=>JSON.stringify([r.source,r.external_id,r.amount,r.currency,r.merchant,r.account,r.kind,r.occurred_at,r.time_precision,r.category]);
export function mergeRecords(existing,incoming){const result=existing.map(normalize),map=new Map(result.map(r=>[key(r),r]));let added=0,duplicates=0;for(const raw of incoming){const r=normalize(raw),old=map.get(key(r));if(old){if(identity(old)!==identity(r))throw Error('相同交易識別碼有不同內容，未覆蓋手機原紀錄');duplicates++;}else{map.set(key(r),r);result.push(r);added++;}}if(result.length>MAX_RECORDS)throw Error('手機紀錄超過 5,000 筆，請先備份並整理');return {records:result,added,duplicates};}
export function previewRecords(value){
  let rows;
  if(value?.format==='personal-ledger-transfer'){if(value.version!==1||!Array.isArray(value.records))throw Error('不支援的紀錄檔版本');rows=value.records;}
  else rows=Array.isArray(value)?value:[value];
  if(rows.length>MAX_RECORDS)throw Error('單次最多 5,000 筆');const records=[],errors=[];
  rows.forEach((r,i)=>{try{records.push(normalize(r))}catch(e){errors.push(`第 ${i+1} 筆：${e.message}`)}});return {records,errors};
}
function snapshotEntry(raw){if(!raw||typeof raw.id!=='string'||typeof raw.currency!=='string')throw Error('總帳資料格式無效');const currency=raw.currency.toUpperCase();let amount=raw.amount;if(amount===undefined){if(!Number.isSafeInteger(raw.amount_minor))throw Error('金額精度不足，請用新版 Windows 匯出');amount=decimal(BigInt(raw.amount_minor),currency);}minor(amount,currency);iso(raw.occurred_at);return {...raw,currency,amount,...dateMetadata(raw)};}
export function validateSnapshot(value){
  if(value?.format!=='personal-ledger-snapshot'||value.version!==1)throw Error('不是 Windows 手機總帳檔');
  iso(value.created_at);if(!Array.isArray(value.entries)||!Array.isArray(value.reviews)||!Array.isArray(value.portfolio)||!Array.isArray(value.accepted_sources))throw Error('總帳缺少必要欄位');
  if(value.entries.length>50000||value.reviews.length>50000||value.accepted_sources.length>100000)throw Error('總帳資料過多，請先在 Windows 整理');
  const entries=value.entries.map(snapshotEntry),reviews=value.reviews.map(r=>{if(!r||typeof r.id!=='string'||typeof r.reason!=='string')throw Error('核對資料無效');let source=r.source;if(source!=null){if(typeof source!=='object'||Array.isArray(source))throw Error('核對來源格式無效');if(source.amount!==undefined)minor(source.amount,source.currency);if(source.occurred_at!=null)iso(source.occurred_at);source={...source,...dateMetadata(source)};}return {...r,source,entry:r.entry?snapshotEntry(r.entry):null}});
  const accepted_sources=value.accepted_sources.map(r=>{if(!r||typeof r.source!=='string'||typeof r.external_id!=='string')throw Error('核對來源格式無效');return {source:r.source,external_id:r.external_id,entry_id:r.entry_id??null}});
  if(value.portfolio.length>10000)throw Error('持倉資料過多，請先在 Windows 整理');
  for(const p of value.portfolio){
    if(!p||typeof p!=='object'||Array.isArray(p))throw Error('持倉資料格式無效');
    for(const field of ['symbol','market','account','currency'])text(p[field],`持倉 ${field}`,200);
    if(DIGITS[p.currency]===undefined)throw Error('持倉幣別無效');
    for(const field of ['quantity_decimal','cost_decimal'])if(typeof p[field]!=='string'||p[field].length>200||!/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(p[field]))throw Error('持倉數值格式無效');
    for(const field of ['price_decimal','value_decimal','unrealized_decimal'])if(p[field]!=null&&(typeof p[field]!=='string'||p[field].length>200||!/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(p[field])))throw Error('持倉報價格式無效');
    if(p.quote_as_of!=null)iso(p.quote_as_of);
  }
  return {...value,entries,reviews,accepted_sources};
}
export function pendingRecords(state){const known=new Set((state.snapshot?.accepted_sources??[]).map(key));return state.records.filter(r=>!known.has(key(r)));}
export function displayRows(state){return [...(state.snapshot?.entries??[]).map(r=>({...r,phone:false})),...pendingRecords(state).map(r=>({...r,id:key(r),phone:true,status:'local'}))].sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at));}
export function totals(rows,currency,month){let expense=0n,income=0n;for(const r of rows){if(r.currency!==currency)continue;if(month&&recordMonth(r)!==month)continue;const n=minor(r.amount,currency);if(r.kind==='expense')expense+=n;else if(r.kind==='income')income+=n;}return {expense,income,net:income-expense};}
export function makeTransfer(state,id,at){return {format:'personal-ledger-transfer',version:1,device_id:state.device_id,export_id:id,created_at:iso(at),records:pendingRecords(state)};}
