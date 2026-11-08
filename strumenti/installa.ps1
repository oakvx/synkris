param()
. (Join-Path $PSScriptRoot 'common.ps1')
$mutex = $null
try {
    Assert-Docker
    $mutex = Enter-SynkMaintenance
    foreach ($dir in @('secrets','setup','runtime/config','runtime/session','runtime/backups')) { New-Item -ItemType Directory -Force -Path (Join-Path $script:SynkRoot $dir) | Out-Null }
    $config = Join-Path $script:SynkRoot 'setup/config.json'
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
        Copy-Item -LiteralPath (Join-Path $script:SynkRoot 'setup/config.example.json') -Destination $config
        throw 'Creato setup/config.json di esempio. Sostituisci i dati dimostrativi, poi rilancia INSTALLA_UNA_VOLTA.'
    }
    $json = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if (-not $json.services -or -not $json.professionals -or @($json.professionals.PSObject.Properties).Count -lt 1 -or @($json.services.PSObject.Properties).Count -lt 1) { throw 'Configura servizi e operatrici in setup/config.json.' }
    foreach ($pro in $json.professionals.PSObject.Properties) { if ($pro.Name -match '@example\.com$') { throw 'Sostituisci gli indirizzi dimostrativi in setup/config.json.' } }
    foreach ($file in @('license.txt','license-public.pem','google-service-account.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:SynkRoot ('secrets/' + $file)) -PathType Leaf)) { throw ('File privato necessario: secrets/' + $file) }
    }
    $envFile = Join-Path $script:SynkRoot '.env'
    $created = -not (Test-Path -LiteralPath $envFile)
    if ($created) {
        Copy-Item -LiteralPath (Join-Path $script:SynkRoot '.env.example') -Destination $envFile
        Set-EnvValue 'POSTGRES_PASSWORD' (Get-RandomHex)
        Set-EnvValue 'ADMIN_TOKEN' (Get-RandomHex)
        $dashboardPassword = Get-RandomHex 16
        Set-EnvValue 'DASHBOARD_PASSWORD' $dashboardPassword
        Write-Host 'Password dashboard generata e salvata nel file privato .env:'
        Write-Host $dashboardPassword
        Write-Host 'Conservala nel gestore password del salone. Non condividerla nei log.'
    }
    foreach ($key in @('CALENDAR_ID','APP_HWID')) {
        $value = Get-EnvValue $key
        if ($value -match '^(calendario-del-salone|HWID_ASSOCIATO)' -or [string]::IsNullOrWhiteSpace($value)) {
            $value = Read-Host ('Inserisci ' + $key + ' (fornito dal tecnico/licenza)')
            if ([string]::IsNullOrWhiteSpace($value)) { throw ('Valore richiesto: ' + $key) }
            Set-EnvValue $key $value
        }
    }
    foreach ($key in @('POSTGRES_PASSWORD','ADMIN_TOKEN','DASHBOARD_PASSWORD')) {
        $value = Get-EnvValue $key
        $minimum = if ($key -eq 'DASHBOARD_PASSWORD') { 12 } else { 32 }
        if ($value.Length -lt $minimum -or $value.StartsWith('SOSTITUISCI')) { throw ('Valore privato da configurare: ' + $key) }
    }
    Protect-LocalPath $envFile
    Protect-LocalPath (Join-Path $script:SynkRoot 'secrets') -Directory
    Protect-LocalPath (Join-Path $script:SynkRoot 'runtime') -Directory
    Protect-LocalPath (Join-Path $script:SynkRoot 'setup') -Directory
    Invoke-Compose -Arguments @('config','--quiet') | Out-Null
    Invoke-Compose -Arguments @('up','-d','--build')
    Wait-SynkHealth
    Write-Host 'Installazione avviata. Esegui COLLAUDO.md prima dei clienti reali.'
    Start-Process 'http://127.0.0.1:8080/'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { Exit-SynkMaintenance $mutex }
