# Library: load common.ps1 first. No Docker or Node is required by this wizard.
function Read-SynkText {
    param([string]$Prompt, [string]$Default = '', [string]$Pattern = '^[^\x00-\x1f\x7f]{1,120}$', [switch]$AllowEmpty)
    while ($true) {
        $suffix = if ($Default) { ' [' + $Default + ']' } else { '' }
        $value = (Read-Host ($Prompt + $suffix)).Trim()
        if (-not $value) { $value = $Default }
        if (($AllowEmpty -and -not $value) -or $value -match $Pattern) { return $value }
        Write-Warning 'Valore non valido: riprova. Ctrl+C annulla senza avviare i servizi.'
    }
}
function Read-SynkInteger([string]$Prompt, [int]$Minimum, [int]$Maximum, [int]$Default) {
    while ($true) {
        $raw = Read-SynkText $Prompt ([string]$Default) '^\d{1,9}$'
        $value = 0
        if ([int]::TryParse($raw, [ref]$value) -and $value -ge $Minimum -and $value -le $Maximum) { return $value }
        Write-Warning ('Inserisci un intero da ' + $Minimum + ' a ' + $Maximum + '.')
    }
}
function Read-SynkMoney([string]$Prompt) {
    while ($true) {
        $raw = (Read-Host ($Prompt + ' [0; es. 25,50]')).Trim()
        if (-not $raw) { $raw = '0' }
        $value = [decimal]0
        if ([decimal]::TryParse($raw.Replace(',','.'), [Globalization.NumberStyles]::AllowDecimalPoint, [Globalization.CultureInfo]::InvariantCulture, [ref]$value) -and $value -ge 0 -and $value -le 9999999 -and [decimal]::Round($value,2) -eq $value) { return $value }
        Write-Warning 'Prezzo non valido: usa euro e al massimo due decimali, senza separatori delle migliaia.'
    }
}
function Read-SynkSelection([string]$Prompt, [int]$Maximum, [string]$Default) {
    while ($true) {
        $raw = Read-SynkText $Prompt $Default '^[0-9,; ]+$'
        $numbers = @($raw -split '[,;\s]+' | Where-Object { $_ -ne '' })
        $selected = New-Object 'System.Collections.Generic.HashSet[int]'
        $valid = $numbers.Count -gt 0
        foreach ($number in $numbers) {
            $value = 0
            if (-not [int]::TryParse($number,[ref]$value) -or $value -lt 1 -or $value -gt $Maximum) { $valid = $false; break }
            [void]$selected.Add($value)
        }
        if ($valid) { return @($selected | Sort-Object) }
        Write-Warning ('Seleziona numeri da 1 a ' + $Maximum + ', separati da virgole.')
    }
}
function Read-SynkTimePair([string]$Label, [string]$DefaultOpen = '09:00', [string]$DefaultClose = '18:00') {
    $pattern = '^(?:[01]\d|2[0-3]):[0-5]\d$'
    $open = Read-SynkText ($Label + ' - apertura HH:mm') $DefaultOpen $pattern
    do {
        $close = Read-SynkText ($Label + ' - chiusura HH:mm') $DefaultClose $pattern
        if ($close -le $open) { Write-Warning 'La chiusura deve essere successiva all''apertura; niente turni oltre mezzanotte.' }
    } while ($close -le $open)
    return @($open,$close)
}
function New-SynkSalonConfiguration {
    Write-Host "`nCONFIGURAZIONE GUIDATA - i dati rimangono su questo PC."
    $salonName = Read-SynkText 'Nome del salone' 'Salone' '^[^\x00-\x1f\x7f]{1,80}$'
    $professionals = [ordered]@{}
    $emails = New-Object 'System.Collections.Generic.List[string]'
    $count = Read-SynkInteger 'Quante persone nel team?' 1 100 1
    for ($i = 1; $i -le $count; $i++) {
        $name = Read-SynkText ('Nome persona ' + $i)
        do {
            $email = Read-SynkText ('Email calendario persona ' + $i) '' '^(?=.{1,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$'
            $duplicate = @($emails | Where-Object { $_ -ieq $email }).Count -gt 0
            $demo = $email -match '@(?:example\.(?:com|org|net)|invalid|test)$'
            if ($duplicate -or $demo) { Write-Warning 'Usa un indirizzo reale e diverso da quelli gia inseriti.' }
        } while ($duplicate -or $demo)
        $professionals[$email] = @{name=$name}; $emails.Add($email)
    }
    $services = [ordered]@{}
    $count = Read-SynkInteger 'Quanti trattamenti iniziali? Potrai aggiungerne dalla dashboard' 1 500 1
    for ($i = 1; $i -le $count; $i++) {
        do {
            $name = Read-SynkText ('Nome trattamento ' + $i)
            $invalid = $services.Contains($name) -or $name -in @('__proto__','prototype','constructor')
            if ($invalid) { Write-Warning 'Usa un nome univoco e non riservato.' }
        } while ($invalid)
        $minutes = Read-SynkInteger 'Durata in minuti, senza buffer' 1 960 30
        $price = Read-SynkMoney 'Prezzo in euro'
        for ($p = 0; $p -lt $emails.Count; $p++) { Write-Host (($p + 1).ToString() + ') ' + $professionals[$emails[$p]].name) }
        $all = (1..$emails.Count) -join ','
        $selected = @(Read-SynkSelection 'Chi puo eseguire questo trattamento?' $emails.Count $all)
        $assigned = @($selected | ForEach-Object { $emails[$_ - 1] })
        $services[$name] = @{durationMin=$minutes;price=$price;professionals=$assigned;synonyms=@()}
    }
    Write-Host 'Giorni: 1 lunedi, 2 martedi, 3 mercoledi, 4 giovedi, 5 venerdi, 6 sabato, 7 domenica.'
    $openDays = @(Read-SynkSelection 'Giorni di apertura' 7 '1,2,3,4,5,6')
    $standard = @(Read-SynkTimePair 'Orario abituale')
    $pause = $null
    $pattern = '^(?:[01]\d|2[0-3]):[0-5]\d$'
    do {
        $pauseStart = Read-SynkText 'Inizio pausa HH:mm (Invio = nessuna pausa)' '' $pattern -AllowEmpty
        $validPause = -not $pauseStart -or ($pauseStart -ge $standard[0] -and $pauseStart -lt $standard[1])
        if (-not $validPause) { Write-Warning 'La pausa deve iniziare durante l''apertura.' }
    } while (-not $validPause)
    if ($pauseStart) {
        do {
            $pauseEnd = Read-SynkText 'Fine pausa HH:mm' '14:00' $pattern
            $validPause = $pauseEnd -gt $pauseStart -and $pauseEnd -le $standard[1]
            if (-not $validPause) { Write-Warning 'La pausa deve finire dopo il suo inizio e non oltre la chiusura.' }
        } while (-not $validPause)
        $pause = @($pauseStart,$pauseEnd)
    }
    $hours = [ordered]@{}; $breaks = [ordered]@{}
    foreach ($weekday in $openDays) {
        $spec = $standard
        if ($weekday -eq 6) { $spec = @(Read-SynkTimePair 'Sabato' $standard[0] '13:00') }
        $key = [string]$weekday; $hours[$key] = @($spec)
        if ($null -ne $pause -and $pause[0] -ge $spec[0] -and $pause[1] -le $spec[1]) { $breaks[$key] = @($pause) }
    }
    $closed = @(1..7 | Where-Object { $_ -notin $openDays })
    return [ordered]@{salonName=$salonName;professionals=$professionals;services=$services;businessHours=$hours;closedDays=$closed;lunchBreaks=$breaks;unavailability=@{}}
}
function Initialize-SynkSalonConfiguration {
    $destination = Join-Path $script:SynkRoot 'setup/config.json'
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        Write-Host 'Configurazione iniziale gia presente: non viene sovrascritta.'
        return
    }
    $config = New-SynkSalonConfiguration
    Write-Host ('Riepilogo: ' + $config.professionals.Count + ' persone, ' + $config.services.Count + ' trattamenti, ' + $config.businessHours.Count + ' giorni aperti.')
    if ((Read-SynkText 'Salvare? S/N' 'S' '^[sSnN]$') -ine 'S') { throw 'Configurazione annullata: nessun file salvato.' }
    Write-SynkPrivateFile $destination (($config | ConvertTo-Json -Depth 12) + "`n")
    Write-Host 'Configurazione salvata. Dopo il primo import si modifica dalla dashboard.'
}
