<#
  CI check for an installed GamePanel: the service runs, the panel answers,
  first-run setup and sign-in work, and the templates load.
#>
param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'

$svc = Get-Service GamePanel -ErrorAction SilentlyContinue
if (-not $svc) { throw 'The GamePanel service is not registered' }
Write-Host "Service: $($svc.Status), start type $($svc.StartType)"

$base = "http://127.0.0.1:$Port"
$status = $null
for ($i = 0; $i -lt 90 -and -not $status; $i++) {
  try { $status = Invoke-RestMethod "$base/api/status" -TimeoutSec 2 } catch { Start-Sleep 1 }
}
if (-not $status) {
  Get-ChildItem "$env:ProgramData\GamePanel\logs" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "--- $($_.Name)"; Get-Content $_.FullName -Tail 40 }
  throw "The panel did not answer on $base"
}
Write-Host "Panel $($status.version) answers on $base"

$headers = @{ Origin = $base }
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$body = @{ username = 'ci'; password = 'ci-test-password-123' } | ConvertTo-Json
if ($status.setupRequired) { Invoke-RestMethod "$base/api/setup" -Method Post -Body $body -ContentType 'application/json' -Headers $headers -WebSession $session | Out-Null }
Invoke-RestMethod "$base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -Headers $headers -WebSession $session | Out-Null
$templates = Invoke-RestMethod "$base/api/templates" -WebSession $session -Headers $headers
$system = Invoke-RestMethod "$base/api/system" -WebSession $session -Headers $headers
Write-Host "Signed in. $($templates.templates.Count) games, platform $($system.platform), data in $($system.dataDir)"
if ($templates.templates.Count -lt 20) { throw 'Too few templates loaded' }
if ($system.dataDir -notlike "$env:ProgramData*") { throw "Service data should live in ProgramData, not $($system.dataDir)" }
$page = Invoke-WebRequest "$base/" -UseBasicParsing
if ($page.Content -notmatch 'main.js') { throw 'The dashboard page did not load' }
Write-Host 'Install looks good'
