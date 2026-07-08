@echo off
setlocal
cd /d "%~dp0"
title ccproxy-agent
echo Starting ccproxy-agent...
echo Logs: %~dp0logs\ccproxy-agent.log
echo.
node dist\index.js
echo.
echo ccproxy-agent stopped. Press any key to close.
pause >nul
