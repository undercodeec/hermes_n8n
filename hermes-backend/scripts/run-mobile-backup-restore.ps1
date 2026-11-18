# Local-only G2 OTP MariaDB + G2/G4 Prisma PostgreSQL restore rehearsal.
# No production endpoints, existing databases, persistent volumes or host dump files.
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$UnderCodeSqlPath
)

$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
$prisma = Join-Path $backend 'node_modules/.bin/prisma.cmd'
$sqlPath = (Resolve-Path -LiteralPath $UnderCodeSqlPath).Path
if (-not (Test-Path -LiteralPath $prisma -PathType Leaf)) { throw 'Install backend dependencies with npm ci first.' }
if ((Split-Path -Leaf $sqlPath) -ne '20261117_crm_auth_otp.sql') { throw 'Expected the UnderCodeEC G2 OTP migration SQL file.' }
foreach ($key in @('DATABASE_URL', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY')) {
  if ([Environment]::GetEnvironmentVariable($key, 'Process')) { throw "Refusing an existing $key; use a fresh local shell." }
}

$id = [Guid]::NewGuid().ToString('N')
$pg = "hermes-restore-pg-$($id.Substring(0, 12))"
$my = "hermes-restore-my-$($id.Substring(0, 12))"
$pgSource = "hermes_mobile_source_$id"
$pgRestored = "hermes_mobile_restored_$id"
$mySource = "crm_otp_source_$id"
$myRestored = "crm_otp_restored_$id"
$pgPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$myPassword = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$started = @()
$stage = 'initialization'

function RunDocker([string[]]$arguments) {
  $ErrorActionPreference = 'Continue'
  $result = @(& docker @arguments 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "Disposable Docker operation failed during $script:stage." }
  return $result
}

function PgQuery([string]$database, [string]$sql) {
  return @(RunDocker @('exec', $pg, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'mobile_restore', '-d', $database, '-At', '-c', $sql))
}

function MyQuery([string]$database, [string]$sql) {
  return @(RunDocker @('exec', '-e', "MYSQL_PWD=$myPassword", $my, 'mariadb', '-u', 'root', '--batch', '--skip-column-names', $database, '-e', $sql))
}

function AssertSame([string]$label, [string[]]$before, [string[]]$after) {
  if ($before.Count -eq 0 -or (($before -join "`n") -cne ($after -join "`n"))) {
    throw "${label}: missing or different after restore."
  }
  Write-Host "$label verified ($($before.Count) entries)."
}

function PgStructure([string]$database) {
  $queries = @(
    "SELECT table_name || '|' || column_name || '|' || data_type || '|' || udt_name || '|' || is_nullable || '|' || coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
    "SELECT tablename || '|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
    "SELECT c.conrelid::regclass::text || '|' || c.conname || '|' || pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.conrelid::regclass::text,c.conname",
    "SELECT t.typname || '|' || e.enumsortorder || '|' || e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder"
  )
  foreach ($query in $queries) { PgQuery $database $query }
}

function PgCounts([string]$database) {
  $tables = @(PgQuery $database "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  if ($tables.Count -lt 3 -or @($tables | Where-Object { $_ -in @('mobile_sessions', 'consumed_crm_proofs', 'mobile_reply_operations') }).Count -ne 3) {
    throw 'G2/G4 PostgreSQL migration tables missing.'
  }
  foreach ($table in $tables) {
    if ($table -cnotmatch '^[a-zA-Z_][a-zA-Z_0-9]*$') { throw 'Unexpected table name.' }
    $count = @(PgQuery $database "SELECT count(*) FROM public.$table")[0]
    "$table=$count"
  }
}

function MyStructure([string]$database) {
  $queries = @(
    "SELECT CONCAT(table_name,'|',column_name,'|',column_type,'|',is_nullable,'|',IFNULL(column_default,''),'|',extra) FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position",
    "SELECT CONCAT(table_name,'|',index_name,'|',seq_in_index,'|',column_name,'|',non_unique) FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index",
    "SELECT CONCAT(table_name,'|',constraint_name,'|',constraint_type) FROM information_schema.table_constraints WHERE table_schema=DATABASE() ORDER BY table_name,constraint_name",
    "SELECT CONCAT(trigger_name,'|',event_manipulation,'|',action_timing,'|',action_statement) FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name",
    "SELECT CONCAT(routine_name,'|',routine_type,'|',routine_definition) FROM information_schema.routines WHERE routine_schema=DATABASE() ORDER BY routine_name",
    "SELECT CONCAT(event_name,'|',event_definition) FROM information_schema.events WHERE event_schema=DATABASE() ORDER BY event_name"
  )
  foreach ($query in $queries) { MyQuery $database $query }
}

function MyCounts([string]$database) {
  $tables = @(MyQuery $database "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY table_name")
  if ($tables.Count -lt 2 -or $tables -cnotcontains 'restore_fixture') { throw 'G2 OTP migration tables missing.' }
  foreach ($table in $tables) {
    if ($table -cnotmatch '^[a-zA-Z_][a-zA-Z_0-9]*$') { throw 'Unexpected table name.' }
    $count = @(MyQuery $database "SELECT count(*) FROM $table")[0]
    "$table=$count"
  }
}

try {
  $context = @(& docker context inspect --format '{{.Endpoints.docker.Host}}' 2>$null)
  if ($LASTEXITCODE -ne 0 -or $context.Count -ne 1 -or $context[0] -notmatch '^npipe:////\./pipe/') {
    throw 'A local Windows Docker named-pipe context is required; remote Docker is forbidden.'
  }
  RunDocker @('info', '--format', '{{.ServerVersion}}') | Out-Null
  $stage = 'starting isolated databases'
  $started += $pg
  RunDocker @('run', '--rm', '-d', '--name', $pg, '-e', 'POSTGRES_USER=mobile_restore', '-e', "POSTGRES_PASSWORD=$pgPassword", '-e', "POSTGRES_DB=$pgSource", '-p', '127.0.0.1::5432', 'postgres:16-alpine') | Out-Null
  $started += $my
  RunDocker @('run', '--rm', '-d', '--name', $my, '-e', "MARIADB_ROOT_PASSWORD=$myPassword", '-e', "MARIADB_DATABASE=$mySource", '-p', '127.0.0.1::3306', 'mariadb:11.4') | Out-Null
  foreach ($mapping in @(@($pg,'5432/tcp'), @($my,'3306/tcp'))) {
    $port = @(RunDocker @('port', $mapping[0], $mapping[1]))
    if ($port.Count -ne 1 -or $port[0] -notmatch '^127\.0\.0\.1:\d+$') { throw 'Port is not bound exclusively to loopback.' }
  }
  $ready = $false
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    $ErrorActionPreference = 'Continue'
    & docker exec $pg pg_isready -U mobile_restore -d $pgSource *> $null
    $pgReady = $LASTEXITCODE -eq 0
    & docker exec -e "MYSQL_PWD=$myPassword" $my mariadb -u root -N -e 'SELECT 1' *> $null
    $myReady = $LASTEXITCODE -eq 0
    $ErrorActionPreference = 'Stop'
    if ($pgReady -and $myReady) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Disposable database readiness timed out.' }

  $stage = 'applying Prisma migrations'
  $port = @(RunDocker @('port', $pg, '5432/tcp'))[0] -replace '^127\.0\.0\.1:', ''
  $env:DATABASE_URL = "postgresql://mobile_restore:$pgPassword@127.0.0.1:$port/$pgSource"
  Push-Location $backend
  try {
    $ErrorActionPreference = 'Continue'
    & $prisma migrate deploy --schema prisma/schema.prisma *> $null
    $prismaStatus = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($prismaStatus -ne 0) { throw 'Prisma migration of disposable database failed.' }
  } finally {
    Pop-Location
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  }
  $stage = 'inserting synthetic PostgreSQL rows'
  RunDocker @('cp', (Join-Path $PSScriptRoot 'fixtures/mobile-restore-postgres.sql'), "${pg}:/tmp/fixture.sql") | Out-Null
  RunDocker @('exec', $pg, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'mobile_restore', '-d', $pgSource, '-f', '/tmp/fixture.sql') | Out-Null

  $stage = 'applying UnderCodeEC OTP migration'
  RunDocker @('cp', $sqlPath, "${my}:/tmp/otp.sql") | Out-Null
  MyQuery $mySource 'source /tmp/otp.sql' | Out-Null
  MyQuery $mySource "INSERT INTO crm_auth_otp (email,code_hash,expires_at,requested_at,attempts) VALUES ('synthetic@example.invalid',REPEAT('a',64),1,1,0); INSERT INTO crm_auth_limits (limit_key,window_start,attempts,lock_until) VALUES (REPEAT('b',64),1,0,0)" | Out-Null
  MyQuery $mySource "CREATE TABLE restore_fixture (id INT PRIMARY KEY, marker VARCHAR(32) NOT NULL); INSERT INTO restore_fixture VALUES (1,'synthetic-only')" | Out-Null
  $otpTables = @(MyQuery $mySource "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE '%otp%' ORDER BY table_name")
  if ($otpTables.Count -eq 0) { throw 'OTP migration did not create an OTP table.' }

  $stage = 'capturing source structure and counts'
  $pgBefore = @(PgStructure $pgSource)
  $pgRows = @(PgCounts $pgSource)
  $myBefore = @(MyStructure $mySource)
  $myRows = @(MyCounts $mySource)
  foreach ($fixture in @('mobile_sessions=1','consumed_crm_proofs=1','mobile_reply_operations=1')) {
    if ($pgRows -cnotcontains $fixture) { throw 'Synthetic G2/G4 fixture missing.' }
  }
  foreach ($fixture in @('crm_auth_otp=1','crm_auth_limits=1','restore_fixture=1')) {
    if ($myRows -cnotcontains $fixture) { throw 'Synthetic OTP fixture missing.' }
  }

  # Dumps remain ONLY in disposable containers. Never dump existing or production databases.
  $stage = 'dumping synthetic databases'
  RunDocker @('exec', $pg, 'pg_dump', '-U', 'mobile_restore', '-Fc', '-f', '/tmp/backup.dump', $pgSource) | Out-Null
  $catalog = @(RunDocker @('exec', $pg, 'pg_restore', '-l', '/tmp/backup.dump'))
  if ($catalog.Count -lt 10) { throw 'PostgreSQL archive catalog is incomplete.' }
  RunDocker @('exec', '-e', "MYSQL_PWD=$myPassword", $my, 'mariadb-dump', '-u', 'root', '--single-transaction', '--routines', '--triggers', '--events', "--result-file=/tmp/backup.sql", $mySource) | Out-Null
  $stage = 'restoring into new databases'
  PgQuery $pgSource "CREATE DATABASE $pgRestored" | Out-Null
  MyQuery $mySource "CREATE DATABASE $myRestored" | Out-Null
  RunDocker @('exec', $pg, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'mobile_restore', '-d', $pgRestored, '/tmp/backup.dump') | Out-Null
  MyQuery $myRestored 'source /tmp/backup.sql' | Out-Null

  $stage = 'comparing restored structures and counts'
  AssertSame 'PostgreSQL schema (columns, indexes, constraints, enums)' $pgBefore @(PgStructure $pgRestored)
  AssertSame 'PostgreSQL all-table row counts' $pgRows @(PgCounts $pgRestored)
  AssertSame 'MariaDB schema (columns, indexes, constraints, triggers)' $myBefore @(MyStructure $myRestored)
  AssertSame 'MariaDB all-table row counts' $myRows @(MyCounts $myRestored)
  Write-Host 'PASS: synthetic G2 OTP MariaDB and G2/G4 Prisma PostgreSQL backup/restore.'
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  $ErrorActionPreference = 'Continue'
  foreach ($container in $started) { & docker rm -f $container *> $null }
  $remaining = @()
  foreach ($container in $started) {
    & docker container inspect $container *> $null
    if ($LASTEXITCODE -eq 0) { $remaining += $container }
  }
  if ($remaining.Count -gt 0) { throw 'Disposable container cleanup incomplete; inspect the named rehearsal containers manually.' }
  Write-Host 'Disposable containers and their in-container dumps removed and verified (verify manually if interrupted forcibly).'
  # Inspect intentionally returns 1 for a removed container. Do not report that
  # expected cleanup result as a failed rehearsal to the invoking shell.
  $global:LASTEXITCODE = 0
}
