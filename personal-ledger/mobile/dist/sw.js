// 隨身帳本離線畫面。只快取程式檔案；帳目保存在 IndexedDB，不經過此檔案。
// CACHE 版本由 `node prepare.mjs` 依程式資源內容自動更新，請勿手動修改。
const CACHE='personal-ledger-shell-3536c951adaa03b8';
const PREFIX='personal-ledger-shell-';
const SHELL_MARKER='<meta name="ledger-app-shell" content="1">';
const BASE=new URL('./',self.location);
const ASSETS=['./','index.html','style.css','app.mjs','core.mjs','store.mjs','manifest.webmanifest','icon.svg','icon-180.png','apple-pay-guide.html'];
const SHELL=new Set([BASE.href,new URL('index.html',BASE).href]);
const assetUrl=path=>new URL(path,BASE).href;
const isShell=url=>SHELL.has(url);

// 私人網站未登入時會回傳登入頁；不能把它當成帳本畫面存起來。
async function verified(request,response){
  if(!response||!response.ok)throw Error(`Offline asset unavailable: ${request.url}`);
  if(isShell(request.url)&&!(await response.clone().text()).includes(SHELL_MARKER))throw Error('Login page cannot be cached as ledger shell');
  return response;
}

self.addEventListener('install',event=>{
  // 不強制立即接手：新版本等舊畫面全部關閉後才接手，避免執行中途換程式。
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const responses=await Promise.all(ASSETS.map(async path=>{const request=new Request(assetUrl(path),{cache:'reload'});return [request,await verified(request,await fetch(request))]}));
    // 全部下載並驗證成功才寫入，避免留下半套離線畫面。
    await Promise.all(responses.map(([request,response])=>cache.put(request,response)));
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE)await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==BASE.origin||!url.href.startsWith(BASE.href))return;
  url.search='';url.hash='';
  const key=new Request(url.href);
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    // 畫面：優先網路取得最新登入狀態，離線時使用快取。程式資源：版本化快取優先。
    if(request.mode==='navigate'||isShell(url.href)){
      try{
        const response=await fetch(request);
        return response;
      }catch(error){
        const cached=await cache.match(key)??await cache.match(new Request(BASE.href));
        if(cached)return cached;
        throw error;
      }
    }
    return await cache.match(key)??fetch(request);
  })());
});
