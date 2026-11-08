# Read-only native probes. Bound each Docker CLI query; never print raw output.
function Test-SynkDockerCli { return [bool](Get-Command docker -CommandType Application -ErrorAction SilentlyContinue) }
function Invoke-DockerProbe {
    param([string[]]$Arguments, [int]$TimeoutMilliseconds = 8000)
    $command = Get-Command docker -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) { return [pscustomobject]@{Success=$false;Value=''} }
    # These probes accept only fixed flags, templates and validated project names.
    if (@($Arguments | Where-Object { $_ -notmatch '^[A-Za-z0-9_./:=,{}^$-]+$' }).Count -gt 0) { throw 'Argomenti diagnostica Docker non ammessi.' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $command.Source; $info.Arguments = $Arguments -join ' '
    $info.WorkingDirectory = $script:SynkRoot
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
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
        return [pscustomobject]@{Success=($process.ExitCode -eq 0);Value=$output.Trim()}
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
            'context_unavailable' { throw 'Contesto Docker non leggibile. Apri Docker Desktop e verifica il contesto locale.' }
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
function Test-SynkDatabaseVolume {
    $project = Get-EnvValue 'COMPOSE_PROJECT_NAME'
    if (-not $project) { $project = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { 'synk' } }
    if ($project -notmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Nome progetto Compose non valido: non posso verificare il volume database in sicurezza.' }
    $result = Invoke-DockerProbe -Arguments @('volume','ls','--filter',('name=^' + $project + '_postgres_data$'),'--format','{{.Name}}')
    if (-not $result.Success) { throw 'Non posso verificare i volumi: non genero o sostituisco password database.' }
    return -not [string]::IsNullOrWhiteSpace($result.Value)
}
function Get-SynkOfflineDoctor {
    Push-Location -LiteralPath $script:SynkRoot
    try {
        # No dependency startup, no schema writes, no browser or cloud requests.
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $lines = @(& docker compose --profile tools run --rm --no-deps -T --pull never doctor 2>$null)
            $status = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previous }
        try { $report = ($lines -join "`n") | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Diagnostica offline non disponibile. Completa la costruzione immagini tramite INSTALLA_UNA_VOLTA.' }
        if ($null -eq $report -or $report.schema -ne 1 -or $report.scope -ne 'offline' -or $report.productionReady -ne $false -or $status -notin @(0,1)) { throw 'Formato diagnostica non riconosciuto; non viene dichiarata pronta l''installazione.' }
        return $report
    } finally { Pop-Location }
}
function Show-SynkDoctorReport($Report) {
    foreach ($check in $Report.checks) {
        $tag = switch ($check.status) { 'pass' { 'OK' }; 'warn' { 'NOTA' }; default { 'DA COMPLETARE' } }
        Write-Host ('[' + $tag + '] ' + $check.label)
        Write-Host ('  ' + $check.help)
    }
    Write-Host 'Controlli OFFLINE: WhatsApp, Calendar e ripristino reale non sono certificati.'
}
