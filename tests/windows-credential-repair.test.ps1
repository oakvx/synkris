Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/credenziali.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:count++ }
function Rejected([scriptblock]$Action,[string]$Message) { $bad=$false;try{& $Action}catch{$bad=$true};Check $bad $Message }
function Get-SynkDockerState { return 'ready' }
function Assert-SynkProjectOwnership { }
function Get-RunningWorkers { return @() }
function Read-SynkText { return 'SOSTITUISCI' }
function Show-SynkDoctorReport { param($Report) }
$script:validation='pass'
function Get-SynkOfflineDoctor { return [pscustomobject]@{checks=@([pscustomobject]@{id='license';status=$script:validation})} }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-initial-repair-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    $destination=Join-Path $temp 'secrets/license.txt'
    Write-SynkPrivateFile $destination 'existing-private-license'
    $source=Join-Path $temp 'replacement.txt'
    Write-Utf8File $source "LIC=eyJmaXh0dXJlIjp0cnVlfQ`nSIG=Zml4dHVyZQ`n"
    Repair-SynkInitialCredential -Name 'license.txt' -Source $source
    $accepted=[IO.File]::ReadAllText($destination)
    Check ($accepted -match '^LIC=') 'Verified replacement not kept'
    $backups=@(Get-ChildItem -LiteralPath (Join-Path $temp 'runtime/private-file-backups') -Recurse -File)
    Check ($backups.Count -eq 1 -and [IO.File]::ReadAllText($backups[0].FullName) -eq 'existing-private-license') 'Original private file not backed up'
    Write-Utf8File $source "LIC=bad`nSIG=bad`n";$script:validation='fail'
    Rejected {Repair-SynkInitialCredential -Name 'license.txt' -Source $source} 'Rejected signature accepted'
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Failed check did not restore exact original'
    Check (@(Get-ChildItem -LiteralPath (Join-Path $temp 'secrets') -Force -Filter '.credential-pending-*').Count -eq 0) 'Staging credential left behind'
    Write-SynkPrivateFile (Join-Path $temp 'runtime/config/.synkris-bootstrap-ok') 'already-imported'
    Rejected {Repair-SynkInitialCredential -Name 'license.txt' -Source $source} 'Operational deployment was modified'
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Imported deployment changed'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' initial private-file repair and exact rollback checks')
