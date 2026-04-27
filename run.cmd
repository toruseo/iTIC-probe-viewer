@echo off
setlocal
cd /d "%~dp0"

set "MODE=auto"
set "LIMIT="

:parseargs
if "%~1"=="" goto args_done
if /i "%~1"=="--serve"   (set "MODE=serve"   & shift & goto parseargs)
if /i "%~1"=="--rebuild" (set "MODE=rebuild" & shift & goto parseargs)
if /i "%~1"=="--limit"   (set "LIMIT=%~2"    & shift & shift & goto parseargs)
echo unknown arg: %~1
echo usage: run.cmd [--serve] [--rebuild] [--limit N]
exit /b 1
:args_done

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH. Install from https://nodejs.org/ and retry.
  exit /b 1
)

REM Check for vite specifically — a half-finished install can leave
REM node_modules without the actual dev server binary.
if not exist "webgis\app\node_modules\vite\bin\vite.js" (
  echo [1/3] Installing frontend dependencies...
  pushd "webgis\app"
  call npm install --no-audit --no-fund
  if errorlevel 1 (popd & exit /b 1)
  popd
) else (
  echo [1/3] Dependencies present, skipping npm install.
)

set "DO_PREP=0"
if /i "%MODE%"=="rebuild" set "DO_PREP=1"
if not exist "webgis\app\public\data\meta.json" set "DO_PREP=1"
if /i "%MODE%"=="serve" set "DO_PREP=0"

if "%DO_PREP%"=="1" (
  echo [2/3] Running preprocess...
  pushd "webgis\preprocess"
  call node preprocess.mjs
  if errorlevel 1 (popd & exit /b 1)
  popd
) else (
  echo [2/3] Preprocessed data present, skipping. ^(--rebuild to redo^)
)

echo [3/3] Starting Vite dev server at http://127.0.0.1:5173/
echo       Ctrl+C to stop.
pushd "webgis\app"
call npm run dev -- --open
popd
