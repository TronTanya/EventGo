@echo off
setlocal
pushd "%~dp0"
title EventGo
echo.
echo   Starting EventGo...
echo   Keep this window open while using the website.
echo.
if not exist "runtime\node.exe" (
  echo ERROR: runtime\node.exe is missing. Extract the whole yba folder first.
  pause
  popd
  exit /b 1
)
if exist "db.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("db.env") do set "%%A=%%B"
)
if exist "mail.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("mail.env") do set "%%A=%%B"
)
"runtime\node.exe" --no-warnings --use-env-proxy server.mjs --open
if errorlevel 1 (
  echo.
  echo Could not start EventGo. See the message above.
  pause
)
popd
