Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/preflight.ps1')
. (Join-Path $root 'strumenti/avvio.ps1')
$count=0;$script:calls=New-Object 'System.Collections.Generic.List[string]';$script:doctorOk=$true
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
function Wait-SynkDocker { param([switch]$StartDesktop) $script:calls.Add('docker') }
function Assert-SynkProjectOwnership { $script:calls.Add('ownership') }
function Enter-SynkMaintenance { $script:calls.Add('lock');return 'mock-lock' }
function Exit-SynkMaintenance($Mutex) { if ($null -ne $Mutex) {$script:calls.Add('unlock')} }
function Invoke-Compose { param([string[]]$Arguments) $script:calls.Add(($Arguments -join ' ')) }
function Get-SynkOfflineDoctor { $script:calls.Add('doctor');return [pscustomobject]@{readyForBootstrap=$script:doctorOk;checks=@()} }
function Wait-SynkHealth { param([int]$Seconds) $script:calls.Add('health') }
function Start-Process { param([string]$FilePath) $script:calls.Add('browser') }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-startup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    $failed=$false;try{Start-SynkServices -NoBrowser}catch{$failed=$true};Check $failed 'Unconfigured startup must stop'
    Check ($script:calls.Count -eq 0) 'Missing config must not start Docker'
    foreach($name in @('.env','setup/config.json','secrets/license.txt','secrets/license-public.pem','secrets/google-service-account.json')){
        $file=Join-Path $temp $name;New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null;Write-Utf8File $file 'synthetic fixture'
    }
    Start-SynkServices -NoBrowser
    Check (($script:calls -join '|') -eq 'docker|lock|ownership|config --quiet|doctor|up -d --no-build --pull never|health|unlock') 'Startup ordering/no-pull/bounded-health/lock'
    $script:calls.Clear();Start-SynkServices
    Check ($script:calls.Contains('browser')) 'Foreground startup must open browser after health'
    Check ($script:calls.IndexOf('browser') -gt $script:calls.IndexOf('health')) 'Browser opened too early'
    $script:calls.Clear();$script:doctorOk=$false
    $failed=$false;try{Start-SynkServices -NoBrowser}catch{$failed=$true};Check $failed 'Incomplete preflight allowed'
    Check (-not $script:calls.Contains('up -d --no-build --pull never')) 'Preflight failure started services'
    Check ($script:calls.Contains('unlock')) 'Failure leaked maintenance mutex'
    $script:doctorOk=$true;$script:calls.Clear()
    $hold=Join-Path $temp 'runtime/config/calendar-reconciliation-required.flag';New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hold) | Out-Null;Write-Utf8File $hold 'restore'
    $failed=$false;try{Start-SynkServices -NoBrowser}catch{$failed=$true};Check $failed 'Restore hold bypassed by startup'
    Check (-not $script:calls.Contains('doctor') -and $script:calls.Contains('unlock')) 'Hold must block before DB/dependency startup'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' safe daily startup checks')
