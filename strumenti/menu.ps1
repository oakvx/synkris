# Library: requires configurazione.ps1. Selection alone has no side effects.
function Select-SynkTool {
    Write-Host "`nsynk - UN SOLO PUNTO DI PARTENZA"
    Write-Host '1) Installa o riprendi la configurazione guidata (Invio)'
    Write-Host '2) Avvia synk e apri la dashboard'
    Write-Host '3) Diagnostica offline, senza mostrare segreti'
    Write-Host '4) Visualizza/copia la password dashboard in finestra locale'
    Write-Host '5) Crea report assistenza locale, senza log grezzi o dati cliente'
    Write-Host '6) Attiva avvio automatico dopo accesso Windows (facoltativo)'
    Write-Host '7) Disattiva il nostro avvio automatico'
    Write-Host '8) Rifai il file iniziale con backup (SOLO prima del primo import)'
    Write-Host '9) Correggi un file privato errato (SOLO prima del primo import)'
    Write-Host '0) Esci senza avviare nulla'
    $choice = Read-SynkText 'Scegli' '1' '^[0-9]$'
    $actions = @{'0'='exit';'1'='install';'2'='start';'3'='doctor';'4'='access';'5'='support';'6'='autostart-on';'7'='autostart-off';'8'='reconfigure';'9'='credentials'}
    return $actions[$choice]
}
