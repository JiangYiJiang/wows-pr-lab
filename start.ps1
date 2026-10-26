<#
  PR Lab · 本地启动脚本
  用法：
    .\start.ps1 -AppId "你的32位WG应用ID"
  或先设置环境变量后直接运行：
    $env:WG_APP_ID="..."; .\start.ps1
#>
param([string]$AppId = $env:WG_APP_ID, [int]$Port = 5173)

if (-not $AppId) {
  Write-Host "缺少 Wargaming application_id。" -ForegroundColor Yellow
  Write-Host "用法: .\start.ps1 -AppId `"你的32位ID`"" -ForegroundColor Yellow
  exit 1
}

$env:WG_APP_ID = $AppId
$env:PORT = $Port
Set-Location (Join-Path $PSScriptRoot 'app')

if (-not (Test-Path 'data\calibration.json')) {
  Write-Host "缺少校准表，先运行 build_calibration.js（需要 population.json）" -ForegroundColor Yellow
}

Write-Host "PR Lab 启动: http://127.0.0.1:$Port" -ForegroundColor Cyan
node server.js
