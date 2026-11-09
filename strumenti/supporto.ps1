# Library: common.ps1, preflight.ps1 and avvio-automatico.ps1 are required.
# No raw logs, environment dumps, client records, QR, license payloads or paths
# are copied into the report. No upload or external notification is performed.
function Get-SynkRuntimeSummary {
    $result = Invoke-DockerProbe -Arguments @('compose','exec','-T','bot','node','scripts/deploy/runtime-summary.mjs') -TimeoutMilliseconds 12000
    if (-not $result.Success) { return $null }
    try { return ($result.Value | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}

function Get-SynkSupportReport {
    $version = 'unknown'
    try {
        $package = [IO.File]::ReadAllText((Join-Path $script:SynkRoot 'package.json')) | ConvertFrom-Json
        if ($package.version -match '^\d+\.\d+\.\d+(?:-rc\.\d+)?$') { $version = $package.version }
    } catch { }
    $state = Get-SynkDockerState
    if ($state -notin @('ready','missing_cli','missing_compose','remote_context','context_unavailable','windows_engine','starting')) { $state = 'unknown' }
    $checks = @(); $runtime = $null; $owned = $false
    if ($state -eq 'ready') {
        try { Assert-SynkProjectOwnership; $owned = $true } catch { }
        if ($owned) {
            try {
                $doctor = Get-SynkOfflineDoctor
                $ids = @('environment','postgres_password','admin_token','dashboard_password','calendar_id','hwid','activation_policy','license_key','license','google_credentials','salon_config','live_acceptance')
                $checks = @($doctor.checks | Where-Object { $_.id -in $ids -and $_.status -in @('pass','warn','fail') } | ForEach-Object { [pscustomobject]@{id=$_.id;status=$_.status} })
            } catch { }
            try {
                $data = Get-SynkRuntimeSummary
                if ($null -ne $data -and $data.schema -eq 1 -and $data.scope -eq 'runtime-status') {
                    $runtime = [ordered]@{}
                    foreach ($key in @('whatsappReady','databaseReady','calendarMaintenance','aiConfigured')) {
                        $property = $data.PSObject.Properties[$key]
                        $runtime[$key] = if ($null -ne $property -and $property.Value -is [bool]) { $property.Value } else { $null }
                    }
                    $license = $data.PSObject.Properties['licenseStatus']; $calendar = $data.PSObject.Properties['calendarStatus']
                    $runtime['licenseStatus'] = if ($null -ne $license -and $license.Value -in @('valid','invalid','unverified','temporary_read_failure')) { $license.Value } else { 'unknown' }
                    $runtime['calendarStatus'] = if ($null -ne $calendar -and $calendar.Value -in @('ok','error','partial','disabled','suspended_for_reconciliation')) { $calendar.Value } else { 'unknown' }
                }
            } catch { $runtime = $null }
        }
    }
    $autostart = Get-SynkAutostartStatus
    if ($autostart -notin @('enabled','disabled','legacy','modified','unavailable')) { $autostart = 'unavailable' }
    return [ordered]@{schema=1;kind='synk-support-status-only';checkedAt=[DateTime]::UtcNow.ToString('o');version=$version;
        powershell=$PSVersionTable.PSVersion.ToString();windowsVersion=[Environment]::OSVersion.Version.ToString();os64bit=[Environment]::Is64BitOperatingSystem;
        docker=$state;projectOwnershipVerified=$owned;autostart=$autostart;offlineChecks=$checks;runtime=$runtime;
        collectionPolicy='allowlisted-status-only-no-logs-or-credentials';productionReady=$false}
}
function Export-SynkSupportReport {
    $report = Get-SynkSupportReport
    $name = 'synk-support-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.json'
    $destination = Join-Path $script:SynkRoot ('runtime/support/' + $name)
    Write-SynkPrivateFile $destination (($report | ConvertTo-Json -Depth 8) + "`n")
    Write-Host ('Report creato SOLO in locale: ' + $destination)
    Write-Host 'Contiene stati selezionati, non log grezzi. Rileggilo prima di condividerlo con il tecnico. Nessun upload automatico.'
    return $destination
}
