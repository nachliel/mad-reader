# Refresh the bundled KaTeX and Mermaid (assets/vendor).
#
#   .\tools\update_vendor.ps1                       latest versions
#   .\tools\update_vendor.ps1 -Katex 0.19.1 -Mermaid 12.3.0
#
# Uses `npm pack` (downloads the published tarball; no install scripts run).

param([string]$Katex = 'latest', [string]$Mermaid = 'latest')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root 'assets\vendor'
$work = Join-Path ([IO.Path]::GetTempPath()) ("madreader-vendor-" + [guid]::NewGuid())
New-Item -ItemType Directory $work | Out-Null
Push-Location $work
try {
    npm pack "katex@$Katex" "mermaid@$Mermaid" --silent | Out-Null
    $kt = Get-ChildItem katex-*.tgz | Select-Object -First 1
    $mt = Get-ChildItem mermaid-*.tgz | Select-Object -First 1
    New-Item -ItemType Directory k, m | Out-Null
    tar -xzf $kt.FullName -C k
    tar -xzf $mt.FullName -C m

    Remove-Item (Join-Path $vendor 'katex'), (Join-Path $vendor 'mermaid') -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory (Join-Path $vendor 'katex\fonts'), (Join-Path $vendor 'mermaid') -Force | Out-Null
    Copy-Item k\package\dist\katex.min.js, k\package\dist\katex.min.css, k\package\LICENSE (Join-Path $vendor 'katex')
    Copy-Item k\package\dist\fonts\*.woff2 (Join-Path $vendor 'katex\fonts')
    Copy-Item m\package\dist\mermaid.min.js, m\package\LICENSE (Join-Path $vendor 'mermaid')

    Write-Host "Updated: $($kt.BaseName), $($mt.BaseName)" -ForegroundColor Green
    Write-Host "Rebuild and run: python tests\e2e.py"
} finally {
    Pop-Location
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
