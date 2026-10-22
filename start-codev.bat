@echo off
REM Starts CoDev Studio on Windows: the page at http://localhost:3000 and,
REM if Python is installed, the free search/MCP helper on port 8787.
REM Pass a project folder (start-codev.bat C:\path\to\game) to let agents edit
REM files and run commands there without asking.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
where python >nul 2>nul && (
  python -c "import ddgs" >nul 2>nul || python -m pip install -r tools\ddgs-helper\requirements.txt
  if "%~1"=="" (
    start "CoDev helper" python tools\ddgs-helper\ddgs_helper.py
  ) else (
    start "CoDev helper" python tools\ddgs-helper\ddgs_helper.py --project "%~1" --autonomous
  )
) || echo Python not found: web search on desktop will be off. Get Python from https://python.org to turn it on.
REM Setup installs npm packages, checks .env keys and Docker, and downloads
REM Chromium for the browser tools. It skips what is already done and only
REM warns about missing Docker or keys; see scripts\setup.js.
node scripts\setup.js || echo Setup found problems; see above. CoDev may not start.
REM Edge includes the natural Microsoft Ava voice for read-aloud; other browsers only get robotic ones.
start "" msedge http://localhost:3000 2>nul || start "" http://localhost:3000
node server.js %1
pause
