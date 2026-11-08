Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/preflight.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
$script:cli=$true;$script:engine='linux';$script:context='npipe:////./pipe/dockerDesktopLinuxEngine';$script:version='2.40.0';$script:probes=0;$script:volume='';$script:volumeOk=$true
function Test-SynkDockerCli { return $script:cli }
function Invoke-DockerProbe {
    param([string[]]$Arguments,[int]$TimeoutMilliseconds=8000)
    $script:probes++
    switch ($Arguments[0]) {
        'context' { return [pscustomobject]@{Success=$true;Value=$script:context} }
        'compose' { return [pscustomobject]@{Success=$true;Value=$script:version} }
        'info' { return [pscustomobject]@{Success=($script:engine -ne 'offline');Value=$script:engine} }
        'volume' { return [pscustomobject]@{Success=$script:volumeOk;Value=$script:volume} }
    }
    throw 'Unexpected Docker probe'
}
$previous=$env:DOCKER_HOST;$env:DOCKER_HOST=''
try {
    Check ((Get-SynkDockerState) -eq 'ready') 'Local Linux Docker not recognized'
    $script:version='v5.1.0';Check ((Get-SynkDockerState) -eq 'ready') 'Compatible future Compose major rejected'
    $script:version='1.29.2';Check ((Get-SynkDockerState) -eq 'missing_compose') 'Old Compose accepted'
    $script:version='2.40.0';$script:engine='windows';Check ((Get-SynkDockerState) -eq 'windows_engine') 'Windows containers accepted'
    $script:engine='offline';Check ((Get-SynkDockerState) -eq 'starting') 'Unavailable engine accepted'
    $failed=$false;try{Wait-SynkDocker -Seconds 0}catch{$failed=$true};Check $failed 'Docker wait must time out'
    $script:engine='linux';$script:context='ssh://remote.example';Check ((Get-SynkDockerState) -eq 'remote_context') 'Remote Docker context accepted'
    $script:context='npipe:////./pipe/dockerDesktopLinuxEngine';$env:DOCKER_HOST='tcp://remote.example:2375';$script:probes=0
    Check ((Get-SynkDockerState) -eq 'remote_context' -and $script:probes -eq 0) 'Remote DOCKER_HOST must be rejected before connecting'
    $env:DOCKER_HOST='';$script:cli=$false;Check ((Get-SynkDockerState) -eq 'missing_cli') 'Missing CLI not diagnosed'
    $script:cli=$true
    $temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-preflight-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp | Out-Null
    $oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
    try {
        Check (-not (Test-SynkDatabaseVolume)) 'Empty volumes not recognized'
        $script:volume='synk_postgres_data';Check (Test-SynkDatabaseVolume) 'Existing database not recognized'
        $script:volumeOk=$false;$failed=$false;try{Test-SynkDatabaseVolume | Out-Null}catch{$failed=$true};Check $failed 'Volume probe failure must not be treated as a new install'
    } finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
} finally { $env:DOCKER_HOST=$previous }
Write-Host ('PASS: ' + $count + ' Docker preflight checks')
