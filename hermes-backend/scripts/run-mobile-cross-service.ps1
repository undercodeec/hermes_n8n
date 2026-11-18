# Reproducible, opt-in local integration only. Never use production data or SMTP.
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path (Join-Path $_ 'crmAuthRoutes.js') })]
  [string]$ProviderBackend
)

$ErrorActionPreference = 'Stop'
$variables = @(
  'DATABASE_URL', 'HERMES_G4_CROSS_POSTGRES_URL', 'HERMES_G4_CROSS_MYSQL_URL',
  'HERMES_G4_CROSS_MAILPIT_HTTP', 'HERMES_G4_CROSS_MAILPIT_SMTP_PORT',
  'HERMES_G4_CROSS_PROVIDER_BACKEND'
)
foreach ($name in $variables) {
  if ([Environment]::GetEnvironmentVariable($name, 'Process')) {
    throw "Refusing to override an existing $name; open a fresh local shell."
  }
}

$id = [Guid]::NewGuid().ToString('N')
$suffix = $id.Substring(0, 12)
$pg = "hermes-g4-cross-pg-$suffix"
$my = "hermes-g4-cross-my-$suffix"
$mail = "hermes-g4-cross-mail-$suffix"
$pgDb = "hermes_g4_cross_test_$id"
$myDb = "crm_g4_cross_test_$id"
$pgPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$myPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$containers = @()
$backend = Split-Path -Parent $PSScriptRoot

function MappedPort([string]$container, [string]$internal) {
  $mapping = docker port $container $internal
  if ($LASTEXITCODE -ne 0 -or $mapping -notmatch '^127\.0\.0\.1:(\d+)\s*$') {
    throw "Expected a loopback-only Docker port for $container."
  }
  return $Matches[1]
}

try {
  docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'A local Docker daemon is required.' }

  docker run --rm -d --name $pg -e 'POSTGRES_USER=hermes_g4_cross' -e "POSTGRES_PASSWORD=$pgPassword" -e "POSTGRES_DB=$pgDb" -p '127.0.0.1::5432' postgres:16-alpine *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostgreSQL.' }
  $containers += $pg
  docker run --rm -d --name $my -e "MARIADB_ROOT_PASSWORD=$myPassword" -e "MARIADB_DATABASE=$myDb" -p '127.0.0.1::3306' mariadb:11.4 *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable MariaDB.' }
  $containers += $my
  docker run --rm -d --name $mail -p '127.0.0.1::1025' -p '127.0.0.1::8025' axllent/mailpit:v1.28 *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable Mailpit.' }
  $containers += $mail

  $pgPort = MappedPort $pg '5432/tcp'
  $myPort = MappedPort $my '3306/tcp'
  $smtpPort = MappedPort $mail '1025/tcp'
  $httpPort = MappedPort $mail '8025/tcp'
  $ready = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    # MariaDB starts after the container; readiness failures are normal, not test errors.
    $ErrorActionPreference = 'Continue'
    docker exec $pg pg_isready -U hermes_g4_cross -d $pgDb *> $null
    $pgReady = $LASTEXITCODE -eq 0
    docker exec -e "MYSQL_PWD=$myPassword" $my mariadb -u root -N -e 'SELECT 1' *> $null
    $myReady = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($pgReady -and $myReady) { $ready = $true; break }
    Start-Sleep -Milliseconds 600
  }
  if (-not $ready) { throw 'Disposable databases did not become ready.' }

  $env:DATABASE_URL = "postgresql://hermes_g4_cross:$pgPassword@127.0.0.1:$pgPort/$pgDb"
  $env:HERMES_G4_CROSS_POSTGRES_URL = $env:DATABASE_URL
  $env:HERMES_G4_CROSS_MYSQL_URL = "mysql://root:$myPassword@127.0.0.1:$myPort/$myDb"
  $env:HERMES_G4_CROSS_MAILPIT_HTTP = "http://127.0.0.1:$httpPort"
  $env:HERMES_G4_CROSS_MAILPIT_SMTP_PORT = $smtpPort
  $env:HERMES_G4_CROSS_PROVIDER_BACKEND = (Resolve-Path $ProviderBackend).Path

  Push-Location $backend
  try {
    Write-Host 'Migrating fresh, disposable loopback databases.'
    & "$backend/node_modules/.bin/prisma.cmd" migrate deploy --schema prisma/schema.prisma *> $null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL migration failed.' }
    $sqlFile = Join-Path $ProviderBackend 'sql/20261117_crm_auth_otp.sql'
    if (-not (Test-Path $sqlFile)) { throw 'UnderCodeEC OTP migration is missing.' }
    Get-Content -Raw $sqlFile | docker exec -i -e "MYSQL_PWD=$myPassword" $my mariadb -u root $myDb *> $null
    if ($LASTEXITCODE -ne 0) { throw 'MariaDB migration failed.' }

    & "$backend/node_modules/.bin/jest.cmd" --config ./test/jest-integration.json --runInBand test/mobile-cross-service.integration-spec.ts
    if ($LASTEXITCODE -ne 0) { throw 'Isolated cross-service integration failed.' }
    Write-Host 'HTTP integration passed; no external SMTP or Meta calls.'
  } finally {
    Pop-Location
  }
} finally {
  foreach ($name in $variables) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  foreach ($container in $containers) { docker rm -f $container *> $null }
  Write-Host 'Disposable test containers removed.'
}
