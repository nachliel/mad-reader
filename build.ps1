# Build Mad Reader: tests, release exe, portable zip, and installer.
#
#   .\build.ps1              full build
#   .\build.ps1 -SkipTests   skip cargo test
#
# If target\release\mad-reader.exe is running (file locked), build elsewhere:
#   $env:CARGO_TARGET_DIR = 'target\alt'; .\build.ps1
#
# Output goes to .\dist\
#   MadReader-<ver>-setup.exe     installer (needs Inno Setup 6; skipped if missing)
#   MadReader-<ver>-portable.zip  MadReader.exe + docs
#   MadReader.exe                 the bare executable

param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path Cargo.toml -Pattern '^version\s*=\s*"(.+)"').Matches[0].Groups[1].Value
Write-Host "Mad Reader $version" -ForegroundColor Magenta

if (-not $SkipTests) {
    Write-Host "`n> cargo test" -ForegroundColor Cyan
    cargo test --quiet
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }
}

Write-Host "`n> cargo build --release" -ForegroundColor Cyan
cargo build --release
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Copy-Item (Join-Path $targetDir 'release\mad-reader.exe') (Join-Path $dist 'MadReader.exe') -Force

# Portable zip
$stage = Join-Path $dist 'portable'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $dist 'MadReader.exe'), README.md, README.he.md, LICENSE $stage
$zip = Join-Path $dist "MadReader-$version-portable.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host "portable: $zip" -ForegroundColor Green

# Installer
$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($iscc) {
    Write-Host "`n> ISCC" -ForegroundColor Cyan
    & $iscc /Q "/DAppVersion=$version" installer\MadReader.iss
    if ($LASTEXITCODE -ne 0) { throw "installer build failed" }
    Write-Host "installer: $(Join-Path $dist "MadReader-$version-setup.exe")" -ForegroundColor Green
} else {
    Write-Warning "Inno Setup 6 not found - skipping installer. Get it with: winget install JRSoftware.InnoSetup"
}

Get-ChildItem $dist -File | Format-Table Name, @{n='Size (MB)'; e={[math]::Round($_.Length / 1MB, 2)}} -AutoSize
