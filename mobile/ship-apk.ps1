# Ship a built APK into mobile\dist + final Distro, deleting older anime app builds.
# Usage:
#   .\ship-apk.ps1
#   .\ship-apk.ps1 -ApkPath "android\app\build\outputs\apk\debug\app-debug.apk"
#   .\ship-apk.ps1 -Version "1.5.2"

[CmdletBinding()]
param(
  [string]$ApkPath = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$mobileRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $mobileRoot
$distDir = Join-Path $mobileRoot "dist"
$pkgPath = Join-Path $mobileRoot "package.json"

if (-not $Version) {
  if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    $Version = [string]$pkg.version
  }
}
if (-not $Version) { throw "Could not determine version (pass -Version or set package.json)." }

if (-not $ApkPath) {
  $candidates = @(
    (Join-Path $mobileRoot "android\app\build\outputs\apk\debug\app-debug.apk"),
    (Join-Path $mobileRoot "android\app\build\outputs\apk\release\app-release.apk")
  )
  $ApkPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ApkPath -or -not (Test-Path -LiteralPath $ApkPath)) {
  throw "APK not found. Build first or pass -ApkPath."
}

function Test-IsAnimeAppName([string]$name) {
  $n = $name.ToLowerInvariant()
  return (
    $n -like '*ggz anime*' -or
    $n -like '*grey godzilla anime*' -or
    $n -like '*greygodzilla anime*' -or
    $n -like '*anime release tracker*' -or
    ($n -like '*anime tracker*' -and $n -notlike '*pc*')
  )
}

function Remove-OldAnimeBuilds([string]$dir, [string[]]$KeepFullPaths = @()) {
  if (-not (Test-Path -LiteralPath $dir)) { return @() }
  $keepSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($k in $KeepFullPaths) {
    if ($k) {
      try { [void]$keepSet.Add([System.IO.Path]::GetFullPath($k)) } catch { }
    }
  }
  $removed = @()
  Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '_dl*' } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      $removed += $_.Name
    }
  Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -match '^\.(apk|exe)$' -and (Test-IsAnimeAppName $_.Name) } |
    ForEach-Object {
      $full = $_.FullName
      if ($keepSet.Contains($full)) { return }
      Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
      $removed += $_.Name
    }
  return $removed
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$canonicalName = "GGZ Anime v$Version-android.apk"
$shortName = "GGZ Anime v$Version.apk"
$destApk = Join-Path $distDir $canonicalName
$shortApk = Join-Path $distDir $shortName

# Stage source first so cleanup never deletes the file we are shipping.
$ApkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$stage = Join-Path $env:TEMP ("ggz-anime-ship-" + [guid]::NewGuid().ToString("n") + ".apk")
Copy-Item -LiteralPath $ApkPath -Destination $stage -Force

Write-Host "Cleaning older anime builds from mobile\dist..."
$r1 = Remove-OldAnimeBuilds $distDir
if ($r1.Count) { Write-Host ("  removed: " + ($r1 -join ', ')) }

Copy-Item -LiteralPath $stage -Destination $destApk -Force
# Keep one short alias next to the canonical name (same version only).
Copy-Item -LiteralPath $destApk -Destination $shortApk -Force
Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
Write-Host "Wrote: $destApk"

$final = "C:\Scripts\Releases\final Distro"
$copyBat = "C:\Scripts\Releases\Copy-To-FinalDistro.bat"
if (Test-Path $copyBat) {
  Write-Host "Shipping via Copy-To-FinalDistro.bat (also purges older final Distro copies)..."
  & $copyBat $destApk
  if ($LASTEXITCODE -ne 0) { throw "Copy-To-FinalDistro failed ($LASTEXITCODE)" }
} else {
  New-Item -ItemType Directory -Force -Path $final | Out-Null
  Write-Host "Cleaning older anime builds from final Distro..."
  $r2 = Remove-OldAnimeBuilds $final
  if ($r2.Count) { Write-Host ("  removed: " + ($r2 -join ', ')) }
  Copy-Item -LiteralPath $destApk -Destination (Join-Path $final $canonicalName) -Force
  Write-Host "Shipped to: $final\$canonicalName"
}

Write-Host ""
Write-Host "READY: $canonicalName"
Write-Host "  mobile\dist : $destApk"
Write-Host "  final Distro: $final\$canonicalName"
