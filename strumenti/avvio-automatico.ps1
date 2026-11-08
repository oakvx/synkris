# Per-user Startup shortcut only. No service, registry edit, administrator task,
# stored Windows password, or automatic enablement during installation.
function Get-SynkAutostartDefinition {
    param([string]$StartupFolder = [Environment]::GetFolderPath('Startup'))
    if ([string]::IsNullOrWhiteSpace($StartupFolder)) { throw 'Cartella Esecuzione automatica dell''utente non disponibile.' }
    $root = [IO.Path]::GetFullPath($script:SynkRoot).TrimEnd('\','/').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root)))).Replace('-','').Substring(0,16) } finally { $sha.Dispose() }
    $target = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell/v1.0/powershell.exe'
    $scriptPath = Join-Path $script:SynkRoot 'strumenti/avvia.ps1'
    return [pscustomobject]@{Path=(Join-Path $StartupFolder ('Synk-' + $id + '.lnk'));Target=$target;Arguments=('-NoProfile -STA -ExecutionPolicy Bypass -File "' + $scriptPath + '" -NoBrowser -Quiet');WorkingDirectory=$script:SynkRoot}
}
function Get-SynkAutostartStatus {
    param([string]$StartupFolder = [Environment]::GetFolderPath('Startup'))
    $shell = $null; $shortcut = $null
    try {
        $definition = Get-SynkAutostartDefinition -StartupFolder $StartupFolder
        if (-not (Test-Path -LiteralPath $definition.Path -PathType Leaf)) { return 'disabled' }
        $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut($definition.Path)
        if ($shortcut.TargetPath -ieq $definition.Target -and $shortcut.Arguments -ceq $definition.Arguments -and $shortcut.WorkingDirectory -ieq $definition.WorkingDirectory) { return 'enabled' }
        return 'modified'
    } catch { return 'unavailable' }
    finally {
        if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
}
function Set-SynkAutostart {
    param([bool]$Enabled, [string]$StartupFolder = [Environment]::GetFolderPath('Startup'))
    $definition = Get-SynkAutostartDefinition -StartupFolder $StartupFolder
    $state = Get-SynkAutostartStatus -StartupFolder $StartupFolder
    if ($state -in @('modified','unavailable')) { throw 'Collegamento non riconosciuto o non leggibile: non lo sovrascrivo o elimino automaticamente.' }
    if (-not $Enabled) {
        if ($state -eq 'enabled') { Remove-Item -LiteralPath $definition.Path -Force }
        Write-Host 'Rimosso soltanto l''avvio automatico creato da questo strumento per questa installazione.'
        return
    }
    if (-not (Test-Path -LiteralPath (Join-Path $script:SynkRoot 'strumenti/avvia.ps1') -PathType Leaf)) { throw 'File di avvio mancante: ripristina il pacchetto ufficiale.' }
    New-Item -ItemType Directory -Force -Path $StartupFolder | Out-Null
    $others = @(Get-ChildItem -LiteralPath $StartupFolder -Filter 'Synk-*.lnk' | Where-Object { $_.FullName -ine $definition.Path })
    if ($others.Count -gt 0) { throw 'Esiste un altro avvio automatico synk: usa una sola installazione per PC e verifica con il tecnico prima di aggiungerne un''altra.' }
    if ($state -eq 'enabled') { Write-Host 'Avvio automatico gia configurato: nessun duplicato creato.'; return }
    $shell = $null; $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut($definition.Path)
        $shortcut.TargetPath = $definition.Target; $shortcut.Arguments = $definition.Arguments
        $shortcut.WorkingDirectory = $definition.WorkingDirectory; $shortcut.WindowStyle = 7
        $shortcut.Description = 'synk - avvio locale dopo accesso Windows, senza download o browser automatico'
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
    Write-Host 'Avvio automatico abilitato SOLO dopo l''accesso di questo utente a Windows. Non funziona a PC spento o prima del login.'
}
