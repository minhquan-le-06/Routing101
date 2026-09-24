@echo off
rem run.bat [768|1152|1536] -- launches Routing101 on one embedding profile.
rem Double-clicking it (no argument) starts the default 768 profile.
rem
rem   run.bat        768-dim   siglip2-base-patch16-384      http://localhost:8000/app/
rem   run.bat 1152   1152-dim  siglip2-so400m-patch14-384    http://localhost:8001/app/
rem   run.bat 1536   1536-dim  siglip2-giant-opt-patch16-384 http://localhost:8002/app/
rem
rem   profile  model download  resident RAM  FAISS indices
rem   768      ~1.4GB          ~2.8GB        index/routing101_*
rem   1152     ~4.2GB          ~4-5GB        index/1152/routing101_*
rem   1536     ~7GB            ~9.4GB        index/1536/routing101_*
rem
rem The first run of a profile on a machine downloads its model and spends
rem several minutes building that profile's FAISS indices; later runs just
rem load them. Each profile is its own process on its own port, sharing one
rem Elasticsearch container and the same media files, so two can run side by
rem side to compare the same query in two tabs (the header pill in the UI
rem says which profile a tab is talking to). Two fit in 32GB; all three do
rem not -- pair 1536 with 768, not 1152.
rem
rem Leave this window open while you work -- it shows the live server log.
rem Close it (or Ctrl+C, then press Y) to stop the app, or run
rem scripts\stop.bat <port> from elsewhere.

setlocal
set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=768"
set "PORT="
if "%PROFILE%"=="768"  set "PORT=8000"
if "%PROFILE%"=="1152" set "PORT=8001"
if "%PROFILE%"=="1536" set "PORT=8002"
if "%PORT%"=="" (
    echo Unknown profile "%PROFILE%" -- use 768, 1152 or 1536.
    exit /b 1
)
call "%~dp0scripts\_run_common.bat"
endlocal
