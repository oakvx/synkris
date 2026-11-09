param([string]$Model = 'qwen2.5:3b')
. (Join-Path $PSScriptRoot 'common.ps1')
$mutex=$null
try {
    Assert-Docker
    $mutex=Enter-SynkMaintenance
    if ($Model -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,120}$') { throw 'Nome modello non valido.' }
    if (-not (Test-Path -LiteralPath (Join-Path $script:SynkRoot '.env'))) { throw 'Completa prima INSTALLA_SYNK.' }
    Write-Host ('Scaricamento del modello locale ' + $Model + '. Richiede Internet, RAM e spazio disco; nessun dato cliente viene inviato al registro modelli.')
    if ((Read-Host 'Digita ATTIVA per procedere') -cne 'ATTIVA') { throw 'Attivazione annullata.' }
    Invoke-Compose -Arguments @('--profile','ai','up','-d','ollama')
    Invoke-Compose -Arguments @('exec','-T','ollama','ollama','pull',$Model)
    Set-EnvValue 'OLLAMA_URL' 'http://ollama:11434'
    Set-EnvValue 'OLLAMA_MODEL' $Model
    Set-EnvValue 'OLLAMA_INTENT_MODEL' $Model
    Set-EnvValue 'AI_ENABLED' '1'
    Set-EnvValue 'AI_INTENT_ENABLED' '1'
    Invoke-Compose -Arguments @('up','-d','bot')
    Wait-SynkHealth
    Write-Host 'AI locale configurata. Verifica diagnostica e fallback con modello non disponibile. Multi-booking resta invariato.'
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
finally { Exit-SynkMaintenance $mutex }
