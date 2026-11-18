# Run exactly one PostgreSQL opt-in suite on a fresh disposable Docker database.
param([Parameter(Mandatory = $true)][ValidateSet('session', 'inbox', 'reply')][string]$Suite)

$ErrorActionPreference = 'Stop'
$cases = @{
  session = @{ user = 'hermes_g2_test'; db = 'hermes_g2_test_'; variable = 'HERMES_G2_TEST_DATABASE_URL'; file = 'test/mobile-session-postgres.integration-spec.ts' }
  inbox = @{ user = 'hermes_g4_inbox_test'; db = 'hermes_g4_inbox_test_'; variable = 'HERMES_G4_INBOX_TEST_DATABASE_URL'; file = 'test/mobile-inbox-postgres.integration-spec.ts' }
  reply = @{ user = 'hermes_mobile_reply_test'; db = 'hermes_mobile_reply_test_'; variable = 'HERMES_MOBILE_REPLY_TEST_DATABASE_URL'; file = 'test/mobile-reply-postgres.integration-spec.ts' }
}
$case = $cases[$Suite]
if ($env:DATABASE_URL -or [Environment]::GetEnvironmentVariable($case.variable, 'Process')) {
  throw 'Existing database variables detected; use a fresh local shell.'
}
$hex = [Guid]::NewGuid().ToString('N')
$name = "hermes-mobile-$Suite-$($hex.Substring(0, 12))"
$database = $case.db + $hex
$password = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$backend = Split-Path -Parent $PSScriptRoot
$started = $false
try {
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Local Docker is required.' }
  docker run --rm -d --name $name -e "POSTGRES_USER=$($case.user)" -e "POSTGRES_PASSWORD=$password" -e "POSTGRES_DB=$database" -p '127.0.0.1::5432' postgres:16-alpine *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL start failed.' }
  $started = $true
  $mapping = docker port $name '5432/tcp'
  if ($LASTEXITCODE -ne 0 -or $mapping -notmatch '^127\.0\.0\.1:(\d+)\s*$') { throw 'Loopback port missing.' }
  $port = $Matches[1]
  $ready = $false
  for ($i = 0; $i -lt 70; $i++) {
    $ErrorActionPreference = 'Continue'
    docker exec $name pg_isready -U $case.user -d $database *> $null
    $pgReady = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($pgReady) { $ready = $true; break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $ready) { throw 'Disposable database did not become ready.' }
  $env:DATABASE_URL = "postgresql://$($case.user):$password@127.0.0.1:$port/$database"
  [Environment]::SetEnvironmentVariable($case.variable, $env:DATABASE_URL, 'Process')
  Push-Location $backend
  try {
    & "$backend/node_modules/.bin/prisma.cmd" migrate deploy --schema prisma/schema.prisma *> $null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL migration failed.' }
    & "$backend/node_modules/.bin/jest.cmd" --config ./test/jest-integration.json --runInBand $case.file
    if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL suite failed.' }
    Write-Host "Isolated $Suite suite passed."
  } finally { Pop-Location }
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable($case.variable, $null, 'Process')
  if ($started) { docker rm -f $name *> $null }
  Write-Host 'Disposable PostgreSQL removed.'
}
