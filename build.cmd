@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   CutCut 1.4 打包脚本（模型不随包分发）
echo ============================================
echo.

REM ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成 node，必须清掉
set ELECTRON_RUN_AS_NODE=

REM 国内镜像（electron 二进制 + electron-builder 的 nsis 工具链）
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/5] 安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
  echo     下载 Electron 运行时...
  call node node_modules\electron\install.js
  if errorlevel 1 goto :fail
) else (
  echo [1/5] 依赖已就绪
)

echo [2/5] 生成图标与浏览器扩展...
call node scripts\make-icon.cjs
if errorlevel 1 goto :fail
rem 扩展的 icons\ 目录
call node scripts\make-ext-icons.cjs
if errorlevel 1 goto :fail
rem 把 manifest.key 写进 browser-ext（固定扩展 ID）+ 顺带产出一个 .crx 备用
call node scripts\make-crx.cjs
if errorlevel 1 goto :fail

rem 1.3 起安装包内不再包含模型：首次运行由应用下载到 %APPDATA%\cutcut\models
rem 这里只做一项检查——模型分发清单的 sha256 与本地模型一致，
rem 不一致说明清单写错了，装出去的包会下载到「校验失败」。
echo [3/5] 校验模型分发清单...
call node scripts/check-catalog.cjs
if errorlevel 1 goto :fail

echo [4/5] 冒烟测试（无界面，验证两个模型都能跑）...
call node scripts\verify-models.cjs
if errorlevel 1 (
  echo     冒烟测试失败，终止打包
  goto :fail
)

echo [5/5] 开始打包（约 2-4 分钟）...
if exist dist rmdir /s /q dist
call node node_modules\electron-builder\cli.js --win nsis --x64
if errorlevel 1 goto :fail

echo.
echo ============================================
echo   完成！产物在 dist\ 目录
echo ============================================
dir /b dist\*.exe
exit /b 0

:fail
echo.
echo *** 打包失败 ***
exit /b 1
