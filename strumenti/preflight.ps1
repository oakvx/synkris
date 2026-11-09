# Read-only native probes. Bound each Docker CLI query; never print raw output.
function Test-SynkDockerCli { return [bool](Get-Command docker -CommandType Application -ErrorAction SilentlyContinue) }
function Invoke-DockerProbe {
    param([string[]]$Arguments, [int]$TimeoutMilliseconds = 8000)
    $command = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) { return [pscustomobject]@{Success=$false;Value=''} }
    # These probes accept only fixed flags, templates and validated project names.
    if (@($Arguments | Where-Object { $_ -notmatch '^[A-Za-z0-9_./:=,{}^$-]+$' -and $_ -cne '{{json .Config.Labels}}' }).Count -gt 0) { throw 'Argomenti diagnostica Docker non ammessi.' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $command.Source
    $info.Arguments = ($Arguments | ForEach-Object { if ($_ -ceq '{{json .Config.Labels}}') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $info.WorkingDirectory = $script:SynkRoot
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { }
            return [pscustomobject]@{Success=$false;Value=''}
        }
        $output = $stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{Success=($process.ExitCode -eq 0);ExitCode=$process.ExitCode;Value=$output.Trim()}
    } catch { return [pscustomobject]@{Success=$false;Value=''} }
    finally { $process.Dispose() }
}
function Get-SynkDockerState {
    if (-not (Test-SynkDockerCli)) { return 'missing_cli' }
    if ($env:DOCKER_HOST -and $env:DOCKER_HOST -notmatch '^npipe://') { return 'remote_context' }
    $context = Invoke-DockerProbe -Arguments @('context','inspect','--format','{{.Endpoints.docker.Host}}')
    if (-not $context.Success) { return 'context_unavailable' }
    if ($context.Value -notmatch '^npipe://') { return 'remote_context' }
    $compose = Invoke-DockerProbe -Arguments @('compose','version','--short')
    $version = [regex]::Match($compose.Value,'^v?(\d{1,3})\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?$')
    if (-not $compose.Success -or -not $version.Success -or [int]$version.Groups[1].Value -lt 2) { return 'missing_compose' }
    $engine = Invoke-DockerProbe -Arguments @('info','--format','{{.OSType}}')
    if (-not $engine.Success) { return 'starting' }
    if ($engine.Value -ne 'linux') { return 'windows_engine' }
    return 'ready'
}
function Start-SynkDockerDesktop {
    $file = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Docker/Docker/Docker Desktop.exe'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    Start-Process -FilePath $file | Out-Null
    return $true
}
function Wait-SynkDocker {
    param([ValidateRange(0,600)][int]$Seconds = 180, [switch]$StartDesktop)
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds); $requested = $false
    do {
        $state = Get-SynkDockerState
        switch ($state) {
            'ready' { return }
            'missing_cli' { throw 'Installa Docker Desktop con WSL2 e riapri il programma. Non viene installato software o modificato Windows automaticamente.' }
            'missing_compose' { throw 'Serve Docker Compose v2 o successivo: aggiorna Docker Desktop.' }
            'remote_context' { throw 'Il percorso guidato richiede Docker Desktop LOCALE su named pipe. Seleziona il contesto locale; nessun deploy su server remoti viene avviato.' }
            'windows_engine' { throw 'Seleziona i container LINUX nelle impostazioni Docker Desktop; non cambio automaticamente il motore.' }
            'context_unavailable' {
                # Durante il setup Docker Desktop potrebbe non avere ancora creato
                # il contesto locale. Solo il percorso esplicitamente autorizzato
                # a tentare l'avvio puo' attendere e riprovare.
                if (-not $StartDesktop) {
                    throw 'Contesto Docker non leggibile. Apri Docker Desktop e verifica il contesto locale.'
                }
            }
        }
        if ($StartDesktop -and -not $requested) {
            $requested = $true
            if (Start-SynkDockerDesktop) { Write-Host 'Avvio Docker Desktop. Attendo il motore Linux...' }
            else { Write-Host 'Apri Docker Desktop. Attendo che sia pronto...' }
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Seconds 3
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Docker non e pronto entro il tempo previsto. Verifica WSL2 e virtualizzazione, poi rilancia: i file gia configurati restano intatti.'
}
function Get-SynkProjectName {
    $project = Get-EnvValue 'COMPOSE_PROJECT_NAME'
    if (-not $project) { $project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'synk' } }
    if ($project -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Nome progetto Compose non valido: non posso verificare il volume database in sicurezza.' }
    return $project
}
function Test-SynkDatabaseVolume {
    $project = Get-SynkProjectName
    $result = Invoke-DockerProbe -Arguments @('volume','ls','--filter',('name=^' + $project + '_postgres_data$'),'--format','{{.Name}}')
    if (-not $result.Success) { throw 'Non posso verificare i volumi: non genero o sostituisco password database.' }
    return -not [string]::IsNullOrWhiteSpace($result.Value)
}
function Get-SynkOfflineDoctor {
    # No dependency startup, downloads, schema writes, browser or cloud requests.
    $result = Invoke-DockerProbe -Arguments @('compose','--profile','tools','run','--rm','--no-deps','-T','--pull','never','doctor') -TimeoutMilliseconds 60000
    try { $report = $result.Value | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Diagnostica offline non disponibile. Completa la costruzione immagini tramite INSTALLA_SYNK.' }
    $exitProperty = $result.PSObject.Properties['ExitCode']
    if ($null -eq $report -or $report.schema -ne 1 -or $report.scope -ne 'offline' -or $report.productionReady -ne $false -or $report.readyForBootstrap -isnot [bool] -or $null -eq $exitProperty -or $exitProperty.Value -notin @(0,1)) { throw 'Formato diagnostica non riconosciuto; non viene dichiarata pronta l''installazione.' }
    # The doctor contract is strict: zero means ready; one means incomplete.
    # A contradictory exit code must never authorize database/bootstrap startup.
    if ($report.readyForBootstrap -ne ($exitProperty.Value -eq 0)) {
        throw 'Diagnostica offline incoerente: stato Docker e risultato non corrispondono. Nessun avvio consentito.'
    }
    return $report
}

function Show-SynkDoctorReport($Report) {
    foreach ($check in $Report.checks) {
        $tag = switch ($check.status) { 'pass' { 'OK' }; 'warn' { 'NOTA' }; default { 'DA COMPLETARE' } }
        Write-Host ('[' + $tag + '] ' + $check.label)
        Write-Host ('  ' + $check.help)
    }
    Write-Host 'Controlli OFFLINE: WhatsApp, Calendar e ripristino reale non sono certificati.'
}

function Assert-SynkProjectOwnership {
    $project = Get-SynkProjectName
    $containers = Invoke-DockerProbe -Arguments @('ps','--all','--quiet','--filter',('label=com.docker.compose.project=' + $project))
    if (-not $containers.Success) { throw 'Impossibile verificare l''installazione Docker esistente. Non avvio o sostituisco container.' }
    foreach ($id in @($containers.Value -split '\r?\n' | Where-Object { $_ })) {
        if ($id -notmatch '^[a-f0-9]{12,64}$') { throw 'Identificativo container non riconosciuto.' }
        $result = Invoke-DockerProbe -Arguments @('inspect','--format','{{json .Config.Labels}}',$id)
        if (-not $result.Success) { throw 'Metadati installazione non leggibili. Non sostituisco container esistenti.' }
        try {
            $labels = $result.Value | ConvertFrom-Json -ErrorAction Stop
            $property = $labels.PSObject.Properties['com.docker.compose.project.working_dir']
            if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) { throw 'unknown_directory' }
            $owner = [IO.Path]::GetFullPath([string]$property.Value).TrimEnd('\','/')
            $expected = [IO.Path]::GetFullPath($script:SynkRoot).TrimEnd('\','/')
            if (-not $owner.Equals($expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'different_installation' }
        } catch { throw 'Il progetto Docker appartiene a un''altra cartella o non e riconoscibile. Non lo sovrascrivo: usa una sola installazione per PC e chiedi assistenza per il trasferimento.' }
    }
}
