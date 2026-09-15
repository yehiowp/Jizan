# 把機器人註冊成 Windows 排程工作：開機自動啟動，關掉視窗也照樣跑。
#
# 用法（在 bot 資料夾裡，一般權限就好，不需要系統管理員）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
#
# 移除：
#   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Remove
#
# ⚠️ 看不見的程式在花你的錢，比開著的視窗危險。所以這支做了兩件事：
#    1. 只在「你登入」時啟動，不是系統開機就跑 —— 你沒登入它就不該在交易
#    2. 裝完會提醒你打開心跳，那是你唯一會察覺它停掉的訊號

param([switch]$Remove)

$ErrorActionPreference = "Stop"

$TaskName = "GMGN-Meme-Bot"
$BotDir   = Split-Path -Parent $PSScriptRoot
$Runner   = Join-Path $PSScriptRoot "run-forever.ps1"

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✅ 已移除排程工作 $TaskName"
    Write-Host "   注意：正在跑的機器人不會因此停止。要停它："
    Write-Host "     Get-Process node | Where-Object { `$_.Path -like '*node*' } | Stop-Process"
    Write-Host "   或直接在 Telegram 打 /panic 先把倉平掉。"
  } else {
    Write-Host "沒有找到排程工作 $TaskName，不用移除。"
  }
  exit 0
}

if (-not (Test-Path $Runner)) {
  Write-Host "❌ 找不到 $Runner"
  Write-Host "   請在 bot 資料夾裡執行這個腳本。"
  exit 1
}

# 真錢模式需要的那個環境變數，排程工作是拿不到的（它不繼承你 shell 裡的設定）。
# 這是刻意不去繞過的：那道防線本來就該由你本人在每次啟動時開，
# 所以排程跑的一定是模擬模式 —— 講清楚，不要讓你以為它在替你賺真錢。
$envFile = Join-Path $BotDir ".env"
$isLive = $false
if (Test-Path $envFile) {
  $isLive = (Select-String -Path $envFile -Pattern '^\s*DRY_RUN\s*=\s*false' -Quiet)
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Runner`"" `
  -WorkingDirectory $BotDir

# 只在登入時啟動。系統開機就跑聽起來更方便，但那表示你人不在、
# 螢幕鎖著、甚至根本沒登入的時候它也在下單。
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)   # 不設執行時間上限，不然跑滿三天會被系統砍掉

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "GMGN 迷因幣機器人（run-forever 守門員）" -Force | Out-Null

Write-Host ""
Write-Host "✅ 已註冊排程工作：$TaskName"
Write-Host "   登入時自動啟動，沒有視窗，關掉終端也不影響。"
Write-Host ""
Write-Host "現在就啟動：  Start-ScheduledTask -TaskName $TaskName"
Write-Host "看狀態：      Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "停掉：        Stop-ScheduledTask -TaskName $TaskName"
Write-Host "移除：        powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Remove"
Write-Host "看紀錄：      Get-Content `$HOME\gmgn-bot.log -Tail 40 -Wait"
Write-Host ""

if ($isLive) {
  Write-Host "⚠️ 你的 .env 是 DRY_RUN=false（真錢模式），但排程工作跑起來會是模擬模式。"
  Write-Host "   原因：真錢模式需要 GMGN_ALLOW_AUTOMATED_TRADES=1，而排程工作拿不到"
  Write-Host "   你 shell 裡的環境變數 —— 那道防線本來就該由你本人每次手動開。"
  Write-Host "   要跑真錢，請用終端機啟動（視窗留著最小化）："
  Write-Host "     `$env:GMGN_ALLOW_AUTOMATED_TRADES = `"1`""
  Write-Host "     powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1"
  Write-Host ""
}

Write-Host "⚠️ 看不見的程式在花錢，你需要一個「它還活著」的訊號："
Write-Host "   .env 裡的 HEARTBEAT_HOURS 設 12（預設就是），Telegram 會定時回報。"
Write-Host "   心跳沒來 = 它停了。那是你唯一會察覺的方式。"
Write-Host ""
