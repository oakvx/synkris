param()
. (Join-Path $PSScriptRoot 'common.ps1')
$mutex=$null
try {
    Assert-Docker
    $mutex=Enter-SynkMaintenance
    $flag=Join-Path $script:SynkRoot 'runtime/config/calendar-reconciliation-required.flag'
    if (-not (Test-Path -LiteralPath $flag -PathType Leaf)) { throw 'Nessuna sospensione Calendar da rimuovere.' }
    Write-Warning 'Richiesta verifica UMANA di eventi orfani, mancanti, orari, conflitti, outbox e saghe stale. Nessun job viene riattivato da questo script.'
    Write-Host 'Se il database e sano puoi avviare AVVIA_SYNK per consultazione: il flag blocca i worker Calendar e le prenotazioni.'
    if ((Read-Host 'Solo dopo confronto reale con Google digita CALENDAR VERIFICATO') -cne 'CALENDAR VERIFICATO') { throw 'Sospensione mantenuta.' }
    Invoke-Compose -Arguments @('up','-d')
    Wait-SynkHealth
    Invoke-Compose -Arguments @('exec','-T','postgres','sh','-c','psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM public.calendar_sync_cursors;"') | Out-Null
    # Remove only after services and DB are ready, with the explicit human sign-off.
    Remove-Item -LiteralPath $flag -Force
    Write-Host 'Sospensione rimossa. Attendi una nuova sincronizzazione entrante e controlla il Centro operativo.'
    Write-Warning 'I job attention restano da esaminare. Non significa che tutti i conflitti siano risolti.'
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
finally { Exit-SynkMaintenance $mutex }
