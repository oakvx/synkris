Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if(-not $Condition){throw $Message};$script:count++ }
function Rejected([scriptblock]$Action,[string]$Message) { $bad=$false;try{& $Action}catch{$bad=$true};Check $bad $Message }
$script:state='ready';$script:ownershipCalls=0;$script:foreign=$false
function Get-SynkDockerState { return $script:state }
function Assert-SynkProjectOwnership { $script:ownershipCalls++;if($script:foreign){throw 'Foreign project folder'} }
foreach($state in @('missing_cli','missing_compose','remote_context','context_unavailable','windows_engine','starting')) {
    $script:state=$state
    Rejected {Assert-Docker} 'Unsafe context reached a legacy technical operation'
    Check ($script:ownershipCalls -eq 0) 'Project queried before local daemon ready'
}
$script:state='ready';Assert-Docker
Check ($script:ownershipCalls -eq 1) 'Technical operations skipped project ownership'
$script:foreign=$true
Rejected {Assert-Docker} 'Technical operation accepted containers from another root'
Check ($script:ownershipCalls -eq 2) 'Foreign ownership was not checked'
Write-Host ('PASS: ' + $count + ' common technical-operation local-context/ownership guards; Docker mocked')
