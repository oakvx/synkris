# Library: common.ps1 and preflight.ps1 must already be loaded.
function Start-SynkServices {
    param([switch]$NoBrowser, [ValidateRange(1,600)][int]$HealthSeconds = 240)
    foreach ($file in @('.env','setup/config.json','secrets/license.txt','secrets/license-public.pem','secrets/google-service-account.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:SynkRoot $file) -PathType Leaf)) { throw 'Prima configurazione incompleta: apri INSTALLA_UNA_VOLTA. Non avvio servizi con file mancanti.' }
    }
    Wait-SynkDocker -StartDesktop
    $mutex = $null
    try {
        $mutex = Enter-SynkMaintenance
        Assert-SynkProjectOwnership
        if (Test-Path -LiteralPath (Join-Path $script:SynkRoot 'runtime/config/calendar-reconciliation-required.flag')) { throw 'Ripristino o aggiornamento da riconciliare: avvio automatico bloccato. Richiedi il controllo tecnico Calendar.' }
        Invoke-Compose -Arguments @('config','--quiet') | Out-Null
        $report = Get-SynkOfflineDoctor
        if (-not $report.readyForBootstrap) {
            Show-SynkDoctorReport $report
            throw 'Controlli installazione incompleti: usa INSTALLA_UNA_VOLTA e la diagnostica. Nessun avvio forzato.'
        }
        Write-Host 'Avvio synk con le immagini gia installate. Nessun aggiornamento o download automatico...'
        Invoke-Compose -Arguments @('up','-d','--no-build','--pull','never')
        Wait-SynkHealth -Seconds $HealthSeconds
        Write-Host 'Dashboard raggiungibile. Verifica WhatsApp, Calendar e backup nel Centro operativo.'
        if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8080/' }
    } finally { Exit-SynkMaintenance $mutex }
}
