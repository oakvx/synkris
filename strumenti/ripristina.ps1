param([string]$Backup)
. (Join-Path $PSScriptRoot 'common.ps1')
$mutex=$null; $servicesStopped=$false; $restoreAttempted=$false; $flagCreated=$false; $remote=$null; $resume=@()
try {
    Assert-Docker
    $mutex=Enter-SynkMaintenance
    if ([string]::IsNullOrWhiteSpace($Backup)) { $Backup=Read-Host 'Percorso del backup .dump da ripristinare (SOLO PC DI PROVA)' }
    $Backup=(Resolve-Path -LiteralPath $Backup).Path
    if ((Get-Item -LiteralPath $Backup).Length -lt 1 -or [IO.Path]::GetExtension($Backup) -ine '.dump') { throw 'Seleziona un backup PostgreSQL .dump valido.' }
    if ((Read-Host 'Il ripristino sostituisce il database. Digita RIPRISTINA') -cne 'RIPRISTINA') { throw 'Ripristino annullato.' }
    $flag=Join-Path $script:SynkRoot 'runtime/config/calendar-reconciliation-required.flag'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $flag) | Out-Null
    if (-not (Test-Path -LiteralPath $flag)) { Write-Utf8File $flag 'restore_reconcile_required'; $flagCreated=$true }
    $resume=@(Get-RunningWorkers)
    Invoke-Compose -Arguments @('stop','bot','dashboard','backup','bootstrap') | Out-Null
    $servicesStopped=$true
    $safety=New-DatabaseBackup
    Write-Host ('Backup di sicurezza prima del restore: ' + $safety)
    $remote='/tmp/synk-restore-' + [Guid]::NewGuid().ToString('N') + '.dump'
    Invoke-Compose -Arguments @('cp',$Backup,('postgres:' + $remote)) | Out-Null
    # Maintenance is persistent BEFORE pg_restore --list and any database write.
    Invoke-Compose -Arguments @('exec','-T','postgres','pg_restore','--list',$remote) | Out-Null
    $restoreAttempted=$true
    Invoke-Compose -Arguments @('exec','-T','postgres','sh','-c',('pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB" ' + $remote)) | Out-Null
    # Restored jobs are stale relative to Google. Never replay them automatically.
    $sql="UPDATE public.calendar_outbox SET status='attention',lease_until=NULL,lease_token=NULL,last_error='restore_reconcile_required' WHERE status='pending'; UPDATE public.calendar_booking_sagas SET status='needs_attention',locked_until=NULL,last_error='restore_reconcile_required' WHERE status='pending'; DELETE FROM public.calendar_sync_cursors;"
    Invoke-Compose -Arguments @('exec','-T','postgres','sh','-c',('psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "' + $sql + '"')) | Out-Null
    Write-Warning 'Restore completato ma prenotazioni e sincronizzazione restano SOSPESE. Servizi applicativi lasciati fermi.'
    Write-Host 'Confronta manualmente database e Google. Vedi RELEASE.md e RIATTIVA_CALENDAR_TECNICO.bat. Non ripetere job vecchi senza verifica.'
} catch {
    if ($servicesStopped -and -not $restoreAttempted) {
        if ($flagCreated) { Remove-Item -LiteralPath $flag -Force; $flagCreated=$false }
        if ($resume.Count -gt 0) { try { Invoke-Compose -Arguments (@('up','-d') + $resume) | Out-Null } catch { Write-Warning 'Riavvio precedente non riuscito.' } }
    } elseif ($restoreAttempted) {
        Write-Warning 'Restore tentato: NON riavvio i servizi. Stato database da verificare dal tecnico; flag di sospensione conservato.'
    } elseif ($flagCreated) { Remove-Item -LiteralPath $flag -Force }
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($remote) { try { Invoke-Compose -Arguments @('exec','-T','postgres','rm','-f',$remote) | Out-Null } catch { Write-Warning 'File restore temporaneo da rimuovere nel container.' } }
    Exit-SynkMaintenance $mutex
}
