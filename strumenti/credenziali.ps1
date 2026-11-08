# Library: requires common.ps1. Normal import remains create-only.
# Read and validate only the selected bounded file; never print its contents.
function Read-SynkCredentialText {
    param([ValidateSet('license.txt','license-public.pem','google-service-account.json')][string]$Name, [string]$Source)
    if ([string]::IsNullOrWhiteSpace($Source)) {
        Write-Host ('Serve ' + $Name + '. Trascina il file originale nella finestra, oppure incolla il suo percorso.')
        Write-Host 'NON incollare il contenuto della licenza o della chiave.'
        $Source = (Read-Host 'Percorso del file').Trim()
        if ($Source.Length -ge 2 -and (($Source.StartsWith('"') -and $Source.EndsWith('"')) -or ($Source.StartsWith("'") -and $Source.EndsWith("'")))) { $Source = $Source.Substring(1,$Source.Length - 2) }
    }
    try {
        $file = Get-Item -LiteralPath $Source -Force -ErrorAction Stop
        $maximum = if ($Name -eq 'license-public.pem') { 8192 } else { 65536 }
        if ($file.PSIsContainer -or $file.Length -lt 1 -or $file.Length -gt $maximum -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'invalid_file' }
        $text = [IO.File]::ReadAllText($file.FullName,(New-Object Text.UTF8Encoding($false,$true))).TrimStart([char]0xFEFF)
    } catch { throw ('File non leggibile o non adatto: ' + $Name + '. Usa un file locale originale, non una cartella o un collegamento.') }
    switch ($Name) {
        'license.txt' {
            $lic = [regex]::Matches($text,'(?m)^\s*LIC\s*[:=]\s*([A-Za-z0-9_-]+={0,2})\s*$')
            $sig = [regex]::Matches($text,'(?m)^\s*SIG\s*[:=]\s*([A-Za-z0-9_-]+={0,2})\s*$')
            if ($lic.Count -ne 1 -or $sig.Count -ne 1) { throw 'Il file licenza deve contenere una sola riga LIC e una sola riga SIG. Richiedi il file originale al titolare.' }
        }
        'license-public.pem' {
            if ($text.Trim() -notmatch '\A-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\z') { throw 'Serve una chiave PUBBLICA PEM, non una chiave privata o un certificato.' }
        }
        'google-service-account.json' {
            try { $google = $text | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Il JSON Google non e valido. Importa il file originale scaricato dalla console Google.' }
            if ($null -eq $google -or 'type' -notin $google.PSObject.Properties.Name -or 'client_email' -notin $google.PSObject.Properties.Name -or 'private_key' -notin $google.PSObject.Properties.Name -or $google.type -ne 'service_account' -or $google.client_email -notmatch '^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$' -or $google.private_key -isnot [string] -or $google.private_key -notmatch '^-----BEGIN (?:RSA )?PRIVATE KEY-----') { throw 'Il file deve essere il JSON di un service account Google con la sua chiave privata. Non usare un client OAuth o una chiave pubblica.' }
        }
    }
    return $text
}
function Import-SynkCredential {
    param([ValidateSet('license.txt','license-public.pem','google-service-account.json')][string]$Name, [string]$Source)
    $destination = Join-Path $script:SynkRoot ('secrets/' + $Name)
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        Write-Host ('File privato gia presente: secrets/' + $Name + ' (non sovrascritto).')
        return
    }
    $text = Read-SynkCredentialText -Name $Name -Source $Source
    Write-SynkPrivateFile $destination $text
    Write-Host ('Importato in secrets/' + $Name + '. Contenuto non mostrato; verifica completa durante il preflight.')
}
function Initialize-SynkCredentials {
    Write-Host "`nATTIVAZIONE E GOOGLE - file riservati, conservati solo sul PC."
    Write-Host 'La licenza firmata e la chiave pubblica vanno richieste al titolare, anche per uso privato gratuito.'
    foreach ($name in @('license.txt','license-public.pem','google-service-account.json')) { Import-SynkCredential -Name $name }
    Write-Host 'Condividi ogni calendario operativo con l''email del service account, autorizzandolo a gestire gli eventi.'
    Write-Host 'Il controllo offline non puo verificare la condivisione: il collaudo Calendar resta necessario.'
}

# Explicit recovery for an INITIAL setup only. No runtime file/config/DB or
# signing private key is changed. Containers must already be stopped; validation
# uses the existing isolated doctor and original production signature verifier.
function Repair-SynkInitialCredential {
    param([ValidateSet('license.txt','license-public.pem','google-service-account.json')][string]$Name, [string]$Source)
    $mutex = Enter-SynkMaintenance
    $stage = $null; $created = $false; $replaced = $false; $accepted = $false
    try {
        if (Test-Path -LiteralPath (Join-Path $script:SynkRoot 'runtime/config/.synkris-bootstrap-ok')) { throw 'Configurazione gia importata: per rinnovi o rotazioni operative serve la procedura del tecnico. Nessun file modificato.' }
        if ((Get-SynkDockerState) -ne 'ready') { throw 'Avvia Docker Desktop e riprova. Nessun file modificato.' }
        Assert-SynkProjectOwnership
        if (@(Get-RunningWorkers).Count -ne 0) { throw 'Servizi in esecuzione: questa correzione e solo per il setup iniziale fermo. Nessun file modificato.' }
        $destination = Join-Path $script:SynkRoot ('secrets/' + $Name)
        $original = Get-Item -LiteralPath $destination -Force -ErrorAction Stop
        if ($original.PSIsContainer -or ($original.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Destinazione privata non adatta alla sostituzione.' }
        # First confirm the image/checker is available, before replacing anything.
        Get-SynkOfflineDoctor | Out-Null
        Write-Host ('Sostituzione iniziale di secrets/' + $Name + '. Originale conservato in un backup privato; nessun avvio servizi.')
        if ((Read-SynkText 'Conferma SOSTITUISCI / ANNULLA' 'ANNULLA' '^(SOSTITUISCI|ANNULLA)$') -cne 'SOSTITUISCI') { Write-Host 'Annullato: nessun file modificato.'; return }
        $text = Read-SynkCredentialText -Name $Name -Source $Source
        $id = [Guid]::NewGuid().ToString('N')
        $folder = Join-Path $script:SynkRoot ('runtime/private-file-backups/' + $id)
        New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
        Protect-LocalPath $folder -Directory
        $backup = Join-Path $folder $Name
        $stage = Join-Path $script:SynkRoot ('secrets/.credential-pending-' + $id)
        Write-SynkPrivateFile $stage $text; $created = $true
        [IO.File]::Replace($stage,$destination,$backup,$false); $replaced = $true
        Protect-LocalPath $destination; Protect-LocalPath $backup
        $report = Get-SynkOfflineDoctor
        $checkId = @{'license.txt'='license';'license-public.pem'='license_key';'google-service-account.json'='google_credentials'}[$Name]
        $selected = @($report.checks | Where-Object { $_.id -eq $checkId })
        if ($selected.Count -ne 1 -or $selected[0].status -notin @('pass','warn')) { throw 'Il nuovo file non supera la verifica selezionata. Controlla origine, attivazione/HWID o tipo di credenziale.' }
        $accepted = $true
        Show-SynkDoctorReport $report
        Write-Host 'File selezionato verificato e conservato. Il backup privato e in runtime/private-file-backups/. Rilancia Installazione per gli eventuali altri punti mancanti.'
    } catch {
        if ($replaced -and -not $accepted) {
            try {
                $rejected = Join-Path $folder ('rejected-' + $Name)
                [IO.File]::Replace($backup,$destination,$rejected,$false)
                Protect-LocalPath $destination; Protect-LocalPath $rejected
                Write-Warning 'File precedente ripristinato. La copia rifiutata resta solo nel backup privato, non in uso.'
            } catch { throw 'Ripristino file privato non completato: non avviare synk. Il tecnico deve controllare runtime/private-file-backups/; nessun servizio e stato avviato.' }
        }
        throw
    } finally {
        if ($created -and $null -ne $stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Force }
        Exit-SynkMaintenance $mutex
    }
}
