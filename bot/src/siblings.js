/* 讀其他機器人的帳本（唯讀）。

   一條鏈一個機器人、各自獨立帳本之後，每個機器人的風控只看得到自己 ——
   「最多 3 個部位、在場上限 $60」是每個實例各自一份。
   那是你要的，但代價是沒有任何一個地方看得到總曝險。

   這支就是補那個洞：不改變任何風控判斷，只是把別人的帳本讀出來給你看。
   唯讀、不上鎖、壞掉的檔案直接跳過 —— 它的失敗不該影響任何一個機器人交易。 */

import fs from "node:fs";
import path from "node:path";

const NAME = /^state-(.+)\.json$/;

export function createSiblings({ dataDir, self }){
  return {
    /* 回傳每個實例的概況，包含自己。讀不到的實例會標出來，
       而不是當成 0 —— 「讀不到」跟「沒有部位」差很多。 */
    all(){
      let files = [];
      try {
        files = fs.readdirSync(dataDir).filter(f => NAME.test(f));
      } catch {
        return [];
      }

      return files.map(f => {
        const name = f.match(NAME)[1];
        const full = path.join(dataDir, f);
        try {
          const st = JSON.parse(fs.readFileSync(full, "utf8"));
          const positions = Array.isArray(st.positions) ? st.positions : [];
          const today = new Date().toISOString().slice(0, 10);
          return {
            name,
            isSelf: name === self,
            ok: true,
            openCount: positions.length,
            deployedUsd: positions.reduce((s, p) => s + (Number(p.costUsd) || 0), 0),
            realizedToday: Number(st.daily?.[today]) || 0,
            tradingEnabled: st.tradingEnabled !== false,
            autoArmed: (Number(st.auto?.armedUntil) || 0) > Date.now(),
            mtime: (() => { try { return fs.statSync(full).mtimeMs; } catch { return 0; } })(),
          };
        } catch {
          return { name, isSelf: name === self, ok: false };
        }
      }).sort((a, b) => a.name.localeCompare(b.name));
    },

    /* 加總。讀不到的實例會被算進 unknown，不會被當成 0 —— 
       把讀不到當成沒有部位，正好會在最需要警覺的時候讓總曝險看起來很安全。 */
    totals(){
      const rows = this.all();
      const ok = rows.filter(r => r.ok);
      return {
        instances: rows.length,
        unknown: rows.length - ok.length,
        openCount: ok.reduce((s, r) => s + r.openCount, 0),
        deployedUsd: ok.reduce((s, r) => s + r.deployedUsd, 0),
        realizedToday: ok.reduce((s, r) => s + r.realizedToday, 0),
        armed: ok.filter(r => r.autoArmed).length,
      };
    },
  };
}
