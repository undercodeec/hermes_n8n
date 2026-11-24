$ErrorActionPreference = 'Stop'
$project = 'hermes-egress-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$tempRoot = Join-Path $env:LOCALAPPDATA 'Temp/opencode'
if (-not (Test-Path -LiteralPath $tempRoot)) { $tempRoot = $env:TEMP }
$dir = Join-Path $tempRoot $project
$composeFile = Join-Path $PSScriptRoot 'docker-compose.test.yml'
function Invoke-Checked([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker failed ($LASTEXITCODE): $($Arguments -join ' ')" }
}
if ((docker context show).Trim() -ne 'desktop-linux' -or $LASTEXITCODE -ne 0) { throw 'Docker context must be desktop-linux' }
Invoke-Checked @('info', '--format', '{{.ServerVersion}}')
New-Item -ItemType Directory -Path $dir | Out-Null
$env:PILOT_CERT_DIR = $dir.Replace('\','/')
$openssl = if ($env:PILOT_OPENSSL) { $env:PILOT_OPENSSL } else { 'C:/Program Files/Git/usr/bin/openssl.exe' }
$env:MSYS_NO_PATHCONV = '1'
$created = $false
try {
  $ErrorActionPreference = 'Continue'
  & $openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/key.pem" -out "$dir/cert.pem" -days 1 -subj '/CN=api.openai.test' -addext 'subjectAltName=DNS:api.openai.test' 2>$null
  $opensslExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($opensslExit -ne 0) { throw 'Failed to create synthetic certificate' }
  $base = @('compose', '-p', $project, '-f', $composeFile)
  Write-Host "Disposable project: $project; reviewing resolved config"
  Invoke-Checked ($base + @('config'))
  $created = $true
  Invoke-Checked ($base + @('up', '-d', '--no-build', '--pull', 'never', 'mock', 'relay'))
  Invoke-Checked ($base + @('run', '--rm', '--no-deps', 'agent'))
  Invoke-Checked ($base + @('stop', 'mock'))
  Invoke-Checked ($base + @('run', '--rm', '--no-deps', 'agent', 'node', '/fixture/docker-fixture.mjs', 'closed'))
} finally {
  try { if ($created) { Invoke-Checked ($base + @('down', '--remove-orphans')) } }
  finally {
    Remove-Item -Recurse -Force -LiteralPath $dir
    Remove-Item Env:PILOT_CERT_DIR -ErrorAction SilentlyContinue
  }
}
