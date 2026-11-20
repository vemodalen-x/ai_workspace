@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0dist\launcher\src\index.js" %*
set "workspace_result=%errorlevel%"
if not "%workspace_result%"=="0" if "%~1"=="" pause
exit /b %workspace_result%
