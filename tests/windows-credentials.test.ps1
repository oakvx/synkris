Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'strumenti/common.ps1')
. (Join-Path $root 'strumenti/credenziali.ps1')
$count=0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:count++ }
function Rejected([scriptblock]$Action,[string]$Message) { $bad=$false;try{& $Action}catch{$bad=$true};Check $bad $Message }
$temp=Join-Path ([IO.Path]::GetTempPath()) ('synk-credentials-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
$oldRoot=$script:SynkRoot;$script:SynkRoot=$temp
try {
    $original=Join-Path $temp 'original.json'
    $fixture=@{type='service_account';client_email='synthetic@ci.iam.gserviceaccount.com';private_key=('-----BEGIN ' + 'PRIVATE KEY-----' + "`nsynthetic")}
    Write-Utf8File $original ($fixture | ConvertTo-Json)
    Import-SynkCredential -Source $original
    $dest=Join-Path $temp 'secrets/google-service-account.json'
    $before=[IO.File]::ReadAllText($dest)
    Check (($before | ConvertFrom-Json).type -eq 'service_account') 'Original Google credentials imported'
    Write-Utf8File $original 'must never replace existing credentials'
    Import-SynkCredential -Source $original
    Check ([IO.File]::ReadAllText($dest) -ceq $before) 'Existing credentials must be preserved'
    Check (-not (Test-Path -LiteralPath (Join-Path $temp 'secrets/license.txt'))) 'Importer created an obsolete activation file'
    Remove-Item -LiteralPath $dest -Force
    Rejected {Import-SynkCredential -Source $original} 'Malformed credentials accepted'
    Check (-not (Test-Path -LiteralPath $dest)) 'Rejected credentials created a file'
    Write-Utf8File $original '{bad json with sensitive-synthetic-marker}'
    $message='';try{Import-SynkCredential -Source $original}catch{$message=$_.Exception.Message}
    Check ($message -notmatch 'sensitive-synthetic-marker' -and $message -match 'JSON') 'Malformed JSON must be redacted'
    foreach($invalid in @('{"type":"authorized_user"}','null','[]','{"type":"service_account"}')) {
        Write-Utf8File $original $invalid
        Rejected {Import-SynkCredential -Source $original} 'Wrong Google credential type accepted'
    }
    Write-Utf8File $original ('x' * 65537)
    Rejected {Import-SynkCredential -Source $original} 'Oversized private file accepted'
    Rejected {Import-SynkCredential -Source $temp} 'Directory accepted as credential'
    Rejected {Import-SynkCredential -Name 'license.txt' -Source $original} 'Obsolete activation importer still exposed'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' Google-only private credential import checks')
