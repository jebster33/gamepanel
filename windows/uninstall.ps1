<#
  Removes GamePanel from Windows: the service, the firewall rule and the
  program folder. Game servers, backups and settings in C:\ProgramData\GamePanel
  stay unless you pass -RemoveData.

    powershell -ExecutionPolicy Bypass -File "C:\Program Files\GamePanel\windows\uninstall.ps1"
    powershell -ExecutionPolicy Bypass -File "...\uninstall.ps1" -RemoveData
#>
param([switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path $PSScriptRoot -Parent
$DataDir = Join-Path $env:ProgramData 'GamePanel'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($RemoveData) { $argList += '-RemoveData' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  return
}

$wrapper = Join-Path $InstallDir 'GamePanel-Service.exe'
if (Get-Service -Name GamePanel -ErrorAction SilentlyContinue) {
  Write-Host '==> Stopping and removing the GamePanel service'
  Stop-Service GamePanel -Force -ErrorAction SilentlyContinue
  if (Test-Path $wrapper) { & $wrapper uninstall | Out-Null } else { sc.exe delete GamePanel | Out-Null }
}

# Game servers started by the panel run as their own processes; stop them too.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $DataDir 'servers'), [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-NetFirewallRule -DisplayName 'GamePanel*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

Write-Host "==> Removing $InstallDir"
Set-Location $env:TEMP
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue

if ($RemoveData) {
  Write-Host "==> Removing $DataDir (servers, backups, settings)"
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "Kept your servers and settings in $DataDir. Delete that folder to remove them too."
}
Write-Host 'GamePanel is uninstalled.' -ForegroundColor Green
