<#
.SYNOPSIS
    LLM Cache Proxy 一键启停脚本
.USAGE
    .\proxy.ps1 start    # 启动代理（后台运行）
    .\proxy.ps1 stop     # 停止代理
    .\proxy.ps1 restart  # 重启代理
    .\proxy.ps1 status   # 查看运行状态
#>

param([Parameter(Position=0)][string]$Action = "start")

$Port = if ($env:PORT) { $env:PORT } else { "3456" }
$PidFile = ".proxy.pid"

function Get-ProxyProcess {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    }
    return $null
}

switch ($Action.ToLower()) {
    "start" {
        $proc = Get-ProxyProcess
        if ($proc) {
            Write-Host "Proxy already running (PID $($proc.Id), port $Port)" -ForegroundColor Yellow
            exit 0
        }
        Write-Host "Starting LLM Cache Proxy on port $Port..." -ForegroundColor Cyan
        $proc = Start-Process -FilePath "npm" -ArgumentList "run", "dev" -WindowStyle Hidden -PassThru
        $proc.Id | Out-File -FilePath $PidFile -Encoding ascii -NoNewline
        Start-Sleep -Seconds 2
        if (Get-ProxyProcess) {
            Write-Host "Proxy started (PID $($proc.Id))" -ForegroundColor Green
            Write-Host "  Dashboard: http://localhost:$Port/dashboard" -ForegroundColor Gray
            Write-Host "  OpenAI:    http://localhost:$Port/v1" -ForegroundColor Gray
        } else {
            Write-Host "Proxy may have failed to start, check logs" -ForegroundColor Red
        }
    }
    "stop" {
        $proc = Get-ProxyProcess
        if (-not $proc) {
            Write-Host "Proxy is not running" -ForegroundColor Yellow
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
            exit 0
        }
        Stop-Process -Id $proc.Id -Force
        Write-Host "Proxy stopped (PID $($proc.Id))" -ForegroundColor Green
        if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
    }
    "restart" {
        & $PSCommandPath stop
        Start-Sleep -Seconds 1
        & $PSCommandPath start
    }
    "status" {
        $proc = Get-ProxyProcess
        if ($proc) {
            Write-Host "Proxy is running (PID $($proc.Id), port $Port)" -ForegroundColor Green
        } else {
            Write-Host "Proxy is stopped" -ForegroundColor Gray
        }
    }
    default {
        Write-Host "Usage: .\proxy.ps1 {start|stop|restart|status}" -ForegroundColor Cyan
        exit 1
    }
}
