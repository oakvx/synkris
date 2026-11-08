# Library: requires common.ps1. Import is create-only; signature validation is
# performed later by the production Node verifier, before any DB migration.
function Import-SynkCredential {
    param([ValidateSet('license.txt','license-public.pem','google-service-account.json')][string]$Name, [string]$Source)
    $destination = Join-Path $script:SynkRoot ('secrets/' + $Name)
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        Write-Host ('File privato gia presente: secrets/' + $Name + ' (non sovrascritto).')
        return
    }
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
