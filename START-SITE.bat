@echo off
title ACWA Operations
setlocal
set "ROOT=%~dp0"

echo ============================================
echo   ACWA Operations - Demarrage du site
echo ============================================
echo.

taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [1/2] Demarrage du serveur...
start "ACWA-SERVER" /min cmd /c "cd /d "%ROOT%." && node server.js"
timeout /t 3 /nobreak >nul

echo [2/2] Tunnel public...
if defined NGROK_DOMAIN (
    start "ACWA-TUNNEL" /min cmd /c "%ROOT%tools\ngrok.exe" http --domain=%NGROK_DOMAIN% 3000
    echo      Domaine : %NGROK_DOMAIN%
) else (
    echo      NGROK_DOMAIN non defini - tunnel local uniquement.
    echo      Pour un lien public :  set NGROK_DOMAIN=votre-domaine.ngrok-free.dev
    start "ACWA-TUNNEL" /min cmd /c "%ROOT%tools\ngrok.exe" http 3000
)

echo.
echo ============================================
echo   Site en ligne!
echo   Partage le lien affiche dans la fenetre
echo   ACWA-TUNNEL avec tes collegues
echo ============================================
timeout /t 5 >nul
