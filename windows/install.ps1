<#
  GamePanel installer for Windows 10/11 and Windows Server 2016 or newer.

  In PowerShell opened as Administrator:

    irm https://raw.githubusercontent.com/jebster33/gamepanel/main/windows/install.ps1 | iex

  Options are environment variables, set before the line above:

    $env:GP_PORT = 9000                       panel port (default 8080)
    $env:GP_INSTALL_DIR = 'D:\GamePanel'      program folder (default C:\Program Files\GamePanel)
    $env:GP_BRANCH = 'main'                   install this branch instead of the latest release

  Running it again updates an existing install in place. Servers, backups and
  settings live in C:\ProgramData\GamePanel and are never touched.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo       = if ($env:GP_REPO) { $env:GP_REPO } else { 'jebster33/gamepanel' }
$Port       = if ($env:GP_PORT) { [int]$env:GP_PORT } else { 8080 }
$InstallDir = if ($env:GP_INSTALL_DIR) { $env:GP_INSTALL_DIR } else { Join-Path $env:ProgramFiles 'GamePanel' }
$Branch     = $env:GP_BRANCH
$NodeMajor  = 22
$WinSwUrl   = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$DataDir    = Join-Path $env:ProgramData 'GamePanel'
$AppPaths   = 'server', 'public', 'templates', 'windows', 'package.json', 'README.md', 'LICENSE'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host " ok $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }

# ------------------------------------------------------------------ admin --

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($PSCommandPath) {
    # Started from a saved file: ask for elevation and run again.
    Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    return
  }
  Write-Host 'GamePanel installs a Windows service, which needs an Administrator PowerShell.' -ForegroundColor Red
  Write-Host 'Right-click Start, choose "Terminal (Admin)" or "Windows PowerShell (Admin)", and paste the command again.'
  return
}

Write-Host ''
Write-Host '  GamePanel installer for Windows' -ForegroundColor White
Write-Host ''

$work = Join-Path $env:TEMP "gamepanel-install-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Force -Path $work, $InstallDir, $DataDir | Out-Null

try {
  # ------------------------------------------------------------- source --

  Step 'Downloading GamePanel'
  $zipUrl = $null
  if (-not $Branch) {
    try {
      $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'GamePanel-Installer' }
      $zipUrl = $release.zipball_url
      Ok "Latest release $($release.tag_name)"
    } catch {
      $Branch = 'main'
      Warn 'No release published yet, installing the main branch'
    }
  }
  if (-not $zipUrl) { $zipUrl = "https://github.com/$Repo/archive/refs/heads/$Branch.zip" }
  $appZip = Join-Path $work 'app.zip'
  Invoke-WebRequest $zipUrl -OutFile $appZip -UseBasicParsing -Headers @{ 'User-Agent' = 'GamePanel-Installer' }
  Expand-Archive $appZip -DestinationPath (Join-Path $work 'app') -Force
  $src = Get-ChildItem (Join-Path $work 'app') -Directory | Select-Object -First 1
  if (-not (Test-Path (Join-Path $src.FullName 'server\index.js'))) { throw 'The download does not look like GamePanel.' }

  # -------------------------------------------------------------- node --

  Step "Downloading Node.js $NodeMajor"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $node = $index | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.files -contains "win-$arch-zip" } | Select-Object -First 1
  if (-not $node) { throw "Could not find a Node.js $NodeMajor build for win-$arch." }
  $nodeZip = Join-Path $work 'node.zip'
  Invoke-WebRequest "https://nodejs.org/dist/$($node.version)/node-$($node.version)-win-$arch.zip" -OutFile $nodeZip -UseBasicParsing
  Expand-Archive $nodeZip -DestinationPath (Join-Path $work 'node') -Force
  Ok "Node.js $($node.version)"

  # ------------------------------------------------------- stop old copy --

  $service = Get-Service -Name GamePanel -ErrorAction SilentlyContinue
  if ($service -and $service.Status -ne 'Stopped') {
    Step 'Stopping the running panel (game servers in containers keep running)'
    Stop-Service GamePanel -Force
    (Get-Service GamePanel).WaitForStatus('Stopped', '00:01:00')
  }

  # -------------------------------------------------------------- files --

  Step "Installing into $InstallDir"
  foreach ($rel in $AppPaths) {
    $from = Join-Path $src.FullName $rel
    $to = Join-Path $InstallDir $rel
    if (-not (Test-Path $from)) { continue }
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    Copy-Item $from $to -Recurse -Force
  }
  $nodeDir = Join-Path $InstallDir 'node'
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item (Get-ChildItem (Join-Path $work 'node') -Directory | Select-Object -First 1).FullName $nodeDir

  $wrapper = Join-Path $InstallDir 'GamePanel-Service.exe'
  if (-not (Test-Path $wrapper)) { Invoke-WebRequest $WinSwUrl -OutFile $wrapper -UseBasicParsing }
  $xml = Get-Content (Join-Path $InstallDir 'windows\GamePanel-Service.xml') -Raw
  $xml = $xml -replace 'name="GP_PORT" value="\d+"', "name=`"GP_PORT`" value=`"$Port`"" -replace 'localhost:\d+', "localhost:$Port"
  Set-Content (Join-Path $InstallDir 'GamePanel-Service.xml') $xml -Encoding UTF8
  Ok 'Files in place'

  # ------------------------------------------------------------ service --

  Step 'Setting up the GamePanel service'
  if (-not (Get-Service -Name GamePanel -ErrorAction SilentlyContinue)) {
    & $wrapper install | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the GamePanel service.' }
  } else {
    & $wrapper refresh | Out-Null
  }
  Start-Service GamePanel
  Ok 'Service running (starts with Windows)'

  Step "Allowing port $Port through Windows Firewall"
  Get-NetFirewallRule -DisplayName 'GamePanel' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'GamePanel' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
  Ok 'Firewall rule added (game ports are opened per server from the panel)'

  Step 'Waiting for the panel to answer'
  $up = $false
  for ($i = 0; $i -lt 60 -and -not $up; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:$Port/api/status" -TimeoutSec 2 | Out-Null; $up = $true } catch { Start-Sleep 1 }
  }
  if (-not $up) { Warn "The panel has not answered yet. Its log is in $DataDir\logs." }

  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
  Write-Host ''
  Write-Host '  GamePanel is installed.' -ForegroundColor Green
  Write-Host "  Open http://localhost:$Port on this PC" -ForegroundColor White
  foreach ($ip in $ips) { Write-Host "  or http://${ip}:$Port from another device on your network" }
  Write-Host ''
  Write-Host '  The first visit asks you to create the administrator account.'
  Write-Host "  Uninstall: powershell -ExecutionPolicy Bypass -File `"$InstallDir\windows\uninstall.ps1`""
  Write-Host ''
  if ($up -and [Environment]::UserInteractive -and -not $env:GP_NO_BROWSER) { Start-Process "http://localhost:$Port" }
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
