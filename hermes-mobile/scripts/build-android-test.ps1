# Local-only, standalone release APK. No EAS account, cloud upload, phone install or production endpoint.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedMobileCommit,
  [ValidateSet('demo', 'staging')][string]$Variant = 'demo',
  [string]$CrmAuthUrl,
  [string]$HermesApiUrl,
  [switch]$ConfirmIsolatedTestEndpoints
)

$ErrorActionPreference = 'Stop'
$mobile = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repository = (Resolve-Path (Join-Path $mobile '..')).Path
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$envNames = @('EXPO_NO_DOTENV', 'HERMES_MOBILE_BUILD_VARIANT', 'HERMES_MOBILE_ISOLATED_TEST_CONFIRMED',
  'EXPO_PUBLIC_MOBILE_AUTH_MODE', 'EXPO_PUBLIC_MOBILE_INBOX_MODE', 'EXPO_PUBLIC_CRM_AUTH_BASE_URL',
  'EXPO_PUBLIC_HERMES_API_BASE_URL', 'HERMES_APK_KEY_PASSWORD', 'HERMES_TEST_KEYSTORE', 'ANDROID_HOME', 'ANDROID_SDK_ROOT')
$envNames += @(Get-ChildItem Env:EXPO_PUBLIC_* -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
$envNames = @($envNames | Select-Object -Unique)
$original = @{}
foreach ($name in $envNames) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

function Invoke-Checked([string]$label, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)." }
}

try {
  Push-Location $repository
  try {
    $head = (git rev-parse HEAD).Trim()
    Invoke-Checked 'Expected commit check' { git merge-base --is-ancestor $ExpectedMobileCommit HEAD }
    $commit = (git rev-parse $ExpectedMobileCommit).Trim()
    if ($commit -ne '960fe806d44627bd3f9425a2680fc09a1214d6a8') {
      throw 'The 24h mobile safety commit must be passed as ExpectedMobileCommit.'
    }
    if ((git status --porcelain -- hermes-mobile).Length -gt 0) {
      throw 'Commit mobile source changes before building so the APK has reproducible provenance.'
    }
  } finally { Pop-Location }

  if (!(Test-Path (Join-Path $sdk 'platforms')) -or !(Test-Path (Join-Path $sdk 'build-tools'))) {
    throw 'Android SDK platforms and build-tools are required locally.'
  }
  if ($Variant -eq 'staging') {
    if (!$ConfirmIsolatedTestEndpoints -or !$CrmAuthUrl -or !$HermesApiUrl) {
      throw 'Staging requires both explicit HTTPS URLs and ConfirmIsolatedTestEndpoints; no production URLs.'
    }
  } elseif ($CrmAuthUrl -or $HermesApiUrl -or $ConfirmIsolatedTestEndpoints) {
    throw 'Demo builds cannot accept staging endpoints.'
  }

  # Expo inlines all EXPO_PUBLIC_* variables. Ignore .env files and remove inherited public vars.
  foreach ($name in $envNames) { if ($name -like 'EXPO_PUBLIC_*') { [Environment]::SetEnvironmentVariable($name, $null, 'Process') } }
  $env:EXPO_NO_DOTENV = '1'
  $env:HERMES_MOBILE_BUILD_VARIANT = $Variant
  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk
  if ($Variant -eq 'staging') {
    $env:HERMES_MOBILE_ISOLATED_TEST_CONFIRMED = 'yes'
    $env:EXPO_PUBLIC_MOBILE_AUTH_MODE = 'staging'
    $env:EXPO_PUBLIC_CRM_AUTH_BASE_URL = $CrmAuthUrl
    $env:EXPO_PUBLIC_HERMES_API_BASE_URL = $HermesApiUrl
    # Read-only Inbox is intentionally not enabled: this APK is an auth + synthetic demo test.
  }

  Push-Location $mobile
  try {
    Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }
    Invoke-Checked 'checks' { npm run check }
    # Expo rewrites package.json development commands during prebuild; do not let
    # generated commands become an uncommitted source change.
    $packageFile = Join-Path $mobile 'package.json'
    $packageBeforePrebuild = [IO.File]::ReadAllBytes($packageFile)
    try { Invoke-Checked 'Expo prebuild' { npx --no-install expo prebuild --platform android --no-install --clean } }
    finally { [IO.File]::WriteAllBytes($packageFile, $packageBeforePrebuild) }

    $gradle = Join-Path $mobile 'android\app\build.gradle'
    $source = [IO.File]::ReadAllText($gradle)
    $signingBlock = '(?s)(signingConfigs \{\s*debug \{.*?\r?\n\s*\})(\s*\})'
    if ([regex]::Matches($source, $signingBlock).Count -ne 1) { throw 'Unexpected Expo signing config: refusing debug-signed release.' }
    $source = [regex]::Replace($source, $signingBlock, {
      param($match)
      $match.Groups[1].Value + "`n        testRelease {`n            storeFile file(System.getenv('HERMES_TEST_KEYSTORE'))`n            storePassword System.getenv('HERMES_APK_KEY_PASSWORD')`n            keyAlias 'hermeslocaltest'`n            keyPassword System.getenv('HERMES_APK_KEY_PASSWORD')`n        }" + $match.Groups[2].Value
    })
    $releaseSigning = '(?s)(release \{\s*// Caution!.*?\r?\n\s*// see .*?\r?\n\s*)signingConfig signingConfigs\.debug'
    if ([regex]::Matches($source, $releaseSigning).Count -ne 1) { throw 'Unexpected Expo release signing config: refusing build.' }
    $source = [regex]::Replace($source, $releaseSigning, '${1}signingConfig signingConfigs.testRelease')
    [IO.File]::WriteAllText($gradle, $source)

    $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    if (!(Test-Path $keytool)) { throw 'JDK 21 with keytool and JAVA_HOME are required.' }
    $signingDir = Join-Path $env:LOCALAPPDATA 'Temp\opencode\hermes-mobile-signing'
    [IO.Directory]::CreateDirectory($signingDir) | Out-Null
    $env:HERMES_TEST_KEYSTORE = Join-Path $signingDir ("$Variant-$head-" + [guid]::NewGuid().ToString('N') + '.jks')
    $env:HERMES_APK_KEY_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    Invoke-Checked 'temporary test key' {
      & $keytool -genkeypair -keystore $env:HERMES_TEST_KEYSTORE -alias hermeslocaltest -keyalg RSA -keysize 3072 -validity 30 -dname 'CN=Hermes CRM Local Test, O=Hermes, C=EC' -storepass:env HERMES_APK_KEY_PASSWORD -keypass:env HERMES_APK_KEY_PASSWORD -noprompt
    }
    Push-Location (Join-Path $mobile 'android')
    try { Invoke-Checked 'Gradle release APK' { .\gradlew.bat :app:assembleRelease --no-daemon } }
    finally { Pop-Location }

    $apk = Join-Path $mobile 'android\app\build\outputs\apk\release\app-release.apk'
    if (!(Test-Path $apk)) { throw 'Gradle did not create a release APK.' }
    $signer = Join-Path $sdk 'build-tools\36.0.0\apksigner.bat'
    if (!(Test-Path $signer)) { throw 'apksigner 36.0.0 is required for verification.' }
    Invoke-Checked 'APK signature verification' { & $signer verify --verbose $apk }
    $artifact = Join-Path $mobile ("artifacts\hermes-crm-$Variant-local-test-$($head.Substring(0,12)).apk")
    [IO.Directory]::CreateDirectory((Split-Path $artifact)) | Out-Null
    Copy-Item $apk $artifact -ErrorAction Stop
    $hash = (Get-FileHash $artifact -Algorithm SHA256).Hash
    Write-Host "APK (local only): $artifact"
    Write-Host "Source HEAD: $head; includes 24h commit: $commit; variant: $Variant"
    Write-Host "SHA256: $hash"
    Write-Host 'Temporary test key only: NOT a distribution/release signing identity. Do not install or share without authorization.'
  } finally { Pop-Location }
} finally {
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
}
