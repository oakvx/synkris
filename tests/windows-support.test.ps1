Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/supporto.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
function Get-SynkDockerState { return 'ready' }
function Assert-SynkProjectOwnership { }
function Get-SynkAutostartStatus { return 'disabled' }
function Get-SynkOfflineDoctor { return [pscustomobject]@{checks=@([pscustomobject]@{id='license';status='pass';help='SENSITIVE_MARKER'},[pscustomobject]@{id='SENSITIVE_MARKER';status='pass'})} }
function Get-SynkRuntimeSummary { return [pscustomobject]@{schema=1;scope='runtime-status';whatsappReady=$true;databaseReady='SENSITIVE_MARKER';licenseStatus='valid';calendarStatus='SENSITIVE_MARKER';lastError='SENSITIVE_MARKER';messages=@('SENSITIVE_MARKER')} }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-support-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    Write-Utf8File (Join-Path $temp 'package.json') '{"version":"1.2.0-rc.6","name":"SENSITIVE_MARKER"}'
    Write-Utf8File (Join-Path $temp '.env') 'ADMIN_TOKEN=SENSITIVE_MARKER'
    $report=Get-SynkSupportReport
    $encoded=$report | ConvertTo-Json -Depth 8
    Check ($encoded -notmatch 'SENSITIVE_MARKER|BEGIN PUBLIC KEY|LIC=|SIG=') 'Report leaked source/credentials/arbitrary messages'
    Check ($report.offlineChecks.Count -eq 1) 'Unknown doctor fields must be dropped'
    Check ($report.runtime.whatsappReady -eq $true) 'Runtime boolean missing'
    Check ($null -eq $report.runtime.databaseReady) 'String must not become a positive boolean'
    Check ($report.runtime.calendarStatus -eq 'unknown') 'Provider message copied into status'
    $file=Export-SynkSupportReport
    Check (Test-Path -LiteralPath $file -PathType Leaf) 'Local support report missing'
    Check (([IO.File]::ReadAllText($file) | ConvertFrom-Json).kind -eq 'synk-support-status-only') 'Invalid report JSON'
    Check ([IO.File]::ReadAllText($file) -notmatch 'SENSITIVE_MARKER') 'Saved report not redacted'
    Check ([IO.File]::ReadAllBytes($file)[0] -eq 123) 'Report must be UTF-8 without BOM'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' status-only support report checks')
