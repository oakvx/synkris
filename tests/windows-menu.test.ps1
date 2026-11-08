Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/configurazione.ps1')
. (Join-Path $root 'strumenti/menu.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
$script:answers=New-Object 'System.Collections.Generic.Queue[string]'
function Read-Host { param([string]$Prompt) if($script:answers.Count -eq 0){throw 'Missing menu fixture answer'};return $script:answers.Dequeue() }
foreach($pair in @(@('','install'),@('0','exit'),@('2','start'),@('3','doctor'),@('4','access'),@('5','support'),@('6','autostart-on'),@('7','autostart-off'),@('8','reconfigure'),@('9','credentials'))){
    $script:answers.Enqueue($pair[0]);Check ((Select-SynkTool) -eq $pair[1]) 'Wrong menu mapping'
}
$script:answers.Enqueue('10');$script:answers.Enqueue('0');Check ((Select-SynkTool) -eq 'exit') 'Invalid menu option accepted'
Write-Host ('PASS: ' + $count + ' launcher menu checks; no operations executed')
