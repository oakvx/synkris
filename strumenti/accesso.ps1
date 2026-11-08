# Local-only credential window. Never print passwords, put them in URLs or
# process arguments, persist them in reports, or copy without an explicit click.
function Show-SynkAccess {
    if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') { throw 'Apri lo strumento dal launcher Windows PowerShell, non da una sessione MTA.' }
    $password = Get-EnvValue 'DASHBOARD_PASSWORD'
    if ($password.Length -lt 12 -or $password.Length -gt 512 -or $password -match '^SOSTITUISCI') { throw 'Password dashboard non configurata: completa INSTALLA_UNA_VOLTA.' }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $window = New-Object Windows.Forms.Form
    $window.Text = 'synk - accesso alla dashboard'; $window.ClientSize = New-Object Drawing.Size(560,345)
    $window.StartPosition = 'CenterScreen'; $window.FormBorderStyle = 'FixedDialog'
    $window.MaximizeBox = $false; $window.MinimizeBox = $false
    $window.Font = New-Object Drawing.Font('Segoe UI',10)
    $title = New-Object Windows.Forms.Label
    $title.Text = 'Accedi alla tua dashboard'; $title.Location = New-Object Drawing.Point(20,18); $title.Size = New-Object Drawing.Size(520,30)
    $description = New-Object Windows.Forms.Label
    $description.Text = 'Questa e la password gia salvata su questo PC. Conservala nel tuo gestore password. Non viene ruotata o inviata a nessuno.'
    $description.Location = New-Object Drawing.Point(20,52); $description.Size = New-Object Drawing.Size(520,50)
    $field = New-Object Windows.Forms.TextBox
    $field.Text = $password; $field.ReadOnly = $true; $field.UseSystemPasswordChar = $true
    $field.Location = New-Object Drawing.Point(20,115); $field.Size = New-Object Drawing.Size(340,30)
    $copy = New-Object Windows.Forms.Button
    $copy.Text = 'Copia password'; $copy.Location = New-Object Drawing.Point(373,113); $copy.Size = New-Object Drawing.Size(167,32)
    $reveal = New-Object Windows.Forms.CheckBox
    $reveal.Checked = $false
    $reveal.Text = 'Mostra password su questo schermo'; $reveal.AutoSize = $true; $reveal.Location = New-Object Drawing.Point(20,155)
    $reveal.Add_CheckedChanged({ $field.UseSystemPasswordChar = -not $reveal.Checked }.GetNewClosure())
    $status = New-Object Windows.Forms.Label
    $status.Text = 'Copia solo se questo PC e fidato. Apri il browser, incolla la password e poi chiudi questa finestra.'
    $status.Location = New-Object Drawing.Point(20,238); $status.Size = New-Object Drawing.Size(520,45)
    $warning = New-Object Windows.Forms.Label
    $warning.Text = 'Alla chiusura libero gli appunti se contengono ancora questa password. La cronologia appunti e la sincronizzazione cloud di Windows NON vengono cancellate.'
    $warning.Location = New-Object Drawing.Point(20,287); $warning.Size = New-Object Drawing.Size(520,56)
    $copied = [pscustomobject]@{Value=$false}
    $copy.Add_Click({
        try {
            [Windows.Forms.Clipboard]::SetText($field.Text)
            $copied.Value = $true; $status.Text = 'Copiata. Incollala nella dashboard mentre questa finestra resta aperta; poi chiudi.'
        } catch { $status.Text = 'Appunti non disponibili. Puoi mostrare la password e inserirla manualmente.' }
    }.GetNewClosure())
    $open = New-Object Windows.Forms.Button
    $open.Text = 'Apri dashboard nel browser'; $open.Location = New-Object Drawing.Point(20,194); $open.Size = New-Object Drawing.Size(310,33)
    $open.Add_Click({ Start-Process 'http://127.0.0.1:8080/' }.GetNewClosure())
    $close = New-Object Windows.Forms.Button
    $close.Text = 'Chiudi'; $close.Location = New-Object Drawing.Point(373,194); $close.Size = New-Object Drawing.Size(167,33)
    $close.Add_Click({ $window.Close() }.GetNewClosure())
    $window.CancelButton = $close
    foreach ($control in @($title,$description,$field,$copy,$reveal,$status,$warning,$open,$close)) { $window.Controls.Add($control) }
    try { [void]$window.ShowDialog() }
    finally {
        if ($copied.Value) {
            try { if ([Windows.Forms.Clipboard]::ContainsText() -and [Windows.Forms.Clipboard]::GetText() -ceq $password) { [Windows.Forms.Clipboard]::Clear() } } catch { }
        }
        $field.Text = ''; $password = $null; $window.Dispose()
    }
}
