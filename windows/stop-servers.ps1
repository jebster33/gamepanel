<#
  Stops everything GamePanel started, so its files can be deleted: game
  server processes running out of C:\ProgramData\GamePanel\servers, their
  containers (when Docker is installed), and the per-server firewall rules.
  Used by the uninstallers.
#>
$ErrorActionPreference = 'SilentlyContinue'
$servers = Join-Path $env:ProgramData 'GamePanel\servers'

Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($servers, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if (Get-Command docker) {
  $ids = docker ps -aq --filter label=gamepanel.managed=true 2>$null
  if ($ids) { docker rm -f $ids 2>$null | Out-Null }
}

Get-NetFirewallRule -DisplayName 'GamePanel*' | Remove-NetFirewallRule
