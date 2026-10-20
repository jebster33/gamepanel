# Runs iosc (through windows-apple-dev) with the settings this project needs:
#   - the SDK in a short folder, so Xcode's deep paths stay under Windows' 260-character limit
#   - TLS verification on: iosc skips it by default. Apple's sign-in server chains to
#     Apple's own root, which Python doesn't trust unless it is given that root.
#
#   .\ios\iosc.ps1 auth login you@example.com --anisette https://ani.sidestore.io
#   .\ios\iosc.ps1 --project ios\GamePanel build
#   .\ios\iosc.ps1 --project ios\GamePanel sign --apple-id you@example.com
#   .\ios\iosc.ps1 --project ios\GamePanel install
$external = if ($env:IOSC_EXTERNAL) { $env:IOSC_EXTERNAL } else { 'C:\iosc' }
$root = Join-Path $external 'apple_certs\AppleRootCA.pem'
if (-not (Test-Path $root)) { throw "Missing $root. See ios/README.md, Install on your iPhone." }

$env:IOSC_EXTERNAL = $external
$env:IOSC_VERIFY_SSL = '1'
$env:SSL_CERT_FILE = $root

python (Join-Path $HOME '.claude\skills\windows-apple-dev\scripts\dispatch.py') swift @args
exit $LASTEXITCODE
