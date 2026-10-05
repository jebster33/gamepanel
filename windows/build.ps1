<#
  Builds the Windows downloads into .\dist:

    GamePanel-Setup-<version>.exe          installer (service, firewall rule, Start menu entry)
    GamePanel-<version>-windows-x64.zip    portable copy: unzip, run start.cmd

    powershell -ExecutionPolicy Bypass -File windows\build.ps1

  Both bundle a private Node.js, so the target PC needs nothing installed.
  Setup.exe needs Inno Setup 6 on the build machine (installed if missing).
#>
param([string]$OutDir = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Root = Split-Path $PSScriptRoot -Parent
$Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
$NodeMajor = 22
$WinSwUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
$Stage = Join-Path $OutDir 'stage\GamePanel'

Write-Host "==> Building GamePanel $Version for Windows"
if (Test-Path (Join-Path $OutDir 'stage')) { Remove-Item (Join-Path $OutDir 'stage') -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

foreach ($rel in 'server', 'public', 'templates', 'windows', 'package.json', 'README.md', 'LICENSE') {
  Copy-Item (Join-Path $Root $rel) (Join-Path $Stage $rel) -Recurse -Force
}
Remove-Item (Join-Path $Stage 'windows\build.ps1'), (Join-Path $Stage 'windows\setup.iss') -ErrorAction SilentlyContinue

# Icon: an .ico can hold a PNG directly (Windows Vista and newer read it).
$png = [IO.File]::ReadAllBytes((Join-Path $Root 'public\img\logo-192.png'))
$ico = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)          # header: icon, 1 image
$w.Write([byte]192); $w.Write([byte]192); $w.Write([byte]0); $w.Write([byte]0)
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png); $w.Flush()
[IO.File]::WriteAllBytes((Join-Path $Stage 'windows\gamepanel.ico'), $ico.ToArray())

Write-Host "==> Bundling Node.js $NodeMajor"
# Store the list first: piping Invoke-RestMethod straight on passes the whole array as one object.
$index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
$node = $index | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
if (-not $node) { throw "Could not find a Node.js $NodeMajor build for win-x64." }
$nodeZip = Join-Path $OutDir "node-$($node.version).zip"
if (-not (Test-Path $nodeZip)) { Invoke-WebRequest "https://nodejs.org/dist/$($node.version)/node-$($node.version)-win-x64.zip" -OutFile $nodeZip -UseBasicParsing }
$nodeTmp = Join-Path $OutDir 'stage\node'
Expand-Archive $nodeZip -DestinationPath $nodeTmp -Force
Move-Item (Get-ChildItem $nodeTmp -Directory | Select-Object -First 1).FullName (Join-Path $Stage 'node')
Remove-Item $nodeTmp -Recurse -Force
# npm and its docs are not needed to run the panel.
Remove-Item (Join-Path $Stage 'node\node_modules'), (Join-Path $Stage 'node\npm*'), (Join-Path $Stage 'node\npx*'), (Join-Path $Stage 'node\corepack*') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '==> Adding the service wrapper'
Invoke-WebRequest $WinSwUrl -OutFile (Join-Path $Stage 'GamePanel-Service.exe') -UseBasicParsing
Copy-Item (Join-Path $Root 'windows\GamePanel-Service.xml') (Join-Path $Stage 'GamePanel-Service.xml')

Set-Content (Join-Path $Stage 'start.cmd') -Encoding ASCII -Value @'
@echo off
rem Portable GamePanel: runs in this window, keeps its data in .\data.
rem Install Setup.exe instead to run it as a service that starts with Windows.
cd /d "%~dp0"
echo GamePanel is starting. Open http://localhost:8080 in your browser. Close this window to stop it.
"%~dp0node\node.exe" "%~dp0server\index.js"
pause
'@

Write-Host '==> Portable zip'
$zip = Join-Path $OutDir "GamePanel-$Version-windows-x64.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $Stage -DestinationPath $zip -CompressionLevel Optimal

Write-Host '==> Setup.exe'
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  choco install innosetup -y --no-progress | Out-Null
  $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
}
& $iscc /Q "/DAppVersion=$Version" "/DSourceDir=$Stage" "/DOutputDir=$OutDir" (Join-Path $PSScriptRoot 'setup.iss')
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed ($LASTEXITCODE)" }

Get-ChildItem $OutDir -File -Filter 'GamePanel*' | ForEach-Object { Write-Host (" {0,-44} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)) }
