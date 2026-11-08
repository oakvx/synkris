param([switch]$Json)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'preflight.ps1')
try {
    $state = Get-SynkDockerState
    if ($state -ne 'ready') {
        if ($Json) { [pscustomobject]@{schema=1;scope='windows';readyForBootstrap=$false;productionReady=$false;docker=$state} | ConvertTo-Json }
        else { Write-Host ('Docker: ' + $state); Write-Host 'Apri Docker Desktop in modalita Linux locale. Usa INSTALLA_UNA_VOLTA per completare il percorso.' }
        exit 1
    }
    $report = Get-SynkOfflineDoctor
    if ($Json) { $report | ConvertTo-Json -Depth 8 } else { Show-SynkDoctorReport $report }
    if (-not $report.readyForBootstrap) { exit 1 }
} catch {
    if ($Json) { [pscustomobject]@{schema=1;scope='windows';readyForBootstrap=$false;productionReady=$false;error='doctor_unavailable'} | ConvertTo-Json }
    else { Write-Host 'Diagnostica non disponibile: completa configurazione e costruzione delle immagini con INSTALLA_UNA_VOLTA. Nessun log riservato viene raccolto.' }
    exit 1
}
