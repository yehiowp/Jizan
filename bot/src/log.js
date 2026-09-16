/* 會把私鑰之類的東西遮掉的 logger。任何情況下都不要讓金鑰進到 log 或 Telegram。 */
const SECRET_KEYS = /(private|secret|token|key|mnemonic|seed|signedTx)/i;

export function redact(value, depth = 0){
  if(depth > 6) return "[deep]";
  if(value == null) return value;
  if(typeof value === "string"){
    // base58 私鑰長度大約 87-88 字元，base64 簽名交易也很長
    if(value.length >= 80 && /^[A-Za-z0-9+/=]+$/.test(value)) return `[redacted:${value.length}chars]`;
    return value;
  }
  if(Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if(typeof value === "object"){
    const out = {};
    for(const [k, v] of Object.entries(value)){
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function line(level, msg, meta){
  const ts = new Date().toISOString();
  const tail = meta === undefined ? "" : " " + JSON.stringify(redact(meta));
  return `${ts} ${level} ${msg}${tail}`;
}

export const log = {
  info:  (msg, meta) => console.log(line("INFO ", msg, meta)),
  warn:  (msg, meta) => console.warn(line("WARN ", msg, meta)),
  error: (msg, meta) => console.error(line("ERROR", msg, meta)),
  trade: (msg, meta) => console.log(line("TRADE", msg, meta))
};
