@echo off
REM Starts CoDev Studio on Windows: the page at http://localhost:3000 and,
REM if Python is installed, the free search/commands helper on port 8787.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
where python >nul 2>nul && (
  python -c "import ddgs" >nul 2>nul || python -m pip install -r tools\ddgs-helper\requirements.txt
  start "CoDev helper" python tools\ddgs-helper\ddgs_helper.py
) || echo Python not found: web search on desktop will be off. Get Python from https://python.org to turn it on.
start "" http://localhost:3000
node server.js
pause
