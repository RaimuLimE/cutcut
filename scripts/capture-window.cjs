'use strict'
// 用 PrintWindow 直接抓窗口位图（不依赖屏幕坐标/DPI 换算）
// 输出 PNG，供人眼或后续工具查看
//
// 用法: node capture-window.cjs <输出png> [进程名或窗口标题关键字]
//   缺省关键字自动在 CutCut / electron 之间尝试，
//   这样开发模式（electron.exe）和安装版（CutCut.exe）都能抓。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const out = process.argv[2] || path.join(__dirname, '..', 'verify', 'installed', 'window-print.png')
const match = process.argv[3] || ''

const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
# 本机 150% 缩放：不声明 DPI 感知时 GetWindowRect 返回虚拟像素（1181x781），
# 而 PrintWindow 实际渲染 1770x1170，结果整幅图右侧/下方被裁掉。
# -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
try { [void][PW]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
$key = '${match}'
if ($key) {
  $p = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$key*" -or $_.MainWindowTitle -like "*$key*")
  } | Select-Object -First 1
} else {
  # 没指定就按产品名/标题找，再退回 electron（开发模式）
  $p = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and ($_.ProcessName -eq 'CutCut' -or $_.MainWindowTitle -like '*CutCut*')
  } | Select-Object -First 1
  if (-not $p) {
    $p = Get-Process electron -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*CutCut*' } |
      Select-Object -First 1
  }
}
if (-not $p) { Write-Output 'NO_WINDOW'; exit 1 }
$h = $p.MainWindowHandle
# 最小化时窗口坐标是 -21333 之类的哨兵值，PrintWindow 只能抓到标题栏大小的图，
# 必须先 SW_RESTORE(9) 还原
if ([PW]::IsIconic($h)) {
  [void][PW]::ShowWindow($h, 9)
  Start-Sleep -Milliseconds 900
}
[void][PW]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0002)
Start-Sleep -Milliseconds 800
$r = New-Object PW+RECT
[void][PW]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 0x2 = PW_RENDERFULLCONTENT
[void][PW]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save('${out.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("OK {0} x {1} [{2}]" -f $w, $hh, $p.ProcessName)
`

const r = execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
console.log(r.trim())
if (fs.existsSync(out)) console.log('saved ' + out + ' ' + fs.statSync(out).size + 'B')
