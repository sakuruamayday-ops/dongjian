@echo off
title Gongchuang Windows Device Acceptance
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows-device-acceptance.ps1"
set "GONGCHUANG_EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%GONGCHUANG_EXIT_CODE%"=="0" goto failed
echo Acceptance script completed. See the generated receipt and checklist.
goto done
:failed
echo Acceptance failed. Do not publish or replace the current candidate.
:done
pause
exit /b %GONGCHUANG_EXIT_CODE%
