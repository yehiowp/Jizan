# 一條鏈一個機器人：每條鏈各開一個守門員行程。
#
# 用法（在 bot 資料夾裡）：
#   powershell -ExecutionPolicy Bypass -File scripts\run-all-chains.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\run-all-chains.ps1 -Chains sol,bsc,base
#
# 每個機器人：
#   · 自己的帳本      data\state-<鏈>.json
#   · 自己的紀錄      %USERPROFILE%\gmgn-bot-<鏈>.log
#   · 自己的 Telegram Token（.env 裡的 TELEGRAM_TOKEN_SOL、TELEGRAM_TOKEN_BSC…）
#   · 共用的限流封禁  data\rate-limit.json
#
# ⚠️ 風控上限是每個機器人各算各的。開 N 個 = 總曝險上限乘以 N。
#    這是你選的「各自獨立帳本」的直接後果，不是 bug。
#    任何一個機器人的 /status 都會把合計數字攤給你看。

param(
  [string]$Chains = "",
  [switch]$Stop
)

$ErrorActionPreference = "Stop"
$BotDir = Split-Path -Parent $PSScriptRoot
Set-Location $BotDir

if ($Stop) {
  Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
  Write-Host "已停掉所有 node 行程。"
  exit 0
}

# 沒指定就讀 .env 的 CHAINS
if (-not $Chains) {
  $line = Select-String -Path ".env" -Pattern '^\s*CHAINS\s*=\s*(.+)$' -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if ($line) { $Chains = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $Chains) { $Chains = "sol" }

# all 展開成可掃描的全部
if ($Chains -eq "all") { $Chains = "sol,bsc,base,eth,robinhood,arc,stable,arbitrum,hyperevm" }

$list = $Chains -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }

Write-Host ""
Write-Host "要啟動的鏈：$($list -join ', ')"
Write-Host ""

# Telegram 同一個 Token 只允許一個行程輪詢。兩個一起跑會互相把對方踢掉（HTTP 409），
# 而且症狀是「訊息有時收得到有時收不到」，很難看出原因。所以先檢查再啟動。
$envText = if (Test-Path ".env") { Get-Content ".env" -Raw } else { "" }
$missing = @()
foreach ($c in $list) {
  $key = "TELEGRAM_TOKEN_" + $c.ToUpper()
  if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S") { $missing += $c }
}

if ($missing.Count -gt 1) {
  Write-Host "❌ 這些鏈沒有自己的 Telegram Token：$($missing -join ', ')"
  Write-Host ""
  Write-Host "   Telegram 同一個 Token 只允許一個行程輪詢。兩個以上一起跑，"
  Write-Host "   它們會互相把對方踢掉，症狀是訊息時有時無 —— 很難看出原因。"
  Write-Host ""
  Write-Host "   跟 @BotFather 每條鏈各申請一個 /newbot，然後在 .env 裡加："
  foreach ($c in $missing) { Write-Host ("     TELEGRAM_TOKEN_" + $c.ToUpper() + "=<那個機器人的 token>") }
  Write-Host ""
  exit 1
}

foreach ($c in $list) {
  Write-Host "啟動 $c …"
  $inner = "`$env:INSTANCE='$c'; `$env:CHAIN='$c'; `$env:CHAINS='$c'; " +
           "powershell -ExecutionPolicy Bypass -File '$BotDir\scripts\run-forever.ps1'"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", $inner `
    -WorkingDirectory $BotDir
  Start-Sleep -Milliseconds 800   # 錯開啟動，不要 9 個行程同時去敲 GMGN
}

Write-Host ""
Write-Host "✅ 已啟動 $($list.Count) 個機器人。"
Write-Host ""
Write-Host "看紀錄：   Get-Content `$HOME\gmgn-bot-<鏈>.log -Tail 40 -Wait"
Write-Host "全部停掉： powershell -ExecutionPolicy Bypass -File scripts\run-all-chains.ps1 -Stop"
Write-Host ""
Write-Host "⚠️ 風控上限是每個機器人各算各的，開 $($list.Count) 個 = 總曝險上限乘以 $($list.Count)。"
Write-Host "   任一機器人的 /status 都會把合計數字攤給你看。"
Write-Host ""
