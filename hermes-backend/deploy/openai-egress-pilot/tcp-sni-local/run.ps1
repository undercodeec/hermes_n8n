$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
$project = 'sni-local-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
function Invoke-Docker {
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
}
if ((docker context show).Trim() -ne 'desktop-linux' -or $LASTEXITCODE -ne 0) { throw 'Expected local desktop-linux context' }
Invoke-Docker info --format '{{.ServerVersion}}'
Write-Host "Exclusive project: $project"
try {
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" --profile test config
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" up -d upstream proxy
  foreach ($case in @('allow', 'wrong', 'absent')) {
    Invoke-Docker compose -p $project -f "$dir/compose.yaml" run --rm --no-deps client node /test/client.cjs $case
  }
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" stop upstream
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" run --rm --no-deps client node /test/client.cjs down
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" stop proxy
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" run --rm --no-deps client node /test/client.cjs proxy-absent-regression
} catch {
  & docker compose -p $project -f "$dir/compose.yaml" logs
  throw
} finally {
  Invoke-Docker compose -p $project -f "$dir/compose.yaml" --profile test down --remove-orphans
}
