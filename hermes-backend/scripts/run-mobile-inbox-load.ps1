# Opt-in synthetic benchmark only. Requires local Docker and installed backend deps.
$ErrorActionPreference = 'Stop'
if ($env:DATABASE_URL -or $env:HERMES_G4_LOAD_TEST_DATABASE_URL) {
  throw 'Refusing to override existing database variables; use a fresh local shell.'
}
$hex = [Guid]::NewGuid().ToString('N')
$name = "hermes-g4-load-$($hex.Substring(0, 12))"
$database = "hermes_g4_load_test_$hex"
$password = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$backend = Split-Path -Parent $PSScriptRoot
$started = $false
try {
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'A local Docker daemon is required.' }
  docker run --rm -d --name $name -e 'POSTGRES_USER=hermes_g4_load_test' -e "POSTGRES_PASSWORD=$password" -e "POSTGRES_DB=$database" -p '127.0.0.1::5432' postgres:16-alpine *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostgreSQL.' }
  $started = $true
  $mapping = docker port $name '5432/tcp'
  if ($LASTEXITCODE -ne 0 -or $mapping -notmatch '^127\.0\.0\.1:(\d+)\s*$') {
    throw 'Expected a loopback-only Docker port.'
  }
  $port = $Matches[1]
  $ready = $false
  for ($attempt = 0; $attempt -lt 70; $attempt++) {
    $ErrorActionPreference = 'Continue'
    docker exec $name pg_isready -U hermes_g4_load_test -d $database *> $null
    $pgReady = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($pgReady) { $ready = $true; break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }

  $env:DATABASE_URL = "postgresql://hermes_g4_load_test:$password@127.0.0.1:$port/$database"
  $env:HERMES_G4_LOAD_TEST_DATABASE_URL = $env:DATABASE_URL
  Push-Location $backend
  try {
    & "$backend/node_modules/.bin/prisma.cmd" migrate deploy --schema prisma/schema.prisma *> $null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL migration failed.' }
    Write-Host 'Measuring a synthetic Inbox fixture on disposable loopback PostgreSQL.'
    & "$backend/node_modules/.bin/ts-node.cmd" --transpile-only scripts/mobile-inbox-load.ts
    if ($LASTEXITCODE -ne 0) { throw 'Isolated Inbox load check failed.' }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:DATABASE_URL,Env:HERMES_G4_LOAD_TEST_DATABASE_URL -ErrorAction SilentlyContinue
  if ($started) { docker rm -f $name *> $null }
  Write-Host 'Disposable load database removed.'
}
