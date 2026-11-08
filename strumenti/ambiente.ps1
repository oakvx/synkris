# Library: common.ps1 and configurazione.ps1 must already be loaded.
function Initialize-SynkEnvironment {
    param([switch]$DatabaseExists)
    $file = Join-Path $script:SynkRoot '.env'
    $created = -not (Test-Path -LiteralPath $file -PathType Leaf)
    if ($created) {
        if ($DatabaseExists) { throw 'Esiste gia un volume database ma manca .env: recupera le credenziali precedenti dal backup. Non genero una nuova password database.' }
        $template = [IO.File]::ReadAllText((Join-Path $script:SynkRoot '.env.example'))
        Write-SynkPrivateFile $file $template
    }
    Protect-LocalPath $file
    $dashboardGenerated = $false
    foreach ($key in @('POSTGRES_PASSWORD','ADMIN_TOKEN','DASHBOARD_PASSWORD')) {
        $value = Get-EnvValue $key
        $placeholder = [string]::IsNullOrWhiteSpace($value) -or $value -match '^SOSTITUISCI'
        if ($placeholder) {
            if ($key -eq 'POSTGRES_PASSWORD' -and $DatabaseExists) { throw 'Password database assente o dimostrativa con volume gia presente: ripristina quella originale, non ruotarla automaticamente.' }
            $bytes = if ($key -eq 'DASHBOARD_PASSWORD') { 16 } else { 32 }
            Set-EnvValue $key (Get-RandomHex $bytes)
            if ($key -eq 'DASHBOARD_PASSWORD') { $dashboardGenerated = $true }
        }
        $value = Get-EnvValue $key
        $minimum = if ($key -eq 'DASHBOARD_PASSWORD') { 12 } else { 32 }
        if ($value.Length -lt $minimum -or $value.Length -gt 512 -or $value -match '[\x00-\x20\x7f]' -or ($key -eq 'POSTGRES_PASSWORD' -and $value -notmatch '^[A-Za-z0-9_-]+$')) { throw ('Valore privato non valido: ' + $key + '. Il valore esistente non viene sostituito; richiedi assistenza.') }
    }
    $calendar = Get-EnvValue 'CALENDAR_ID'
    if ([string]::IsNullOrWhiteSpace($calendar) -or $calendar -match '^calendario-del-salone@') {
        $calendar = Read-SynkText 'ID calendario Google (non il titolo; Impostazioni > Integra calendario)' '' '^(?!calendario-del-salone@)(?=.{1,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$'
        Set-EnvValue 'CALENDAR_ID' $calendar
    }
    $hwid = Get-EnvValue 'APP_HWID'
    if ([string]::IsNullOrWhiteSpace($hwid) -or $hwid -match '^HWID_ASSOCIATO') {
        $hwid = Read-SynkText 'HWID fornito con la tua licenza (non inventarne uno)' '' '^(?!HWID_ASSOCIATO)[A-Za-z0-9_-]{3,160}$'
        Set-EnvValue 'APP_HWID' $hwid
    }
    Write-Host 'Credenziali salvate nel file privato .env. Nessuna password viene stampata.'
    Write-Host 'I valori reali gia presenti sono mantenuti; il rilancio riprende la configurazione.'
    return [pscustomobject]@{Created=$created;DashboardPasswordGenerated=$dashboardGenerated}
}
