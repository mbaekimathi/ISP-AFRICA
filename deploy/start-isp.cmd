@echo off
setlocal
cd /d "%~dp0.."

REM ISP CENTRIC launcher.
REM   start-isp.cmd          auto-detect (ISP_ENV env var, else frontend\node_modules)
REM   start-isp.cmd local    development: api.py on 8765 + Vite dev server on 5173
REM   start-isp.cmd prod     production:  api.py serves frontend\dist on 8765

set "MODE=%~1"
if /i "%MODE%"=="dev" set "MODE=local"
if /i "%MODE%"=="development" set "MODE=local"
if /i "%MODE%"=="production" set "MODE=prod"

if "%MODE%"=="" if defined ISP_ENV (
    if /i "%ISP_ENV%"=="production" (set "MODE=prod") else (set "MODE=local")
)
if "%MODE%"=="" (
    if exist "frontend\node_modules" (set "MODE=local") else (set "MODE=prod")
)

if /i "%MODE%"=="local" goto :local
if /i "%MODE%"=="prod" goto :prod
echo Usage: %~nx0 [local^|prod] 1>&2
exit /b 2

:prod
set "ISP_ENV=production"
if not exist "frontend\dist\index.html" (
    echo [start-isp] warning: frontend\dist is missing - the dashboard will not load. 1>&2
    echo [start-isp] run "npm run build" inside frontend\ or copy a ready-made dist. 1>&2
)
echo [start-isp] mode=production ^(ISP_ENV=production^)
echo [start-isp] dashboard: http://localhost:8765
cd database
python api.py
goto :eof

:local
where npm >nul 2>nul
if errorlevel 1 (
    echo [start-isp] npm not found. Install Node.js or run "%~nx0 prod". 1>&2
    exit /b 1
)
if not exist "frontend\node_modules" (
    echo [start-isp] installing frontend dependencies...
    pushd frontend
    call npm ci
    popd
)
set "ISP_ENV=development"
echo [start-isp] mode=local ^(ISP_ENV=development^)
echo [start-isp] API:      http://127.0.0.1:8765
echo [start-isp] Frontend: http://localhost:5173
start "ISP CENTRIC - api.py" /d "%CD%\database" python api.py
cd frontend
npm run dev
