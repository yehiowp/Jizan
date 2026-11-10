param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$projectDirectory = $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path -Parent $projectDirectory) 'output\personal-ledger-v3'
}
$buildDirectory = Join-Path (Split-Path -Parent $projectDirectory) 'output\personal-ledger-build'
$schemaPath = Join-Path $projectDirectory 'schema.sql'
$desktopPath = Join-Path $projectDirectory 'desktop.py'
python -m unittest discover -s $projectDirectory -p 'test_*.py'
if ($LASTEXITCODE -ne 0) { throw 'Tests failed; executable was not rebuilt.' }
python -m PyInstaller --noconfirm --clean --onefile --windowed --noupx --name PersonalLedger --add-data ($schemaPath + ';.') --hidden-import pypdf --hidden-import sync_server --hidden-import statements --hidden-import bank_statement --hidden-import integrations --hidden-import transfer --distpath $OutputDirectory --workpath $buildDirectory --specpath $buildDirectory $desktopPath
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
$executablePath = Join-Path $OutputDirectory 'PersonalLedger.exe'
$testDatabase = Join-Path ([System.IO.Path]::GetTempPath()) ('ledger-package-test-' + [guid]::NewGuid().ToString() + '.sqlite3')
$testProcess = Start-Process -FilePath $executablePath -ArgumentList @('--smoke-test','--database',('"' + $testDatabase + '"')) -WindowStyle Hidden -Wait -PassThru
if ($testProcess.ExitCode -ne 0) { throw 'Packaged application smoke test failed.' }
Write-Output ('Built and verified: ' + $executablePath)
