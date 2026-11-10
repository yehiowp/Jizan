import {createHash} from 'node:crypto';import {readFileSync,realpathSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
// 手機程式檔案；sw.js 的 ASSETS 必須列出同一批檔案（另加首頁 './'），測試會檢查兩邊一致。
export const files=['index.html','style.css','app.mjs','core.mjs','store.mjs','manifest.webmanifest','icon.svg','icon-180.png','apple-pay-guide.html'];
// 離線快取版本＝全部程式資源內容的雜湊；內容一變，手機就會下載新版本。
export function releaseVersion(){const hash=createHash('sha256');for(const file of files){hash.update(file);hash.update(readFileSync(new URL(`./dist/${file}`,import.meta.url)));}return hash.digest('hex').slice(0,16)}
// 直接執行（node prepare.mjs）才改寫 sw.js；被測試匯入時只提供上面的函式。Windows 路徑大小寫可能不同，故不分大小寫比對。
const invoked=process.argv[1]?realpathSync(process.argv[1]).toLowerCase():'';
if(invoked===realpathSync(fileURLToPath(import.meta.url)).toLowerCase()){const version=releaseVersion(),path=new URL('./dist/sw.js',import.meta.url),source=readFileSync(path,'utf8'),next=source.replace(/const CACHE='personal-ledger-shell-[^']+';/,`const CACHE='personal-ledger-shell-${version}';`);if(!next.includes(`personal-ledger-shell-${version}`))throw Error('sw.js 找不到 CACHE 版本宣告，未更新');if(next!==source)writeFileSync(path,next);console.log(`Offline shell release ${version}`);}
