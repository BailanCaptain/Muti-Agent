<#
F042 AC5 · Multi-Agent 进程外守活探针（单发设计，由 Windows 任务计划周期拉起）。

为什么进程外：runtime 内部 cron 无法监控自身死亡（2026-07-10 审计：主 runtime 停机
后 NHC/digest 全静默，无人察觉与故意停用不可区分）。本脚本区分两态：
  - 意外死亡：探活失败 → Windows toast 报警 + 日志
  - 手动停用：维护 flag 在 → 静默跳过（不误报）

安装（当前用户权限即可，20 分钟一发）：
  schtasks /create /tn "MultiAgent-HealthProbe" /sc minute /mo 20 /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\-\Desktop\Multi-Agent\scripts\health-probe.ps1"
卸载：
  schtasks /delete /tn "MultiAgent-HealthProbe" /f
维护模式（手动停 runtime 前开、重启后关）：
  powershell -File scripts\health-probe.ps1 -SetMaintenance on
  powershell -File scripts\health-probe.ps1 -SetMaintenance off

exit code：0 = 健康/维护静默/flag 操作完成；1 = 探活失败已报警。
#>
param(
  [string]$ApiUrl = "http://localhost:8787/health",
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateSet("", "on", "off")]
  [string]$SetMaintenance = ""
)

$runtimeDir = Join-Path $RepoRoot ".runtime"
$flagPath = Join-Path $runtimeDir "maintenance.flag"
$logPath = Join-Path $runtimeDir "health-probe.log"
if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Force $runtimeDir | Out-Null }

if ($SetMaintenance -eq "on") {
  "manual stop $(Get-Date -Format o)" | Out-File $flagPath -Encoding utf8
  Write-Output "maintenance ON — probe silenced ($flagPath)"
  exit 0
}
if ($SetMaintenance -eq "off") {
  if (Test-Path $flagPath) { Remove-Item $flagPath -Force -Confirm:$false }
  Write-Output "maintenance OFF — probe armed"
  exit 0
}

# 维护模式：静默（手动停用不是事故）
if (Test-Path $flagPath) { exit 0 }

$ok = $false
try {
  $resp = Invoke-WebRequest -Uri $ApiUrl -UseBasicParsing -TimeoutSec 5
  $ok = ($resp.StatusCode -eq 200)
} catch {
  $ok = $false
}

$stamp = Get-Date -Format o
if ($ok) {
  Add-Content $logPath "$stamp OK $ApiUrl"
  exit 0
}

Add-Content $logPath "$stamp FAIL $ApiUrl"
# WinRT toast（PS5.1 原生零模块依赖）；toast 不可用退化 msg 弹窗；两者都挂只剩日志
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $xml.GetElementsByTagName("text")
  $null = $texts.Item(0).AppendChild($xml.CreateTextNode("Multi-Agent API 探活失败"))
  $null = $texts.Item(1).AppendChild($xml.CreateTextNode("$ApiUrl 无响应（$stamp）。若是手动停用请跑 health-probe.ps1 -SetMaintenance on"))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Multi-Agent 守活").Show($toast)
} catch {
  try { & "$env:SystemRoot\System32\msg.exe" $env:USERNAME "Multi-Agent API 探活失败: $ApiUrl（$stamp）" } catch {}
}
exit 1
