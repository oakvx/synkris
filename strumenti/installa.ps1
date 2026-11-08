param([switch]$Reconfigure, [switch]$Menu)
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'configurazione.ps1')
. (Join-Path $PSScriptRoot 'credenziali.ps1')
. (Join-Path $PSScriptRoot 'ambiente.ps1')
. (Join-Path $PSScriptRoot 'preflight.ps1')
. (Join-Path $PSScriptRoot 'accesso.ps1')
. (Join-Path $PSScriptRoot 'avvio.ps1')
. (Join-Path $PSScriptRoot 'avvio-automatico.ps1')
. (Join-Path $PSScriptRoot 'supporto.ps1')
. (Join-Path $PSScriptRoot 'menu.ps1')
$mutex = $null
try {
    if ($Menu) {
        switch (Select-SynkTool) {
            'exit' { exit 0 }
            'start' { Start-SynkServices; exit 0 }
            'doctor' { & (Join-Path $PSScriptRoot 'diagnostica.ps1'); exit $LASTEXITCODE }
            'access' { Show-SynkAccess; exit 0 }
            'support' { Export-SynkSupportReport | Out-Null; exit 0 }
            'autostart-on' {
                Write-Host 'Vale solo per questo utente, DOPO il login Windows. Non accende il PC e non sostituisce il collaudo.'
                if ((Read-SynkText 'Conferma ATTIVA / ANNULLA' 'ANNULLA' '^(ATTIVA|ANNULLA)$') -ceq 'ATTIVA') {
                    Set-SynkAutostart -Enabled $true
                } else { Write-Host 'Nessun avvio automatico configurato.' }
                exit 0
            }
            'autostart-off' { Set-SynkAutostart -Enabled $false; exit 0 }
            'reconfigure' { $Reconfigure = $true }
        }
    }
    Write-Host 'synk - installazione guidata locale. Ctrl+C annulla; i file gia salvati restano disponibili.'
    Write-Host '[1/6] Verifica Docker Desktop e motore Linux...'
    Wait-SynkDocker -StartDesktop
    $mutex = Enter-SynkMaintenance
    Assert-SynkProjectOwnership
    $maintenance = Join-Path $script:SynkRoot 'runtime/config/calendar-reconciliation-required.flag'
    if (Test-Path -LiteralPath $maintenance) { throw 'Ripristino o aggiornamento da riconciliare: non avvio servizi o migrazioni. Usa la procedura tecnica Calendar.' }
    foreach ($dir in @('secrets','setup','runtime/config','runtime/session','runtime/backups')) { New-Item -ItemType Directory -Force -Path (Join-Path $script:SynkRoot $dir) | Out-Null }
    foreach ($dir in @('secrets','runtime','setup')) { Protect-LocalPath (Join-Path $script:SynkRoot $dir) -Directory }
    $databaseExists = Test-SynkDatabaseVolume
    Write-Host '[2/6] Team, trattamenti e orari (nessuna modifica manuale del JSON)...'
    Initialize-SynkSalonConfiguration -Reconfigure:$Reconfigure
    Write-Host '[3/6] Importazione dei file privati...'
    Initialize-SynkCredentials
    Write-Host '[4/6] Credenziali locali e calendario...'
    $environment = Initialize-SynkEnvironment -DatabaseExists:$databaseExists
    Invoke-Compose -Arguments @('config','--quiet') | Out-Null
    Write-Host '[5/6] Preparazione immagini. Il primo avvio richiede Internet e puo durare diversi minuti...'
    Invoke-Compose -Arguments @('pull','postgres','backup')
    Invoke-Compose -Arguments @('build','bootstrap','bot','dashboard')
    $report = Get-SynkOfflineDoctor
    Show-SynkDoctorReport $report
    if (-not $report.readyForBootstrap) { throw 'Preflight incompleto: nessuna migrazione database o associazione WhatsApp avviata. Correggi i punti indicati e rilancia.' }
    Write-Host '[6/6] Avvio servizi e attesa dashboard...'
    Invoke-Compose -Arguments @('up','-d','--no-build','--pull','never')
    Wait-SynkHealth
    Write-Host 'Dashboard raggiungibile: non equivale a WhatsApp associato o al collaudo Calendar.'
    Write-Host 'La password dashboard e nel tuo file privato .env; non condividerlo nei log.'
    Write-Host 'Collega WhatsApp dalla dashboard e completa COLLAUDO.md prima dei clienti reali.'
    Start-Process 'http://127.0.0.1:8080/'
    try { Show-SynkAccess } catch { Write-Warning 'Finestra credenziali non disponibile. La password resta nel file privato .env; usa lo strumento Accesso dal launcher Windows.' }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Exit-SynkMaintenance $mutex }
