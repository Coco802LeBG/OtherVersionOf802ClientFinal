@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n est pas installe. Installe la version LTS depuis https://nodejs.org puis double-clique a nouveau ce fichier.
  pause
  exit /b
)
if not exist node_modules (
  echo Premiere installation, ca peut prendre quelques minutes...
  call npm install --no-audit --no-fund
)
call npm start
pause
