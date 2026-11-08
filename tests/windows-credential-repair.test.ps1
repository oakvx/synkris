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
$script:services=@();$script:confirmation='SOSTITUISCI';$script:doctorAvailable=$true
function Get-RunningWorkers { return $script:services }
function Read-SynkText { return $script:confirmation }
function Show-SynkDoctorReport { param($Report) }
$script:validation='pass'
function Get-SynkOfflineDoctor { if(-not $script:doctorAvailable){throw 'Checker image unavailable'};return [pscustomobject]@{checks=@([pscustomobject]@{id='google_credentials';status=$script:validation})} }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-initial-repair-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    $destination=Join-Path $temp 'secrets/google-service-account.json'
    Write-SynkPrivateFile $destination 'existing-private-credentials'
    $source=Join-Path $temp 'replacement.json'
    $credential = @{type='service_account';client_email='synthetic@ci.iam.gserviceaccount.com';private_key=('-----BEGIN ' + 'PRIVATE KEY-----' + "`nsynthetic")}
    Write-Utf8File $source ($credential | ConvertTo-Json)
    Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source
    $accepted=[IO.File]::ReadAllText($destination)
    Check (($accepted | ConvertFrom-Json).type -eq 'service_account') 'Verified replacement not kept'
    $backups=@(Get-ChildItem -LiteralPath (Join-Path $temp 'runtime/private-file-backups') -Recurse -File)
    Check ($backups.Count -eq 1 -and [IO.File]::ReadAllText($backups[0].FullName) -eq 'existing-private-credentials') 'Original private file not backed up'
    $credential.client_email='rejected@ci.iam.gserviceaccount.com';Write-Utf8File $source ($credential | ConvertTo-Json);$script:validation='fail'
    Rejected {Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source} 'Rejected Google credentials accepted'
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Failed check did not restore exact original'
    Check (@(Get-ChildItem -LiteralPath (Join-Path $temp 'secrets') -Force -Filter '.credential-pending-*').Count -eq 0) 'Staging credential left behind'
    $script:confirmation='ANNULLA';Write-Utf8File $source 'malformed-source-must-not-be-read'
    Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Cancellation changed the original'
    $script:confirmation='SOSTITUISCI';$script:services=@('bot')
    Rejected {Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source} 'Active workers were not blocked'
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Active deployment changed'
    $script:services=@();$script:doctorAvailable=$false
    Rejected {Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source} 'Missing checker should fail before replacement'
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Missing checker changed original'
    $script:doctorAvailable=$true;$script:validation='pass';Write-Utf8File $source $accepted
    $handle=[IO.File]::Open($destination,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    try { Rejected {Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source} 'Locked destination unexpectedly replaced' } finally { $handle.Dispose() }
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Locked original changed'
    Check (@(Get-ChildItem -LiteralPath (Join-Path $temp 'secrets') -Force -Filter '.credential-pending-*').Count -eq 0) 'Locked destination left a staged credential'
    Write-SynkPrivateFile (Join-Path $temp 'runtime/config/.synkris-bootstrap-ok') 'already-imported'
    Rejected {Repair-SynkInitialCredential -Name 'google-service-account.json' -Source $source} 'Operational deployment was modified'
    Check ([IO.File]::ReadAllText($destination) -ceq $accepted) 'Imported deployment changed'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' initial private-file repair and exact rollback checks')
