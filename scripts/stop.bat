@echo off
rem stop.bat [port] -- stops a backend started by run.bat (finds what's
rem listening on that port and its uvicorn --reload parent process, kills
rem both) without touching the Elasticsearch container -- ES stays up so the
rem next run.bat launch skips its slow cold-start. Run `docker stop es`
rem yourself if you want that stopped too.
rem
rem The port defaults to 8000, the 768-dim profile. Pass 8001 for 1152 or
rem 8002 for 1536; profiles are separate processes, so stopping one leaves
rem the others running.

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

echo === Stopping Routing101 on :%PORT% ===
powershell -NoProfile -Command ^
    "$p = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess;" ^
    "if (-not $p) { Write-Output 'No Routing101 backend found listening on port %PORT%.'; exit }" ^
    "$parent = (Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").ParentProcessId;" ^
    "Stop-Process -Id $p -Force -ErrorAction SilentlyContinue;" ^
    "if ($parent) { Stop-Process -Id $parent -Force -ErrorAction SilentlyContinue };" ^
    "Write-Output 'Backend stopped.'"

echo.
echo Elasticsearch container "es" is left running (fast next launch).
echo To stop it too:   docker stop es
pause
