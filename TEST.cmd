@echo off
setlocal
pushd "%~dp0"
"runtime\node.exe" --no-warnings --test tests\*.test.mjs
pause
popd
