@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
    py -3 desktop.py %*
) else (
    python desktop.py %*
)
if errorlevel 1 (
    echo.
    echo Ledger could not start. Python 3 with Tkinter is required.
    pause
)
endlocal
