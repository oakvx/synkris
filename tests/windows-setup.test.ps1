Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/configurazione.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
$script:answers=New-Object 'System.Collections.Generic.Queue[string]'
function Read-Host { param([string]$Prompt) if ($script:answers.Count -eq 0) { throw ('Missing mock answer: ' + $Prompt) }; return $script:answers.Dequeue() }
function Answers([string[]]$Values) { $script:answers.Clear(); foreach ($value in $Values) { $script:answers.Enqueue($value) } }
Answers @('0','961','35')
Check ((Read-SynkInteger 'duration' 1 960 30) -eq 35) 'Integer retries/ranges'
Answers @('not a price','-1','10,999','25,50')
Check ((Read-SynkMoney 'price') -eq [decimal]25.5) 'Italian price and precision'
Answers @('9','2,1,2')
$selection=@(Read-SynkSelection 'team' 2 '1')
Check (($selection -join ',') -eq '1,2') 'Selection must reject missing indexes and deduplicate'
Answers @('09:00','08:00','18:00')
$pair=@(Read-SynkTimePair 'hours')
Check (($pair -join ',') -eq '09:00,18:00') 'Opening order'
# Salon, team, service, opening weekdays, shared hours, no pause, Saturday hours.
Answers @("Salone d'esempio",'1','Persona sintetica','team@example.com','team@salone.it','1','Manicure','35','25,50','1','1,2,3,4,5,6','09:00','18:00','','09:00','13:00')
$config=New-SynkSalonConfiguration
Check ($script:answers.Count -eq 0) 'Unexpected wizard prompts'
Check ($config.professionals.Count -eq 1) 'Professional count'
Check ($config.services['Manicure'].durationMin -eq 35) 'Service duration'
Check ($config.services['Manicure'].price -eq [decimal]25.5) 'Service price'
Check (@($config.services['Manicure'].professionals).Count -eq 1) 'Single assignment must stay an array'
Check (($config.businessHours['6'] -join ',') -eq '09:00,13:00') 'Saturday hours'
Check (@($config.closedDays).Count -eq 1 -and $config.closedDays[0] -eq 7) 'Closed Sunday'
$encoded=$config | ConvertTo-Json -Depth 12
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-setup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    $file=Join-Path $temp 'setup/config.json'
    Write-SynkPrivateFile $file $encoded
    # Use UTF-8 files: native stdin/inline JS differs between PowerShell 5.1/7.
    & node (Join-Path $PSScriptRoot 'validate-salon-fixture.mjs') $file
    Check ($LASTEXITCODE -eq 0) 'Wizard output must satisfy the production validator'
    Check ([IO.File]::ReadAllBytes($file)[0] -eq 123) 'Private JSON must be UTF-8 without BOM'
    $before=[IO.File]::ReadAllText($file)
    $rejected=$false;try{Write-SynkPrivateFile $file 'replacement'}catch{$rejected=$true}
    Check $rejected 'Existing setup must not be overwritten'
    Check ([IO.File]::ReadAllText($file) -ceq $before) 'Existing setup changed'
    Answers @()
    Initialize-SynkSalonConfiguration
    Check ([IO.File]::ReadAllText($file) -ceq $before) 'Rerun must keep existing setup'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' guided configuration checks')
