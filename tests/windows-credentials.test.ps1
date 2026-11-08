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
    $original=Join-Path $temp 'original.txt'
    Write-Utf8File $original "LIC=eyJmaXh0dXJlIjp0cnVlfQ`nSIG=Zml4dHVyZQ`n"
    Import-SynkCredential -Name 'license.txt' -Source $original
    $dest=Join-Path $temp 'secrets/license.txt'
    $before=[IO.File]::ReadAllText($dest)
    Check ($before -match '^LIC=') 'Original license imported'
    Write-Utf8File $original 'must never replace existing license'
    Import-SynkCredential -Name 'license.txt' -Source $original
    Check ([IO.File]::ReadAllText($dest) -ceq $before) 'Existing license must be preserved'
    Remove-Item -LiteralPath $dest -Force
    Rejected {Import-SynkCredential -Name 'license.txt' -Source $original} 'Malformed license accepted'
    Check (-not (Test-Path -LiteralPath $dest)) 'Rejected license created a file'
    Write-Utf8File $original "LIC=aaaa`nLIC=bbbb`nSIG=cccc`n"
    Rejected {Import-SynkCredential -Name 'license.txt' -Source $original} 'Duplicate LIC accepted'
    Write-Utf8File $original 'not a public key'
    Rejected {Import-SynkCredential -Name 'license-public.pem' -Source $original} 'Invalid public PEM accepted'
    Write-Utf8File $original ('-----BEGIN ' + 'PRIVATE KEY-----' + "`nZmFrZQ==`n" + '-----END ' + 'PRIVATE KEY-----')
    Rejected {Import-SynkCredential -Name 'license-public.pem' -Source $original} 'Private key accepted as public'
    Write-Utf8File $original '{bad json with sensitive-synthetic-marker}'
    $message='';try{Import-SynkCredential -Name 'google-service-account.json' -Source $original}catch{$message=$_.Exception.Message}
    Check ($message -notmatch 'sensitive-synthetic-marker' -and $message -match 'JSON') 'Malformed JSON must be redacted'
    Write-Utf8File $original '{"type":"authorized_user"}'
    Rejected {Import-SynkCredential -Name 'google-service-account.json' -Source $original} 'Wrong Google credential type accepted'
    Write-Utf8File $original ('x' * 65537)
    Rejected {Import-SynkCredential -Name 'license.txt' -Source $original} 'Oversized private file accepted'
    Rejected {Import-SynkCredential -Name 'license.txt' -Source $temp} 'Directory accepted as credential'
} finally { $script:SynkRoot=$oldRoot;Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Host ('PASS: ' + $count + ' private credential import checks')
