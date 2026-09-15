import { execFile } from "node:child_process";
import { log } from "./log.js";
import { resolveCli } from "./resolve-cli.js";

export class GmgnCliError extends Error {
  constructor(message, { code = "", hint = "", stderr = "", resetAt = null } = {}){
    super(message);
    this.name = "GmgnCliError";
    this.code = code;
    this.hint = hint;
    this.stderr = String(stderr).slice(0, 600);
    this.resetAt = resetAt;
  }
}

/* gmgn-cli 封裝。
   全部用 execFile + 參數陣列，絕不拼 shell 字串 ——
   代幣名稱/符號來自鏈上，是攻擊者可以任意填的欄位，拼進 shell 就等於把主機送人。 */
export function createCli({ bin = "gmgn-cli", execFileImpl = execFile, defaultTimeoutMs = 45000, resolved = null } = {}){
  /* Windows 上 gmgn-cli 是 .cmd 包裝，直接 spawn 會拿到 spawn EINVAL。
     resolveCli 會找出它背後的 JS 進入點，改用 node 去跑，參數仍然保持陣列。 */
  const target = resolved ?? resolveCli(bin);
  if(target.via === "cmd-shell"){
    log.warn("找不到 gmgn-cli 的 JS 進入點，退回 .cmd + shell", {
      note: "這條路徑上帶引號的 JSON 參數（--condition-orders）可能會壞"
    });
  }

  /* withStatus: true 時一律回 { exitOk, stdout, stderr, json }，把離開碼原封不動交出去。
     這是給「離開碼本身就是答案」的指令用的（例如 config --check：0 = 已設定，1 = 沒設定）。 */
  function run(args, { timeoutMs = defaultTimeoutMs, allowNonZero = false, withStatus = false } = {}){
    const argv = [...target.prefixArgs, ...args.map(String)];
    return new Promise((resolve, reject) => {
      execFileImpl(target.cmd, argv, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        /* 不繼承 shell，不帶 GMGN_ALLOW_AUTOMATED_TRADES 以外的東西 */
        env: process.env,
        shell: !!target.needsShell,
        /* stdin 關掉。gmgn-cli 的互動確認會從 tty 讀一個手打的 yes，
           繼承 stdin 的話那個等待會一路卡到逾時，外面看起來就是整支程式死掉。
           關掉之後它會立刻失敗並回報原因 —— 這正是我們要的：
           機器人本來就不該去回答那個提示（人工確認在 Telegram）。 */
        stdio: ["ignore", "pipe", "pipe"]
      }, (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");

        if(err && err.code === "ENOENT"){
          return reject(new GmgnCliError("找不到 gmgn-cli", { hint: "執行 npm install -g gmgn-cli" }));
        }
        if(err && err.killed){
          return reject(new GmgnCliError(`gmgn-cli ${args[0]} 逾時`, { hint: "網路或 GMGN 回應太慢" }));
        }

        const blob = out + "\n" + errOut;

        /* 限流：文件寫明冷卻期內每重試一次就多封 5 秒，所以這裡只回報、絕不自動重試 */
        if(/RATE_LIMIT_BANNED|RATE_LIMIT_EXCEEDED|ERROR_RATE_LIMIT_BLOCKED/.test(blob)){
          let resetAt = null;
          const m = blob.match(/"reset_at"\s*:\s*(\d+)/);
          if(m) resetAt = parseInt(m[1], 10);
          return reject(new GmgnCliError("GMGN 限流", {
            code: "RATE_LIMIT",
            resetAt,
            hint: resetAt
              ? `等到 ${new Date(resetAt * 1000).toLocaleString("zh-TW")} 再試，期間不要重送`
              : "等冷卻結束再試，期間不要重送",
            stderr: errOut
          }));
        }
        if(/\b401\b|\b403\b|UNAUTHORIZED|FORBIDDEN/.test(blob)){
          return reject(new GmgnCliError("GMGN 認證失敗（401/403）", {
            code: "AUTH",
            hint: "檢查 API Key（gmgn-cli config --check）。另外 gmgn-cli 只走 IPv4，主機開著 IPv6 會出現這個錯。",
            stderr: errOut
          }));
        }
        if(/GMGN_ALLOW_AUTOMATED_TRADES/.test(blob)){
          return reject(new GmgnCliError("CLI 拒絕自動下單", {
            code: "NEEDS_AUTOMATION_OPT_IN",
            hint: "這是 GMGN 的程式碼層防線。要讓機器人代送交易，必須由你本人在啟動機器人的 shell 裡設定 GMGN_ALLOW_AUTOMATED_TRADES=1。",
            stderr: errOut
          }));
        }

        if(err && !allowNonZero && !withStatus){
          return reject(new GmgnCliError(`gmgn-cli ${args.join(" ")} 失敗`, { stderr: errOut || out }));
        }

        /* --raw 會輸出 JSON，但有些版本會混入提示行，所以抓第一個 JSON 區塊 */
        const parsed = extractJson(out);

        if(withStatus){
          return resolve({ exitOk: !err, exitCode: err?.code ?? 0, stdout: out, stderr: errOut, json: parsed });
        }
        if(parsed === undefined){
          if(allowNonZero) return resolve({ ok: !err, stdout: out, stderr: errOut });
          return reject(new GmgnCliError("gmgn-cli 沒有回傳可解析的 JSON", { stderr: errOut || out }));
        }
        resolve(parsed);
      });
    });
  }

  function unwrap(res){
    /* CLI 有時回 {code:0,data:{...}}，有時直接回資料本身 */
    if(res && typeof res === "object" && "data" in res && res.code !== undefined) return res.data;
    return res;
  }

  return {
    run,

    /* 官方文件：exit 0 = 已設定可以往下走，exit 1 = 要先設 API Key。
       離開碼就是答案，所以一定要用 withStatus 把它取出來 ——
       之前用 allowNonZero 會把非零碼吞掉，變成沒設 API Key 也回報「已設定」。 */
    async configCheck(){
      try {
        const r = await run(["config", "--check"], { withStatus: true, timeoutMs: 15000 });
        if(r.exitOk) return { ok: true };
        return {
          ok: false,
          error: (r.stderr || r.stdout || "").trim().slice(0, 200) || `gmgn-cli config --check 離開碼 ${r.exitCode}`,
          hint: "執行 gmgn-cli config 取得申請方式，拿到後 gmgn-cli config --apply <KEY>"
        };
      } catch(e){
        return { ok: false, error: e.message, hint: e.hint };
      }
    },

    async trending({ chain, interval = "1h", limit = 100, minLiquidity, minSwaps, minHolderCount, filters = [], orderBy }){
      const args = ["market", "trending", "--chain", chain, "--interval", interval, "--limit", limit];
      if(minLiquidity != null) args.push("--min-liquidity", minLiquidity);
      if(minSwaps != null) args.push("--min-swaps", minSwaps);
      if(minHolderCount != null) args.push("--min-holder-count", minHolderCount);
      if(orderBy) args.push("--order-by", orderBy);
      for(const f of filters) args.push("--filter", f);
      args.push("--raw");
      const data = unwrap(await run(args));
      return Array.isArray(data) ? data : (data?.rank ?? data?.list ?? data?.tokens ?? []);
    },

    async hotSearches({ chain, interval = "1h", limit = 100, minLiquidity }){
      const args = ["market", "hot-searches", "--chain", chain, "--interval", interval, "--limit", limit];
      if(minLiquidity != null) args.push("--min-liquidity", minLiquidity);
      args.push("--raw");
      const data = unwrap(await run(args));
      if(Array.isArray(data)) return data;
      for(const key of ["rank", "list", "tokens", "coins"]){
        if(Array.isArray(data?.[key])) return data[key];
      }
      /* 可以一次查多條鏈，回傳會依鏈分組 */
      const groups = Object.values(data ?? {}).filter(Array.isArray);
      return groups.length ? groups.flat() : [];
    },

    async search({ query, chain }){
      const args = ["market", "search", "-q", query];
      if(chain) args.push("--chain", chain);           // 想搜全鏈就不要給 --chain
      args.push("--order-by", "weight", "--raw");
      const data = unwrap(await run(args));
      return data?.coins ?? [];                         // wallets 跟找幣無關，不能拿來判斷有沒有搜到
    },

    async tokenInfo({ chain, address }){
      return unwrap(await run(["token", "info", "--chain", chain, "--address", address, "--raw"]));
    },
    async tokenSecurity({ chain, address }){
      return unwrap(await run(["token", "security", "--chain", chain, "--address", address, "--raw"]));
    },
    async gasPrice({ chain }){
      return unwrap(await run(["gas-price", "--chain", chain, "--raw"]));
    },

    async quote({ chain, from, inputToken, outputToken, amountRaw, slippage }){
      const args = ["order", "quote", "--chain", chain, "--from", from,
                    "--input-token", inputToken, "--output-token", outputToken,
                    "--amount", String(amountRaw)];
      if(slippage != null) args.push("--slippage", slippage);
      args.push("--raw");
      return unwrap(await run(args));
    },

    /* 真正動錢的地方。conditionOrders 會把停損停利掛在 GMGN 伺服器端，
       機器人掛掉、你手機沒電，出場照樣會執行。 */
    async swap({ chain, from, inputToken, outputToken, amountRaw, percent, slippage,
                 antiMev = true, priorityFeeSol, tipFee, conditionOrders, sellRatioType, yes = false }){
      const args = ["swap", "--chain", chain, "--from", from,
                    "--input-token", inputToken, "--output-token", outputToken];
      if(percent != null) args.push("--percent", percent);
      else args.push("--amount", String(amountRaw));
      if(slippage != null) args.push("--slippage", slippage);
      if(antiMev) args.push("--anti-mev");
      if(priorityFeeSol != null) args.push("--priority-fee", priorityFeeSol);
      if(tipFee != null) args.push("--tip-fee", tipFee);
      if(conditionOrders?.length){
        args.push("--condition-orders", JSON.stringify(conditionOrders));
        if(sellRatioType) args.push("--sell-ratio-type", sellRatioType);
      }
      if(yes) args.push("--yes");
      args.push("--raw");
      log.trade("送出 swap", { chain, from, outputToken, amountRaw, percent, conditionOrders });
      return unwrap(await run(args, { timeoutMs: 90000 }));
    },

    /* 策略單（停損停利）狀態。type: open = 還掛著，history = 已結束。 */
    async strategyList({ chain, from, baseToken, type = "open", groupTag, limit = 50 }){
      const args = ["order", "strategy", "list", "--chain", chain, "--type", type];
      if(from) args.push("--from", from);
      if(baseToken) args.push("--base-token", baseToken);
      if(groupTag) args.push("--group-tag", groupTag);
      if(limit != null) args.push("--limit", limit);
      args.push("--raw");
      const data = unwrap(await run(args));
      if(Array.isArray(data)) return data;
      for(const key of ["orders", "list", "items", "data"]){
        if(Array.isArray(data?.[key])) return data[key];
      }
      return [];
    },

    /* 錢包裡還有沒有這顆幣。用來確認伺服器端的停損是不是真的賣掉了。 */
    async tokenBalance({ chain, wallet, token }){
      const data = unwrap(await run(["portfolio", "token-balance",
        "--chain", chain, "--wallet", wallet, "--token", token, "--raw"]));
      /* 欄位名稱各版本可能不同，能拿到哪個算哪個；全都拿不到就回 null（＝未知，不是 0） */
      for(const key of ["balance", "amount", "token_amount", "raw_amount", "ui_amount", "usd_value"]){
        const v = data?.[key];
        if(v != null && v !== "") return { amount: parseFloat(v) || 0, field: key, raw: data };
      }
      return { amount: null, field: null, raw: data };
    },

    async orderGet({ chain, orderId }){
      return unwrap(await run(["order", "get", "--chain", chain, "--order-id", orderId, "--raw"]));
    },

    /* 輪詢到 confirmed / failed / expired。文件明講：status 不是 confirmed 就不准回報成功。 */
    async waitForOrder({ chain, orderId, timeoutMs = 120000, intervalMs = 4000, sleep = ms => new Promise(r => setTimeout(r, ms)) }){
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while(Date.now() < deadline){
        try {
          last = await this.orderGet({ chain, orderId });
          const s = last?.status;
          if(s === "confirmed") return { done: true, ok: true, order: last };
          if(s === "failed" || s === "expired") return { done: true, ok: false, order: last };
        } catch(e){
          if(e.code === "RATE_LIMIT") throw e;          // 限流時停手，不要一直敲
          last = { error: e.message };
        }
        await sleep(intervalMs);
      }
      return { done: false, ok: false, order: last, timedOut: true };
    }
  };
}

function extractJson(text){
  const t = text.trim();
  if(!t) return undefined;
  try { return JSON.parse(t); } catch {}
  const start = t.search(/[[{]/);
  if(start < 0) return undefined;
  for(let end = t.length; end > start; end--){
    const slice = t.slice(start, end);
    if(!/[\]}]$/.test(slice.trim())) continue;
    try { return JSON.parse(slice); } catch {}
  }
  return undefined;
}
