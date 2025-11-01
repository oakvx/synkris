@echo off
setlocal
pushd %~dp0
node "%~dp0license-generator.js" --menu
popd
endlocal
