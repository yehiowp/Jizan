# 無人看管時的守門員（Windows 版）：程式掛掉就重啟，紀錄檔太大就輪替。
#
# 為什麼需要：電腦開著沒人看，程式半夜當掉的話會靜靜停在那裡。
# 已開的倉有 GMGN 伺服器端的停損保護，但機器人本身停了就不會再對帳、
# 不會再掃描、也不會通知你 —— 你會以為它在跑。
#
# 用法（在 bot 資料夾裡）：
#   powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1
#
# 要停：在這個視窗按 Ctrl+C。

$ErrorActionPreference = "Stop"

# 切到 bot 資料夾（這個腳本在 bot\scripts\ 底下）
Set-Location (Split-Path -Parent $PSScriptRoot)

$Log = Join-Path $HOME "gmgn-bot.log"
$MaxBytes = 5MB

# 紀錄檔用 UTF-8 寫。Windows PowerShell 預設會寫成 UTF-16，
# 那份檔案用 tail / type 看會是一堆空格夾雜的亂碼。
$enc = New-Object System.Text.UTF8Encoding $false

function Write-Log([string]$msg){
  $line = "{0} {1}`n" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $msg
  [System.IO.File]::AppendAllText($Log, $line, $enc)
  Write-Host $line.TrimEnd()
}

Write-Log "守門員啟動，紀錄檔：$Log"

while ($true) {
  # 紀錄檔輪替：只留最近一份舊的
  if (Test-Path $Log) {
    if ((Get-Item $Log).Length -gt $MaxBytes) {
      Move-Item $Log "$Log.1" -Force
      Write-Log "紀錄檔輪替"
    }
  }

  Write-Log "啟動機器人"

  # 用 Start-Process -Wait 才拿得到正確的離開碼；直接 node ... | Tee 會拿到管線的碼。
  $p = Start-Process -FilePath "node" -ArgumentList "src/index.js" `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput "$Log.out" -RedirectStandardError "$Log.err"

  # 把這一輪的輸出併回主紀錄檔，然後清掉暫存
  foreach ($f in @("$Log.out", "$Log.err")) {
    if (Test-Path $f) {
      $t = [System.IO.File]::ReadAllText($f)
      if ($t) { [System.IO.File]::AppendAllText($Log, $t, $enc) }
      Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
  }

  # 正常關閉（Ctrl+C / 收到 SIGTERM）就不要再拉起來
  if ($p.ExitCode -eq 0) {
    Write-Log "正常結束，不重啟"
    exit 0
  }

  Write-Log ("異常結束（code={0}），10 秒後重啟" -f $p.ExitCode)
  Start-Sleep -Seconds 10
}
