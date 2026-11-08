Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/preflight.ps1')
$count=0;$script:containerIds='';$script:directory=$root;$script:metadataOk=$true
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
function Invoke-DockerProbe {
    param([string[]]$Arguments)
    if($Arguments[0] -eq 'ps'){return [pscustomobject]@{Success=$true;Value=$script:containerIds}}
    if($Arguments[0] -eq 'inspect'){return [pscustomobject]@{Success=$script:metadataOk;Value=(@{'com.docker.compose.project.working_dir'=$script:directory}|ConvertTo-Json -Compress)}}
    throw 'Unexpected ownership probe'
}
Assert-SynkProjectOwnership;Check $true 'Empty project accepted'
$script:containerIds='abcdef123456'
Assert-SynkProjectOwnership;Check $true 'Same installation accepted'
$script:directory=Join-Path (Split-Path -Parent $root) 'other-installation'
$failed=$false;try{Assert-SynkProjectOwnership}catch{$failed=$true};Check $failed 'Other installation would be overwritten'
$script:directory='';$failed=$false;try{Assert-SynkProjectOwnership}catch{$failed=$true};Check $failed 'Unknown project directory accepted'
$script:metadataOk=$false;$failed=$false;try{Assert-SynkProjectOwnership}catch{$failed=$true};Check $failed 'Inspection failure allowed replacement'
$script:containerIds='not-a-container-id';$failed=$false;try{Assert-SynkProjectOwnership}catch{$failed=$true};Check $failed 'Invalid Docker ID accepted'
Write-Host ('PASS: ' + $count + ' installation ownership checks')
