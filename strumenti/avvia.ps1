param([switch]$NoBrowser, [switch]$Quiet)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'preflight.ps1')
. (Join-Path $PSScriptRoot 'avvio.ps1')
try {
    if ($Quiet) { Start-SynkServices -NoBrowser:$NoBrowser 6>$null }
    else { Start-SynkServices -NoBrowser:$NoBrowser }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
