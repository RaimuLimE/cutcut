# 下载 RMBG-2.0 ONNX 模型（国内可用源：ModelScope）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\download-model.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # rmbg-cutout\
$dest = Join-Path $root 'models'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$base = 'https://modelscope.cn/models/AI-ModelScope/RMBG-2.0/resolve/master'
$files = @(
  @{ path = 'onnx/model_fp16.onnx';          size = 489800000 },   # 推荐：GPU 快、体积适中
  @{ path = 'onnx/model_quantized.onnx';     size = 349100000 },   # 更小，纯 CPU 用
  @{ path = 'config.json';                   size = 0 },
  @{ path = 'preprocessor_config.json';      size = 0 }
)

$headers = @{
  'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  'Referer'    = 'https://modelscope.cn/'
}

foreach ($f in $files) {
  $name = Split-Path -Leaf $f.path
  $out = Join-Path $dest $name
  if ((Test-Path $out) -and (Get-Item $out).Length -gt 1MB) {
    Write-Host "[skip] $name 已存在" -ForegroundColor DarkGray
    continue
  }
  $url = "$base/$($f.path)"
  Write-Host "[get ] $name" -ForegroundColor Cyan
  try {
    Invoke-WebRequest -Uri $url -OutFile $out -Headers $headers -TimeoutSec 1800
    $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Write-Host "       $mb MB" -ForegroundColor Green
  } catch {
    Write-Host "       失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "       可手动访问 $url 下载后放入 $dest" -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '模型目录：' -NoNewline
Get-ChildItem $dest | ForEach-Object { Write-Host ("  {0}  {1} MB" -f $_.Name, [math]::Round($_.Length / 1MB, 1)) }
