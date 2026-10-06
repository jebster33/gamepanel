<#
  Removes GamePanel from Windows and everything it created: the service, the
  firewall rules, the program folder, and all data in C:\ProgramData\GamePanel
  (game servers, backups, users, bridge connections and settings).

    powershell -ExecutionPolicy Bypass -File "C:\Program Files\GamePanel\windows\uninstall.ps1"
    powershell -ExecutionPolicy Bypass -File "...\uninstall.ps1" -KeepData   # keep servers and settings
    powershell -ExecutionPolicy Bypass -File "...\uninstall.ps1" -Yes        # no confirmation
#>
param([switch]$KeepData, [switch]$Yes, [switch]$RemoveData)

$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path $PSScriptRoot -Parent
$DataDir = Join-Path $env:ProgramData 'GamePanel'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($KeepData) { $argList += '-KeepData' }
  if ($Yes) { $argList += '-Yes' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $argList
  return
}

if (-not $Yes -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  Write-Host ''
  if ($KeepData) {
    Write-Host "This removes the GamePanel program and service. Servers and settings in $DataDir are kept."
  } else {
    Write-Host 'This removes GamePanel and ALL of its data:' -ForegroundColor Yellow
    Write-Host '  - every game server and its world files, and all backups'
    Write-Host '  - panel users, bridge connections and settings'
    Write-Host "  - the program in $InstallDir"
  }
  if ((Read-Host 'Type YES to continue') -cne 'YES') { Write-Host 'Cancelled.'; return }
}

$wrapper = Join-Path $InstallDir 'GamePanel-Service.exe'
if (Get-Service -Name GamePanel -ErrorAction SilentlyContinue) {
  Write-Host '==> Stopping and removing the GamePanel service'
  Stop-Service GamePanel -Force -ErrorAction SilentlyContinue
  if (Test-Path $wrapper) { & $wrapper uninstall | Out-Null } else { sc.exe delete GamePanel | Out-Null }
}

# Game servers started by the panel run as their own processes (or containers); stop them too.
& (Join-Path $PSScriptRoot 'stop-servers.ps1')

Write-Host "==> Removing $InstallDir"
Set-Location $env:TEMP
Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue

if ($KeepData) {
  Write-Host "Kept your servers and settings in $DataDir."
} else {
  Write-Host "==> Removing $DataDir (servers, backups, users, settings)"
  Start-Sleep -Seconds 2 # let file locks from stopped processes go
  Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $DataDir) { Write-Warning "Some files in $DataDir are still in use. Delete the folder after a restart." }
}
Write-Host 'GamePanel is uninstalled.' -ForegroundColor Green
