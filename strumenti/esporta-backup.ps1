param([string]$Destination)
. (Join-Path $PSScriptRoot 'common.ps1')
$mutex=$null; $temporary=$null
try {
    $mutex=Enter-SynkMaintenance
    if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination=Read-Host 'Cartella di destinazione sulla USB protetta BitLocker (es. E:\BackupSynk)' }
    $full=[IO.Path]::GetFullPath($Destination)
    if ($full.StartsWith('\\') -or $full -notmatch '^[A-Za-z]:\\') { throw 'Usa un unita USB locale, non una cartella di rete.' }
    $drive=$full.Substring(0,2)
    if (-not (Get-Command Get-BitLockerVolume -ErrorAction SilentlyContinue)) { throw 'Impossibile verificare BitLocker: copia rifiutata.' }
    $volume=Get-BitLockerVolume -MountPoint $drive -ErrorAction Stop
    if ($volume.ProtectionStatus -ne 'On' -or $volume.VolumeStatus -ne 'FullyEncrypted' -or $volume.LockStatus -ne 'Unlocked') { throw 'Il supporto deve essere completamente cifrato, sbloccato e con protezione BitLocker attiva.' }
    $disk=Get-Partition -DriveLetter $drive.Substring(0,1) | Get-Disk
    if ($disk.BusType -ne 'USB') { throw 'La destinazione non risulta un disco USB. Copia rifiutata.' }
    $folder=Join-Path $script:SynkRoot 'runtime/backups'
    $latest=Get-ChildItem -LiteralPath $folder -File -Filter 'synk-*.dump' | Where-Object { $_.Name -match '^synk-\d{8}-\d{6}\.dump$' -and $_.Length -gt 0 } | Sort-Object Name -Descending | Select-Object -First 1
    if ($null -eq $latest) { throw 'Nessun backup disponibile.' }
    New-Item -ItemType Directory -Force -Path $full | Out-Null
    $target=Join-Path $full $latest.Name
    if (Test-Path -LiteralPath $target) { throw 'Backup gia presente sulla USB: non sovrascrivo.' }
    $temporary=$target + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
    Copy-Item -LiteralPath $latest.FullName -Destination $temporary
    $sourceHash=(Get-FileHash -LiteralPath $latest.FullName -Algorithm SHA256).Hash
    $targetHash=(Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash
    if ($sourceHash -ne $targetHash) { throw 'SHA256 diverso: esportazione non valida.' }
    Move-Item -LiteralPath $temporary -Destination $target
    $temporary=$null
    Write-Utf8File ($target + '.sha256') ($sourceHash.ToLowerInvariant() + '  ' + $latest.Name + "`n")
    Write-Host ('Copia verificata su USB BitLocker: ' + $target)
    Write-Host 'Conserva la chiave di recupero BitLocker separatamente. Non includerla nel backup.'
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    Exit-SynkMaintenance $mutex
}
