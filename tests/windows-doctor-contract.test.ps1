Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/preflight.ps1')

$count = 0
function Check([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:count++
}
function Set-DoctorMock([bool]$Ready, [int]$Code, [string]$Status) {
    $script:doctorCode = $Code
    $script:doctorRaw = $null
    $script:doctorWithExit = $true
    $script:doctorReport = @{
        schema = 1
        scope = 'offline'
        productionReady = $false
        readyForBootstrap = $Ready
        checks = @(
            @{id = 'license'; status = $Status; label = 'Licenza sintetica'; help = 'Risultato sintetico.'},
            @{id = 'live_acceptance'; status = 'warn'; label = 'Collaudo reale'; help = 'Non eseguito.'}
        )
    }
}
function Invoke-DockerProbe {
    param([string[]]$Arguments, [int]$TimeoutMilliseconds = 8000)
    if (($Arguments -join ' ') -ne 'compose --profile tools run --rm --no-deps -T --pull never doctor') {
        throw 'Unexpected offline doctor command'
    }
    $json = if ($null -eq $script:doctorRaw) {
        ConvertTo-Json -InputObject $script:doctorReport -Depth 12 -Compress
    } else { $script:doctorRaw }
    if (-not $script:doctorWithExit) {
        return [pscustomobject]@{Success = ($script:doctorCode -eq 0); Value = $json}
    }
    return [pscustomobject]@{
        Success = ($script:doctorCode -eq 0)
        ExitCode = $script:doctorCode
        Value = $json
    }
}
function Rejected([string]$Message) {
    $blocked = $false
    try { Get-SynkOfflineDoctor | Out-Null } catch { $blocked = $true }
    Check $blocked $Message
}

Set-DoctorMock $true 0 'pass'
$report = Get-SynkOfflineDoctor
Check ($report.readyForBootstrap -eq $true) 'Ready report with exit zero must be accepted'
Check (@($report.checks).Count -eq 2) 'Doctor checks must be preserved'

Set-DoctorMock $false 1 'fail'
Check ((Get-SynkOfflineDoctor).readyForBootstrap -eq $false) 'Failed checks with exit one must remain reportable'

Set-DoctorMock $true 1 'pass'
Rejected 'A nonzero doctor exit must not permit bootstrap'

Set-DoctorMock $false 0 'fail'
Rejected 'A success exit must not conceal an incomplete doctor report'

Set-DoctorMock $true 0 'fail'
Rejected 'Ready report must reject a failed subcheck'

Set-DoctorMock $false 1 'pass'
Rejected 'Incomplete report must identify at least one failed subcheck'

Set-DoctorMock $true 0 'pass'
$script:doctorReport.checks = @()
Rejected 'A report with no checks must not authorize installation'

Set-DoctorMock $true 0 'pass'
$script:doctorReport.checks[0].status = 'unknown'
Rejected 'Unknown check status must not be silently accepted'

Set-DoctorMock $true 0 'pass'
$script:doctorReport.checks[0].label = ''
Rejected 'Unnamed check must not be accepted'

Set-DoctorMock $true 0 'pass'
$script:doctorCode = 2
Rejected 'Unexpected doctor exit code must not authorize installation'

Set-DoctorMock $true 0 'pass'
$script:doctorWithExit = $false
Rejected 'Doctor result without an exit code must not authorize installation'

Set-DoctorMock $true 0 'pass'
$script:doctorRaw = 'not-json'
Rejected 'Malformed doctor output must fail closed'

Set-DoctorMock $true 0 'pass'
$script:doctorReport.productionReady = $true
Rejected 'Offline doctor must never claim production readiness'

Write-Host ('PASS: ' + $count + ' offline doctor exit/report contract checks (Docker mocked)')
