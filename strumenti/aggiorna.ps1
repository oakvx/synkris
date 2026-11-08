param([string]$Package, [string]$ExpectedSha256)
. (Join-Path $PSScriptRoot 'common.ps1')
$mutex=$null; $staging=$null; $rollback=$null; $servicesStopped=$false; $codeChanged=$false; $migrationAttempted=$false; $resume=@()
try {
    Assert-Docker
    $mutex=Enter-SynkMaintenance
    if ([string]::IsNullOrWhiteSpace($Package)) { $Package=Read-Host 'Percorso dello ZIP ufficiale piatto' }
    $Package=(Resolve-Path -LiteralPath $Package).Path
    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) { $ExpectedSha256=Read-Host 'SHA256 pubblicato dal canale ufficiale (64 caratteri)' }
    if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash -ine $ExpectedSha256) { throw 'SHA256 non corrispondente: nessuna modifica effettuata.' }
    $updates=Join-Path $script:SynkRoot 'runtime/updates'
    New-Item -ItemType Directory -Force -Path $updates | Out-Null
    $id=[Guid]::NewGuid().ToString('N')
    $staging=Join-Path $updates ('staging-' + $id)
    New-Item -ItemType Directory -Path $staging | Out-Null
    $manifest=Expand-SynkRelease $Package $staging
    $new=$staging
    if (-not (Test-Path -LiteralPath (Join-Path $new 'src/index.js') -PathType Leaf)) { throw 'Lo ZIP deve essere piatto e contenere src/index.js.' }
    if ((Get-Content -LiteralPath (Join-Path $new 'package.json') -Raw | ConvertFrom-Json).version -ne $manifest.version) { throw 'Versione package/manifest diversa.' }
    Write-Warning ('Installazione prerelease ' + $manifest.version + ': solo collaudo, non produzione.')
    if ((Read-Host 'Digita AGGIORNA per continuare') -cne 'AGGIORNA') { throw 'Operazione annullata.' }
    $resume=@(Get-RunningWorkers)
    Invoke-Compose -Arguments @('stop','bot','dashboard','backup','bootstrap') | Out-Null
    $servicesStopped=$true
    $backup=New-DatabaseBackup
    Write-Host ('Backup database: ' + $backup)
    $rollback=Join-Path $updates ('rollback-' + $id)
    New-Item -ItemType Directory -Path $rollback | Out-Null
    Copy-SynkCode $script:SynkRoot $rollback
    $codeChanged=$true
    Copy-SynkCode $new $script:SynkRoot -Replace
    Invoke-Compose -Arguments @('build','bot','dashboard')
    $migrationAttempted=$true
    Invoke-Compose -Arguments @('up','-d')
    # Both endpoints are required. /health is liveness, not a real WhatsApp test.
    Wait-SynkHealth -Urls @('http://127.0.0.1:3000/health','http://127.0.0.1:8080/')
    Write-Host ('Codice aggiornato a ' + $manifest.version + '. Collauda WhatsApp/Calendar. Rollback codice: ' + $rollback)
} catch {
    $failure=$_
    if ($codeChanged) {
        try {
            Invoke-Compose -Arguments @('stop','bot','dashboard','backup','bootstrap') | Out-Null
            Copy-SynkCode $rollback $script:SynkRoot -Replace
            Write-Warning 'Ripristinato il CODICE precedente. Le migrazioni DATABASE non vengono annullate.'
        } catch { Write-Warning 'Rollback del codice incompleto: mantenere i servizi fermi e chiamare il tecnico.' }
    }
    if ($migrationAttempted) {
        $flag=Join-Path $script:SynkRoot 'runtime/config/calendar-reconciliation-required.flag'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $flag) | Out-Null
        Write-Utf8File $flag 'update_failed_reconcile_required'
        Write-Warning 'Migrazione/deploy tentato: servizi lasciati fermi. Verifica database e Calendar prima di riattivare.'
    } elseif ($servicesStopped -and $resume.Count -gt 0) {
        try { Invoke-Compose -Arguments (@('up','-d') + $resume) | Out-Null } catch { Write-Warning 'Riavvio precedente non riuscito.' }
    }
    Write-Error $failure -ErrorAction Continue
    exit 1
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Exit-SynkMaintenance $mutex
}
