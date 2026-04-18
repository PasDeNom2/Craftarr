@echo off
setlocal

set DIR=%~dp0
set DIR=%DIR:~0,-1%
set ENV_FILE=%DIR%\.env

if not exist "%ENV_FILE%" type nul > "%ENV_FILE%"

set HOST_DATA_PATH=%DIR%\data

powershell -Command "(Get-Content '%ENV_FILE%') -replace '^HOST_DATA_PATH=.*', '' | Where-Object { $_ -ne '' } | Set-Content '%ENV_FILE%'"
echo HOST_DATA_PATH=%HOST_DATA_PATH%>> "%ENV_FILE%"

if not exist "%DIR%\data\servers" mkdir "%DIR%\data\servers"

echo HOST_DATA_PATH=%HOST_DATA_PATH%
echo.
echo Lancement de Craftarr...
docker compose up -d --build
