Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$tests=0
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'strumenti') -Filter '*.ps1') {
    $tokens=$null; $errors=$null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw ($file.Name + ': ' + ($errors.Message -join '; ')) }
    $tests++
}
. (Join-Path $root 'strumenti/common.ps1')
function Assert([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:tests++ }
function Assert-Rejected([scriptblock]$Action,[string]$Message) {
    $rejected=$false
    try { & $Action | Out-Null } catch { $rejected=$true }
    Assert $rejected $Message
}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-windows-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    Assert ((Get-RandomHex).Length -eq 64) 'Random token length'
    $utf8=Join-Path $temp 'utf8.txt'; Write-Utf8File $utf8 'test'
    Assert ([IO.File]::ReadAllBytes($utf8)[0] -eq 116) 'UTF8 must not have BOM'
    $source=Join-Path $temp 'source';$destination=Join-Path $temp 'destination'
    foreach ($dir in @('src','runtime','secrets','setup')) { New-Item -ItemType Directory -Force -Path (Join-Path $source $dir),(Join-Path $destination $dir) | Out-Null }
    Write-Utf8File (Join-Path $source 'src/index.js') 'new code'
    Write-Utf8File (Join-Path $source 'setup/config.example.json') '{}'
    foreach ($name in @('.env','setup/config.json','runtime/customer.json','secrets/license.txt')) { Write-Utf8File (Join-Path $destination $name) 'preserved private fixture' }
    Copy-SynkCode $source $destination -Replace
    Assert ((Get-Content -LiteralPath (Join-Path $destination 'src/index.js') -Raw) -eq 'new code') 'Code must be replaced'
    foreach ($name in @('.env','setup/config.json','runtime/customer.json','secrets/license.txt')) { Assert ((Get-Content -LiteralPath (Join-Path $destination $name) -Raw) -eq 'preserved private fixture') ('Protected path changed: ' + $name) }
    $oldRoot=$script:SynkRoot;$script:SynkRoot=$destination
    try {
        Set-EnvValue 'ADMIN_TOKEN' 'synthetic-safe-token'
        Assert ((Get-EnvValue 'ADMIN_TOKEN') -eq 'synthetic-safe-token') 'Env update'
        Assert-Rejected { Set-EnvValue 'ADMIN_TOKEN' ('unsafe' + [char]10 + 'OTHER=1') } 'Env newline injection accepted'
        Assert-Rejected { Set-EnvValue 'ADMIN_TOKEN' '$INJECT' } 'Compose interpolation accepted'
    } finally { $script:SynkRoot=$oldRoot }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive=Join-Path $temp 'traversal.zip'
    $zip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry=$zip.CreateEntry('../outside.txt');$writer=New-Object IO.StreamWriter($entry.Open());$writer.Write('fixture');$writer.Dispose()
    } finally { $zip.Dispose() }
    $extract=Join-Path $temp 'extract';New-Item -ItemType Directory -Path $extract | Out-Null
    Assert-Rejected { Expand-SynkRelease $archive $extract } 'ZIP traversal accepted'
    Assert (-not (Test-Path -LiteralPath (Join-Path $temp 'outside.txt'))) 'ZIP escaped staging'
    $package=Get-ChildItem -LiteralPath (Join-Path $root 'artifacts') -Filter 'synk-*.zip' | Select-Object -First 1
    if ($null -eq $package) { throw 'Run npm run release:package before Windows tests.' }
    $valid=Join-Path $temp 'valid';New-Item -ItemType Directory -Path $valid | Out-Null
    $manifest=Expand-SynkRelease $package.FullName $valid
    Assert ($manifest.version -match '-rc\.\d+$') 'Valid release was not recognized'
    Assert (Test-Path -LiteralPath (Join-Path $valid 'dashboard.php')) 'Entrypoint missing after extraction'
    Assert (-not (Test-Path -LiteralPath (Join-Path $valid '.env'))) 'Private .env packaged'
    Write-Host ('PASS: ' + $tests + ' Windows parser/archive/protected-path checks')
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
}
