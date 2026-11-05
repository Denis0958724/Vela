@echo off
setlocal
cd /d "%~dp0"

rem Keep Vela's writable profile inside the project. On this Windows install the
rem Chromium sandbox cannot access %APPDATA%\Vela, so a normal Electron launch
rem exits before main() and the app looks dead. The local profile also survives
rem the signed-runtime workaround.
set "VELA_USER_DATA=%~dp0.vela-data"

rem The packaged Vela.exe is an unsigned copy of Electron. Launch the signed
rem Electron runtime with the same app.asar instead.
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" --no-sandbox "%~dp0release\win-unpacked\resources\app.asar"
  exit /b 0
)

if exist "%~dp0release\win-unpacked\Vela.exe" (
  start "" "%~dp0release\win-unpacked\Vela.exe" --no-sandbox
  exit /b 0
)

echo Vela runtime not found.
pause
exit /b 1
