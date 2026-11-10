// 隨身帳本離線畫面。只快取程式檔案；帳目保存在 IndexedDB，不經過此檔案。
// CACHE 版本由 `node prepare.mjs` 依程式資源內容自動更新。
const CACHE='personal-ledger-shell-f6d12d0176f21741';
const PREFIX='personal-ledger-shell-';
const SHELL_MARKER='<meta name="ledger-app-shell" content="1">';
const BASE=new URL('./',self.location);
const ASSETS=['./','index.html','style.css','app.mjs','core.mjs','store.mjs','manifest.webmanifest','icon.svg','icon-180.png','apple-pay-guide.html'];
const SHELL=new Set([BASE.href,new URL('index.html',BASE).href]);

// 私人網站未登入時會回傳登入頁；不能把它當成帳本畫面存起來。
// 經過轉址的回應不能直接回給頁面導覽，因此另存一份不帶轉址紀錄的副本。
async function prepared(request,response){
  if(!response||!response.ok)throw Error(`Offline asset unavailable: ${request.url}`);
  if(SHELL.has(request.url)&&!(await response.clone().text()).includes(SHELL_MARKER))throw Error('Login page cannot be cached as ledger shell');
  return response.redirected?new Response(await response.blob(),{status:response.status,statusText:response.statusText,headers:response.headers}):response;
}

self.addEventListener('install',event=>{
  // 不強制立即接手：新版本等舊畫面全部關閉後才啟用，避免執行中途換程式。
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    const entries=await Promise.all(ASSETS.map(async path=>{const request=new Request(new URL(path,BASE).href,{cache:'reload'});return [request,await prepared(request,await fetch(request))]}));
    // 全部下載並驗證成功才寫入，避免留下半套離線畫面。
    await Promise.all(entries.map(([request,response])=>cache.put(request,response)));
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
  event.respondWith((async()=>{
    // 畫面與程式一律取自同一個版本的快取：離線、訊號不穩或登入逾期時都能立即開啟，
    // 也不會出現新畫面搭配舊程式。更新由新版 sw.js 安裝完成後一次切換。
    const cache=await caches.open(CACHE),cached=await cache.match(new Request(url.href));
    if(cached)return cached;
    try{return await fetch(request)}catch(error){
      // 離線時開啟未快取的站內網址，回到帳本首頁而不是瀏覽器錯誤頁。
      const shell=request.mode==='navigate'?await cache.match(new Request(BASE.href)):undefined;
      if(shell)return shell;
      throw error;
    }
  })());
});
