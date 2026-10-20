# Signs in to Apple for free-account signing. Asks for the Apple ID here; iosc then asks
# for the password and the 2FA code itself. Only the email is saved, so later
# sign/install runs know which account to use.
Set-ExecutionPolicy Bypass -Scope Process -Force
$appleId = (Read-Host 'Apple ID email').Trim()
if (-not $appleId) { throw 'No Apple ID entered.' }
& (Join-Path $PSScriptRoot 'iosc.ps1') auth login $appleId
if ($LASTEXITCODE -eq 0) {
    Set-Content -Path 'C:\iosc\apple-id.txt' -Value $appleId -Encoding ascii
    Write-Host ''
    Write-Host 'Signed in. Go back to Claude and say done.' -ForegroundColor Green
}
