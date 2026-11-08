Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/avvio-automatico.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk autostart ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $temp 'instrument/strumenti'),(Join-Path $temp 'startup') | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=Join-Path $temp 'instrument'
$startup=Join-Path $temp 'startup'
try {
    Write-Utf8File (Join-Path $script:SynkRoot 'strumenti/avvia.ps1') '# synthetic fixture; never executed'
    Check ((Get-SynkAutostartStatus -StartupFolder $startup) -eq 'disabled') 'Autostart enabled without opt-in'
    Set-SynkAutostart -Enabled $true -StartupFolder $startup
    Check ((Get-SynkAutostartStatus -StartupFolder $startup) -eq 'enabled') 'Shortcut not recognized'
    Set-SynkAutostart -Enabled $true -StartupFolder $startup
    Check (@(Get-ChildItem -LiteralPath $startup -Filter '*.lnk').Count -eq 1) 'Duplicate startup entry'
    $definition=Get-SynkAutostartDefinition -StartupFolder $startup
    Check ($definition.Arguments -match '-NoBrowser -Quiet$' -and $definition.Arguments -notmatch '-Command|PASSWORD|TOKEN') 'Unsafe startup arguments'
    $shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($definition.Path)
    $link.Arguments='modified by a user';$link.Save()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    Check ((Get-SynkAutostartStatus -StartupFolder $startup) -eq 'modified') 'Modified shortcut treated as owned'
    $failed=$false;try{Set-SynkAutostart -Enabled $false -StartupFolder $startup}catch{$failed=$true};Check $failed 'Modified shortcut deleted'
    Check (Test-Path -LiteralPath $definition.Path) 'Foreign/modified entry removed'
    Remove-Item -LiteralPath $definition.Path -Force
    Set-SynkAutostart -Enabled $true -StartupFolder $startup
    Set-SynkAutostart -Enabled $false -StartupFolder $startup
    Check ((Get-SynkAutostartStatus -StartupFolder $startup) -eq 'disabled') 'Opt-out did not remove managed entry'
    Write-Utf8File (Join-Path $startup 'Synk-OTHER.lnk') 'not an owned shortcut'
    $failed=$false;try{Set-SynkAutostart -Enabled $true -StartupFolder $startup}catch{$failed=$true};Check $failed 'Second managed installation allowed'
    Check (Test-Path -LiteralPath (Join-Path $startup 'Synk-OTHER.lnk')) 'Unrelated shortcut deleted'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' per-user autostart checks (temporary folder only)')
