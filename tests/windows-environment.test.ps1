Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/configurazione.ps1')
. (Join-Path $root 'strumenti/ambiente.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
$script:answers=New-Object 'System.Collections.Generic.Queue[string]'
function Read-Host { param([string]$Prompt) if ($script:answers.Count -eq 0) { throw 'Unexpected environment prompt' };return $script:answers.Dequeue() }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-env-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    Copy-Item -LiteralPath (Join-Path $root '.env.example') -Destination (Join-Path $temp '.env.example')
    $script:answers.Enqueue('calendar@group.calendar.google.com');$script:answers.Enqueue('HW-synthetic-installation')
    $first=Initialize-SynkEnvironment
    Check $first.Created 'Initial environment not created'
    Check $first.DashboardPasswordGenerated 'Password not generated'
    $password=Get-EnvValue 'DASHBOARD_PASSWORD';$dbPassword=Get-EnvValue 'POSTGRES_PASSWORD';$admin=Get-EnvValue 'ADMIN_TOKEN'
    Check ($password -match '^[a-f0-9]{32}$') 'Dashboard password must be random'
    Check ($dbPassword -match '^[a-f0-9]{64}$') 'DB password must be URL-safe random'
    Check ($admin -match '^[a-f0-9]{64}$' -and $admin -ne $dbPassword) 'Independent admin token'
    Check ((Get-EnvValue 'CALENDAR_ID') -eq 'calendar@group.calendar.google.com') 'Calendar ID missing'
    Check ((Get-EnvValue 'APP_HWID') -eq 'HW-synthetic-installation') 'HWID missing'
    $next=Initialize-SynkEnvironment -DatabaseExists
    Check (-not $next.Created -and -not $next.DashboardPasswordGenerated) 'Rerun changed creation state'
    Check ((Get-EnvValue 'DASHBOARD_PASSWORD') -ceq $password) 'Dashboard password rotated on rerun'
    Check ((Get-EnvValue 'POSTGRES_PASSWORD') -ceq $dbPassword) 'DB password rotated on rerun'
    Check ((Get-EnvValue 'ADMIN_TOKEN') -ceq $admin) 'Admin token rotated on rerun'
    Set-EnvValue 'POSTGRES_PASSWORD' 'SOSTITUISCI_PASSWORD_CASUALE'
    $blocked=$false;try{Initialize-SynkEnvironment -DatabaseExists | Out-Null}catch{$blocked=$true}
    Check $blocked 'A present database must block automatic DB password generation'
    Check ((Get-EnvValue 'POSTGRES_PASSWORD') -eq 'SOSTITUISCI_PASSWORD_CASUALE') 'Existing database password was replaced'
    Remove-Item -LiteralPath (Join-Path $temp '.env') -Force
    $blocked=$false;try{Initialize-SynkEnvironment -DatabaseExists | Out-Null}catch{$blocked=$true}
    Check $blocked 'Missing environment with existing DB must fail closed'
    Check (-not (Test-Path -LiteralPath (Join-Path $temp '.env'))) 'Failed recovery created a replacement .env'
    Check (-not (Test-Path -LiteralPath (Join-Path $temp 'secrets/license.txt'))) 'Environment helper must not issue licenses'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' resumable private environment checks')
