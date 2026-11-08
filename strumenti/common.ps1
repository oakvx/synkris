Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:SynkRoot = Split-Path -Parent $PSScriptRoot
$script:CodePaths = @('src','dashboard','deploy','assets','strumenti','scripts','dashboard.php','bridge.php','Dockerfile','Dockerfile.dashboard','compose.yaml','package.json','package-lock.json','.dockerignore','.env.example','RELEASE-MANIFEST.json','LEGGIMI.txt','LICENSE.md','SECURITY.md','COLLAUDO.md','RELEASE.md','CHANGELOG.md','REPORT_BUGFIX_RC4.md','REPORT_BUGFIX_RC5.md','REPORT_RICOSTRUZIONE_RC6.md','AGGIORNA_SYNK_TECNICO.bat','APRI_SYNK.bat','ATTIVA_AI_LOCALE.bat','AVVIA_SYNK.bat','ESPORTA_BACKUP_CIFRATO_TECNICO.bat','INSTALLA_UNA_VOLTA.bat','RIATTIVA_CALENDAR_TECNICO.bat','RIPRISTINA_BACKUP.bat','setup/config.example.json')

function Write-Utf8File([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
# Create-only writes: never truncate an existing salon file, even on a rerun.
function Write-SynkPrivateFile([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Protect-LocalPath $parent -Directory
    $stream = $null; $created = $false; $complete = $false
    try {
        $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $created = $true
        Protect-LocalPath $Path
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text)
        $stream.Write($bytes,0,$bytes.Length)
        $stream.Flush()
        $complete = $true
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($created -and -not $complete) { Remove-Item -LiteralPath $Path -Force }
    }
}
function Get-RandomHex([int]$Bytes = 32) {
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($buffer)).Replace('-','').ToLowerInvariant()
}
function Assert-Docker {
    # Apply the same local-daemon and project-folder safety to legacy technical
    # entrypoints (update, restore, export, reconciliation, optional AI), not only
    # the new installation/daily-start flow. Never fall back to a remote daemon.
    if ((Get-SynkDockerState) -ne 'ready') { throw 'Serve Docker locale, pronto, con Compose v2 e motore Linux. Apri INSTALLA_UNA_VOLTA > Diagnostica. Nessuna operazione tecnica avviata.' }
    Assert-SynkProjectOwnership
}

function Invoke-Compose {
    param([Parameter(Mandatory=$true)][string[]]$Arguments)
    Push-Location -LiteralPath $script:SynkRoot
    try {
        & docker compose @Arguments
        if ($LASTEXITCODE -ne 0) { throw ('Docker Compose non riuscito: ' + ($Arguments -join ' ')) }
    } finally { Pop-Location }
}
function Get-RunningWorkers {
    $services = @(Invoke-Compose -Arguments @('ps','--services','--status','running'))
    return @($services | Where-Object { $_ -in @('bot','dashboard','backup') })
}
function Enter-SynkMaintenance {
    $bytes = [Text.Encoding]::UTF8.GetBytes($script:SynkRoot.ToLowerInvariant())
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $name = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').Substring(0,24) } finally { $sha.Dispose() }
    $mutex = New-Object System.Threading.Mutex($false, ('Local\SynkMaintenance-' + $name))
    try { $acquired = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { $mutex.Dispose(); throw 'Un altro intervento tecnico e gia in corso.' }
    return $mutex
}
function Exit-SynkMaintenance($Mutex) {
    if ($null -ne $Mutex) { $Mutex.ReleaseMutex(); $Mutex.Dispose() }
}
function Get-EnvValue([string]$Name) {
    $file = Join-Path $script:SynkRoot '.env'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
    $lines = @(Get-Content -LiteralPath $file | Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '=') })
    if ($lines.Count -eq 0) { return '' }
    if ($lines.Count -ne 1) { throw ('Chiave .env duplicata: ' + $Name) }
    return $lines[0].Substring($Name.Length + 1).Trim().Trim([char]34).Trim([char]39)
}
function Set-EnvValue([string]$Name, [string]$Value) {
    if ($Name -notmatch '^[A-Z][A-Z0-9_]*$' -or $Value -match '[\r\n\x00]') { throw 'Valore .env non valido.' }
    # Generated values must not be interpreted as Compose interpolation.
    if ($Value -match '[$#"'']') { throw 'Il valore contiene caratteri non supportati dal configuratore.' }
    $file = Join-Path $script:SynkRoot '.env'
    $text = if (Test-Path -LiteralPath $file) { [IO.File]::ReadAllText($file) } else { '' }
    $pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
    if ([regex]::IsMatch($text,$pattern)) { $text = [regex]::Replace($text,$pattern,($Name + '=' + $Value)) }
    else { $text += "`n" + $Name + '=' + $Value + "`n" }
    Write-Utf8File $file $text
}
function Protect-LocalPath([string]$Path, [switch]$Directory) {
    $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $suffix = if ($Directory) { '(OI)(CI)F' } else { 'F' }
    & icacls $Path '/inheritance:r' '/grant:r' ($account + ':' + $suffix) ('*S-1-5-18:' + $suffix) ('*S-1-5-32-544:' + $suffix) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Impossibile limitare i permessi dei file privati.' }
}
function Wait-SynkHealth([string[]]$Urls = @('http://127.0.0.1:3000/health','http://127.0.0.1:8080/'), [int]$Seconds = 240) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $ready = $true
        foreach ($url in $Urls) {
            try {
                $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
                if ($response.StatusCode -ne 200) { $ready = $false }
            } catch { $ready = $false }
        }
        if ($ready) { return }
        Start-Sleep -Seconds 4
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Servizi non pronti. Verifica docker compose logs, senza condividere dati o segreti.'
}
function New-DatabaseBackup {
    $folder = Join-Path $script:SynkRoot 'runtime/backups'
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $name = 'synk-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '.dump'
    $dest = Join-Path $folder $name
    if ((Test-Path -LiteralPath $dest) -or (Test-Path -LiteralPath ($dest + '.sha256'))) { throw 'Backup con lo stesso nome gia esistente. Riprova tra un secondo.' }
    # Copy binary bytes to a private staging file; never redirect pg_dump in PS 5.1.
    $temporary = Join-Path $folder ('.synk-pending-' + [Guid]::NewGuid().ToString('N'))
    $remote = '/tmp/' + $name
    $publishedHash = $false; $complete = $false
    try {
        Invoke-Compose -Arguments @('exec','-T','postgres','sh','-c',('umask 077; pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f ' + $remote)) | Out-Null
        Invoke-Compose -Arguments @('exec','-T','postgres','pg_restore','--list',$remote) | Out-Null
        $digest = ((@(Invoke-Compose -Arguments @('exec','-T','postgres','sha256sum',$remote)) -join '').Split(' ')[0]).ToLowerInvariant()
        if ($digest -notmatch '^[a-f0-9]{64}$') { throw 'Checksum del backup remoto non disponibile.' }
        Invoke-Compose -Arguments @('cp',('postgres:' + $remote),$temporary) | Out-Null
        if ((Get-Item -LiteralPath $temporary).Length -lt 1) { throw 'Backup vuoto.' }
        $hash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -cne $digest) { throw 'Checksum dopo la copia non corrispondente: il backup non viene pubblicato.' }
        Write-Utf8File ($temporary + '.sha256') ($hash + '  ' + $name + "`n")
        [IO.File]::Move(($temporary + '.sha256'),($dest + '.sha256'))
        $publishedHash = $true
        [IO.File]::Move($temporary,$dest)
        $complete = $true
        return $dest
    } finally {
        foreach ($file in @($temporary,($temporary + '.sha256'))) { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } }
        if ($publishedHash -and -not $complete) { Remove-Item -LiteralPath ($dest + '.sha256') -Force }
        try { Invoke-Compose -Arguments @('exec','-T','postgres','rm','-f',$remote) | Out-Null } catch { Write-Warning 'Pulizia del file temporaneo nel container non riuscita.' }
    }
}

function Assert-CodePath([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        if (((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Junction o link non ammessi nei percorsi del codice.' }
        foreach ($child in Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Junction o link non ammessi nel codice.' }
        }
    }
}
function Copy-SynkCode([string]$Source, [string]$Destination, [switch]$Replace) {
    foreach ($relative in $script:CodePaths) {
        $from = Join-Path $Source $relative
        $to = Join-Path $Destination $relative
        Assert-CodePath $from; Assert-CodePath $to
        if ($Replace -and (Test-Path -LiteralPath $to)) { Remove-Item -LiteralPath $to -Recurse -Force }
        if (Test-Path -LiteralPath $from) {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
            Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
        }
    }
}
function Expand-SynkRelease([string]$Archive, [string]$Destination) {
    # Windows PowerShell 5.1 does not automatically load the ZIP enum/types assembly.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($zip.Entries.Count -gt 10000) { throw 'Troppi file nello ZIP.' }
        $total = 0L; $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/')
            if ($name.EndsWith('/')) { continue }
            $invalidSegments = @($name.Split('/') | Where-Object { $_ -eq '' -or $_ -match '[. ]$' -or $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' })
            if ($name -match '(^/|:|[\x00-\x1f]|(^|/)\.{1,2}(/|$))' -or $invalidSegments.Count -gt 0) { throw 'Percorso ZIP non sicuro.' }
            if (-not $names.Add($name)) { throw 'Percorsi duplicati nello ZIP.' }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Link simbolici non ammessi nello ZIP.' }
            $total += $entry.Length
            if ($total -gt 1073741824) { throw 'ZIP troppo grande.' }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $name))
            if (-not $target.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Percorso ZIP fuori dalla cartella temporanea.' }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
        }
    } finally { $zip.Dispose() }
    $manifestPath = Join-Path $Destination 'RELEASE-MANIFEST.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Manifest della release mancante.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.format -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+-rc\.\d+$') { throw 'Manifest prerelease non valido.' }
    $files = @($manifest.files.PSObject.Properties)
    if ($files.Count -ne $names.Count - 1) { throw 'File non previsti o mancanti nel pacchetto.' }
    foreach ($property in $files) {
        $name = $property.Name
        $allowed = $false
        foreach ($codePath in $script:CodePaths) { if ($name -eq $codePath -or $name.StartsWith($codePath + '/', [StringComparison]::Ordinal)) { $allowed = $true; break } }
        if (-not $allowed -or -not $names.Contains($name) -or $name -eq 'RELEASE-MANIFEST.json') { throw 'File non ammesso nel manifest.' }
        $actual = (Get-FileHash -LiteralPath (Join-Path $Destination $name) -Algorithm SHA256).Hash
        if ($property.Value -notmatch '^[a-f0-9]{64}$' -or $actual -ine $property.Value) { throw ('Checksum manifest errato: ' + $name) }
    }
    return $manifest
}

# Definitions only: no Docker command runs while loading this library.
. (Join-Path $PSScriptRoot 'preflight.ps1')
