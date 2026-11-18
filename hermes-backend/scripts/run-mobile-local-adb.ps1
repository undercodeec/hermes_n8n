# Opt-in Windows runner. ONLY disposable local databases, synthetic mail and two controllers.
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath (Join-Path $_ 'crmAuthRoutes.js') -PathType Leaf })]
  [string]$ProviderBackend,
  [Parameter(Mandatory = $true)]
  [ValidateSet('YES-SYNTHETIC-LOCAL-ONLY')]
  [string]$ConfirmLocalSynthetic,
  [ValidateRange(0, 120)]
  [int]$RehearsalSeconds = 0
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
$provider = (Resolve-Path -LiteralPath $ProviderBackend).Path
$sql = Join-Path $provider 'sql/20261117_crm_auth_otp.sql'
$router = Join-Path $provider 'crmAuthRoutes.js'
if (-not (Test-Path -LiteralPath $sql -PathType Leaf)) { throw 'UnderCodeEC OTP migration is missing.' }
# Earlier provider routers ignore operatorEmail and would send OTP to the real operator.
if ((Get-Content -Raw -LiteralPath $router) -notmatch 'operatorEmail\s*=\s*CRM_OPERATOR_EMAIL') {
  throw 'Provider router does not support the synthetic operatorEmail override.'
}
foreach ($file in @('prisma.cmd', 'ts-node.cmd')) {
  if (-not (Test-Path -LiteralPath (Join-Path $backend "node_modules/.bin/$file") -PathType Leaf)) {
    throw 'Run npm ci and npx prisma generate in this Hermes worktree first.'
  }
}
foreach ($file in @('express', 'mysql2', 'nodemailer')) {
  if (-not (Test-Path -LiteralPath (Join-Path $provider "node_modules/$file") -PathType Container)) {
    throw 'Install the dependencies in the chosen local UnderCodeEC backend first.'
  }
}
$vars = @('DATABASE_URL', 'HERMES_LOCAL_ADB_MYSQL_URL', 'HERMES_LOCAL_ADB_SMTP_PORT',
  'HERMES_LOCAL_ADB_REHEARSAL_SECONDS',
  'HERMES_LOCAL_ADB_PROVIDER_BACKEND')
foreach ($key in ($vars + @('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'NODE_OPTIONS'))) {
  if ([Environment]::GetEnvironmentVariable($key, 'Process')) { throw "Refusing an existing $key; use a fresh shell." }
}

# These four fixed ports must not be in use; bind failure in Node/Docker remains authoritative.
foreach ($port in @(18081, 18082, 18083, 18084)) {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
  try { $listener.Start() } catch { throw "Loopback port $port is already occupied." }
  finally { $listener.Stop() }
}
$id = [Guid]::NewGuid().ToString('N')
$pg = "hermes-adb-pg-$($id.Substring(0, 12))"
$my = "hermes-adb-my-$($id.Substring(0, 12))"
$mail = "hermes-adb-mail-$($id.Substring(0, 12))"
$pgDb = "hermes_local_adb_$id"
$myDb = "crm_local_adb_$id"
$pgPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$myPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$started = @()
$stage = 'preflight'

function DockerSafe([string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  $output = @(& docker @arguments 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "Local Docker operation failed during $script:stage." }
  return $output
}
function MappedPort([string]$container, [string]$internal) {
  $mapping = @(DockerSafe @('port', $container, $internal))
  if ($mapping.Count -ne 1 -or $mapping[0] -notmatch '^127\.0\.0\.1:(\d+)$') {
    throw 'Docker published a non-loopback port; refusing to continue.'
  }
  return $Matches[1]
}
function LocalImage([string]$reference) {
  # Docker Desktop may list a locally cached tag yet fail to inspect the tag.
  # Resolve its ID from the local image table, inspect that ID and never pull.
  $matches = @(DockerSafe @('image', 'ls', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}') |
    Where-Object { $_.StartsWith("$reference ") })
  if ($matches.Count -ne 1) { throw 'A required local image is missing or ambiguous; no pull attempted.' }
  $id = $matches[0].Substring($reference.Length + 1)
  if ($id -notmatch '^[0-9a-f]{12,64}$') { throw 'Invalid local image ID.' }
  DockerSafe @('image', 'inspect', $id, '--format', '{{.Id}}') | Out-Null
  return $id
}

try {
  $context = @(DockerSafe @('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'))
  if ($context.Count -ne 1 -or $context[0] -notmatch '^npipe:////\./pipe/') {
    throw "Only a local Windows Docker named-pipe context is allowed (entries: $($context.Count))."
  }
  DockerSafe @('info', '--format', '{{.ServerVersion}}') | Out-Null
  $stage = 'checking preloaded local images'
  $pgImage = LocalImage 'postgres:16-alpine'
  $myImage = LocalImage 'mariadb:11.4'
  $mailImage = LocalImage 'axllent/mailpit:v1.28'
  $stage = 'starting disposable containers'
  $started += $pg
  DockerSafe @('run', '--pull=never', '--rm', '-d', '--name', $pg,
    '-e', 'POSTGRES_USER=local_adb', '-e', "POSTGRES_PASSWORD=$pgPassword", '-e', "POSTGRES_DB=$pgDb",
    '-p', '127.0.0.1::5432', $pgImage) | Out-Null
  $started += $my
  DockerSafe @('run', '--pull=never', '--rm', '-d', '--name', $my,
    '-e', "MARIADB_ROOT_PASSWORD=$myPassword", '-e', "MARIADB_DATABASE=$myDb",
    '-p', '127.0.0.1::3306', $myImage) | Out-Null
  $started += $mail
  DockerSafe @('run', '--pull=never', '--rm', '-d', '--name', $mail,
    '-p', '127.0.0.1:18084:1025', '-p', '127.0.0.1:18083:8025', $mailImage) | Out-Null

  $pgPort = MappedPort $pg '5432/tcp'
  $myPort = MappedPort $my '3306/tcp'
  if ((MappedPort $mail '1025/tcp') -ne '18084' -or (MappedPort $mail '8025/tcp') -ne '18083') {
    throw 'Unexpected Mailpit port mapping.'
  }
  $stage = 'waiting for local databases'
  $ready = $false
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $ErrorActionPreference = 'Continue'
    & docker exec $pg pg_isready -U local_adb -d $pgDb *> $null
    $pgReady = $LASTEXITCODE -eq 0
    & docker exec -e "MYSQL_PWD=$myPassword" $my mariadb -u root -N -e 'SELECT 1' *> $null
    $myReady = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($pgReady -and $myReady) { $ready = $true; break }
    Start-Sleep -Milliseconds 600
  }
  if (-not $ready) { throw 'Disposable databases did not become ready.' }

  $env:DATABASE_URL = "postgresql://local_adb:$pgPassword@127.0.0.1:$pgPort/$pgDb"
  $env:HERMES_LOCAL_ADB_MYSQL_URL = "mysql://root:$myPassword@127.0.0.1:$myPort/$myDb"
  $env:HERMES_LOCAL_ADB_SMTP_PORT = '18084'
  $env:HERMES_LOCAL_ADB_REHEARSAL_SECONDS = [string]$RehearsalSeconds
  $env:HERMES_LOCAL_ADB_PROVIDER_BACKEND = $provider
  $stage = 'migrating disposable databases'
  Push-Location $backend
  try {
    $ErrorActionPreference = 'Continue'
    & (Join-Path $backend 'node_modules/.bin/prisma.cmd') migrate deploy --schema prisma/schema.prisma *> $null
    $migrationStatus = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($migrationStatus -ne 0) { throw 'Prisma migration failed on the disposable database.' }
    DockerSafe @('cp', $sql, "${my}:/tmp/otp.sql") | Out-Null
    DockerSafe @('exec', '-e', "MYSQL_PWD=$myPassword", $my, 'mariadb', '-u', 'root', $myDb,
      '-e', 'source /tmp/otp.sql') | Out-Null
    $stage = 'serving synthetic APIs'
    Write-Host 'Synthetic local QA starting. Mailpit: http://127.0.0.1:18083 (SMTP loopback only).'
    & (Join-Path $backend 'node_modules/.bin/ts-node.cmd') --transpile-only scripts/mobile-local-adb.ts
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic API runner stopped with an error.' }
  } finally { Pop-Location }
} finally {
  foreach ($key in $vars) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
  $ErrorActionPreference = 'Continue'
  foreach ($container in $started) { & docker rm -f $container *> $null }
  $remaining = @()
  foreach ($container in $started) {
    & docker container inspect $container *> $null
    if ($LASTEXITCODE -eq 0) { $remaining += $container }
  }
  if ($remaining.Count) { throw 'Container cleanup incomplete; inspect the named QA containers manually.' }
  Write-Host 'Disposable containers removed.'
  $global:LASTEXITCODE = 0
}
