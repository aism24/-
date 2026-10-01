@echo off
rem Cost Insight: jikko-yosan (budget) update. Started from the app button (costinsight://) or by double-click.
rem Uses pc\node.exe if present (no Node install needed on each PC).
pushd "%~dp0pc"
chcp 65001 >nul
if exist node.exe (
  node.exe update.js
) else (
  node update.js
)
set RC=%errorlevel%
popd
echo.
if not "%RC%"=="0" (
  pause
) else (
  timeout /t 15
)
exit /b %RC%
