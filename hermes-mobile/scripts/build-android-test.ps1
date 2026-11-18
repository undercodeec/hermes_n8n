# Local-only, standalone release APK. No EAS account, cloud upload, phone install or live API requests.
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedMobileCommit,
  [ValidateSet('demo', 'staging', 'read-only-public')][string]$Variant = 'demo',
  [string]$CrmAuthUrl,
  [string]$HermesApiUrl,
  [switch]$ConfirmIsolatedTestEndpoints,
  [switch]$ConfirmPublicReadOnlyNoInstall
)

$ErrorActionPreference = 'Stop'
$mobile = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repository = (Resolve-Path (Join-Path $mobile '..')).Path
if ($mobile.Length -gt 65) {
  throw 'Windows Ninja/CMake requires a short physical worktree path (e.g. D:\m-g3-apk-qa); subst drives resolve to the original long path.'
}
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$envNames = @('EXPO_NO_DOTENV', 'HERMES_MOBILE_BUILD_VARIANT', 'HERMES_MOBILE_ISOLATED_TEST_CONFIRMED',
  'HERMES_MOBILE_PUBLIC_READ_ONLY_CONFIRMED',
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
    if ($commit -ne 'a2e9b5b3ba7e4dec4015a10b29830856757c2f14') {
      throw 'The latest mobile safety commit (24h and late-response protection) must be passed as ExpectedMobileCommit.'
    }
    if ((git status --porcelain -- hermes-mobile).Length -gt 0) {
      throw 'Commit mobile source changes before building so the APK has reproducible provenance.'
    }
  } finally { Pop-Location }

  if (!(Test-Path (Join-Path $sdk 'platforms')) -or !(Test-Path (Join-Path $sdk 'build-tools'))) {
    throw 'Android SDK platforms and build-tools are required locally.'
  }
  if ($Variant -eq 'staging') {
    if (!$ConfirmIsolatedTestEndpoints -or $ConfirmPublicReadOnlyNoInstall -or !$CrmAuthUrl -or !$HermesApiUrl) {
      throw 'Staging requires both explicit HTTPS URLs and ConfirmIsolatedTestEndpoints; no production URLs.'
    }
  } elseif ($Variant -eq 'read-only-public') {
    if (!$ConfirmPublicReadOnlyNoInstall -or $ConfirmIsolatedTestEndpoints -or
        $CrmAuthUrl -cne 'https://admincrm.undercodeec.com' -or $HermesApiUrl -cne 'https://api.undercodeec.com') {
      throw 'Read-only public API build requires exact HTTPS CRM/Hermes origins and ConfirmPublicReadOnlyNoInstall; NEVER install while idleRemainingMs is absent.'
    }
  } elseif ($CrmAuthUrl -or $HermesApiUrl -or $ConfirmIsolatedTestEndpoints -or $ConfirmPublicReadOnlyNoInstall) {
    throw 'Demo builds cannot accept integration endpoints.'
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
    # This variant only authenticates and then shows synthetic demo data.
  } elseif ($Variant -eq 'read-only-public') {
    $env:HERMES_MOBILE_PUBLIC_READ_ONLY_CONFIRMED = 'yes'
    $env:EXPO_PUBLIC_MOBILE_AUTH_MODE = 'staging'
    $env:EXPO_PUBLIC_MOBILE_INBOX_MODE = 'read-only'
    $env:EXPO_PUBLIC_CRM_AUTH_BASE_URL = $CrmAuthUrl
    $env:EXPO_PUBLIC_HERMES_API_BASE_URL = $HermesApiUrl
  }

  Push-Location $mobile
  try {
    Invoke-Checked 'npm ci' { npm ci --no-audit --no-fund }
    Invoke-Checked 'checks' { npm run check }
    # Only the read-only variant selects its own Metro entrypoint. Keep the
    # modified package main until Gradle finishes bundling; restore on any exit.
    $packageFile = Join-Path $mobile 'package.json'
    $packageBeforeBuild = [IO.File]::ReadAllBytes($packageFile)
    if ($Variant -eq 'read-only-public') {
      $packageText = [IO.File]::ReadAllText($packageFile)
      if ([regex]::Matches($packageText, '"main": "index\.ts"').Count -ne 1) { throw 'Unexpected Expo entrypoint; refusing mixed demo/read-only bundle.' }
      [IO.File]::WriteAllText($packageFile, $packageText.Replace('"main": "index.ts"', '"main": "index.readonly.ts"'))
    }
    try {
    # Expo rewrites package.json development commands during prebuild; do not let
    # generated commands become an uncommitted source change.
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
    $random = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($random) } finally { $generator.Dispose() }
    $env:HERMES_APK_KEY_PASSWORD = [BitConverter]::ToString($random).Replace('-', '')
    Invoke-Checked 'temporary test key' {
      & $keytool -genkeypair -keystore $env:HERMES_TEST_KEYSTORE -alias hermeslocaltest -keyalg RSA -keysize 3072 -validity 30 -dname 'CN=Hermes CRM Local Test, O=Hermes, C=EC' -storepass:env HERMES_APK_KEY_PASSWORD -keypass:env HERMES_APK_KEY_PASSWORD -noprompt
    }
    Push-Location (Join-Path $mobile 'android')
    try { Invoke-Checked 'Gradle release APK' { .\gradlew.bat :app:assembleRelease --no-daemon } }
    finally { Pop-Location }

    $apk = Join-Path $mobile 'android\app\build\outputs\apk\release\app-release.apk'
    if (!(Test-Path $apk)) { throw 'Gradle did not create a release APK.' }
    if ($Variant -eq 'read-only-public') {
      $bundle = Join-Path $mobile 'android\app\build\generated\assets\react\release\index.android.bundle'
      if (!(Test-Path $bundle)) { throw 'Missing read-only Metro bundle.' }
      $js = [IO.File]::ReadAllText($bundle)
      if (!$js.Contains('/api/mobile/inbox') -or !$js.Contains('https://api.undercodeec.com') -or
          !$js.Contains('https://admincrm.undercodeec.com') -or
          $js.Contains('agente@example.invalid') -or $js.Contains('Respuesta de prueba') -or
          $js.Contains('DATOS FICTICIOS')) {
        throw 'Read-only bundle missing expected API/Inbox code or includes the demo composer. Refusing APK.'
      }
      $aapt = Join-Path $sdk 'build-tools\36.0.0\aapt.exe'
      if (!(Test-Path $aapt)) { throw 'aapt 36.0.0 is required for read-only APK manifest validation.' }
      $manifest = (& $aapt dump badging $apk) -join "`n"
      if ($LASTEXITCODE -ne 0 -or $manifest -match "uses-permission: name='android\.permission\.(SYSTEM_ALERT_WINDOW|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_MEDIA_IMAGES|VIBRATE)'") {
        throw 'Read-only APK still requests an unnecessary overlay/storage/vibration permission.'
      }
    }
    $signer = Join-Path $sdk 'build-tools\36.0.0\apksigner.bat'
    if (!(Test-Path $signer)) { throw 'apksigner 36.0.0 is required for verification.' }
    Invoke-Checked 'APK signature verification' { & $signer verify --verbose $apk }
    $artifact = Join-Path $mobile ("artifacts\hermes-crm-$Variant-local-test-$($head.Substring(0,12)).apk")
    [IO.Directory]::CreateDirectory((Split-Path $artifact)) | Out-Null
    Copy-Item $apk $artifact -ErrorAction Stop
    $hash = (Get-FileHash $artifact -Algorithm SHA256).Hash
    Write-Host "APK (local only): $artifact"
    Write-Host "Source HEAD: $head; includes latest mobile safety commit: $commit; variant: $Variant"
    Write-Host "SHA256: $hash"
    Write-Host 'Temporary test key only: NOT a distribution/release signing identity. Do not install or share without authorization.'
    if ($Variant -eq 'read-only-public') { Write-Host 'Public API is NOT idleRemainingMs-compatible: do not install or launch this APK until backend release and QA authorization are verified.' }
    } finally { [IO.File]::WriteAllBytes($packageFile, $packageBeforeBuild) }
  } finally { Pop-Location }
} finally {
  foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process') }
}
