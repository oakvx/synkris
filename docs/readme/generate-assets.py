#!/usr/bin/env python3
"""Generate the self-contained SVG artwork used by README.md (standard library only)."""
from html import escape
from pathlib import Path
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parents[1] / 'assets'
OUT.mkdir(parents=True, exist_ok=True)
INK = '#203e33'
GREEN = '#216353'
MINT = '#d6efdf'
CREAM = '#f4f2e9'
MUTED = '#718277'
BORDER = '#dae3d8'
DARK = '#102b25'
WHITE = '#ffffff'
AMBER = '#9b6425'


def text(x, y, value, size=18, fill=INK, weight=400, extra=''):
    return f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" font-weight="{weight}" {extra}>{escape(value)}</text>'


def lines(x, y, values, size=18, fill=INK, weight=400, step=28):
    return ''.join(text(x, y + i * step, value, size, fill, weight) for i, value in enumerate(values))


def rect(x, y, w, h, fill, radius=18, stroke='none'):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'


def pill(x, y, w, label, fill=MINT, color=GREEN):
    return rect(x, y, w, 30, fill, 15) + text(x + 14, y + 20, label, 11, color, 650)


def icon(kind, x, y, color=GREEN, size=32):
    drawings = {
        'calendar': '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h3m3 0h2"/>',
        'chat': '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/><path d="M8 9h8m-8 5h5"/>',
        'shield': '<path d="m12 2 8 3v6c0 5-4 9-8 11-4-2-8-6-8-11V5l8-3Z"/><path d="m8 12 3 3 5-6"/>',
        'database': '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
        'sync': '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
        'team': '<circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m1-18a4 4 0 0 1 0 8m2 4a6 6 0 0 1 3 5"/>',
        'box': '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5M12 12 3 7m9 5v10M7 4l9 5"/>',
        'code': '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
        'check': '<path d="m5 12 4 4L20 5"/>',
        'lock': '<rect x="4" y="10" width="16" height="12" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3"/>',
        'cloud': '<path d="M7 19a5 5 0 1 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1-1 12H7Z"/>',
        'screen': '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 22h8m-4-5v5"/>',
    }
    return f'<g transform="translate({x} {y}) scale({size / 24})" fill="none" stroke="{color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{drawings[kind]}</g>'


def save(name, title, description, width, height, body):
    source = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">
<title id="title">{escape(title)}</title><desc id="desc">{escape(description)}</desc>
<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity=".035"/></pattern><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="m0 0 8 4-8 4" fill="none" stroke="#749285" stroke-width="1.5"/></marker></defs>
<g font-family="Inter, Segoe UI, Arial, sans-serif">{body}</g>
</svg>\n'''
    ET.fromstring(source)
    (OUT / name).write_text(source, encoding='utf-8')


# Hero: original vector artwork, not a screenshot or a live-service status report.
b = rect(0, 0, 1280, 560, DARK, 24)
b += '<rect width="1280" height="560" rx="24" fill="url(#grid)"/>'
b += '<circle cx="1130" cy="130" r="270" fill="none" stroke="#91c4a2" stroke-opacity=".09"/><circle cx="1130" cy="130" r="210" fill="none" stroke="#91c4a2" stroke-opacity=".09"/>'
b += rect(64, 50, 52, 52, GREEN, 16)
b += '<g transform="translate(64 50) scale(.8125)"><path d="M19 23c0-4 4-7 9-7h16v8H28c-1 0-2 1-2 2s1 2 2 2h9c7 0 11 4 11 10s-5 10-12 10H20v-8h16c2 0 3-1 3-2s-1-2-3-2h-8c-6 0-9-5-9-13Z" fill="#f4f2e9"/></g>'
b += text(132, 89, 'synk', 43, CREAM, 700, 'letter-spacing="-2"')
b += text(65, 159, 'IL TUO SALONE. UN SOLO RITMO.', 12, '#98baa7', 650, 'letter-spacing="2"')
b += lines(60, 244, ['Meno incastri.', 'Più tempo per le persone.'], 50, CREAM, 650, 67)
b += lines(64, 376, ['Appuntamenti, team e conversazioni.', 'Un core locale. Integrazioni sotto controllo.'], 20, '#b9cfc0', 400, 32)
b += pill(64, 466, 172, '1.2.0-rc.6 · COLLAUDO', '#28463a', '#d8f0de')
b += pill(248, 466, 194, 'LICENZA PROPRIETARIA', '#4b402b', '#f1dba9')
b += text(64, 530, 'Uso privato non commerciale gratuito. Altri usi: accordo commerciale.', 13, '#b9cfc0')
# Illustration on the right deliberately avoids claiming a real provider is connected.
b += rect(808, 124, 410, 340, '#193c31', 24, '#41634e')
b += text(835, 160, 'UNA GIORNATA, CON CURA', 11, '#a8c8b3', 600, 'letter-spacing="1.4"')
b += pill(1095, 143, 97, 'ILLUSTRAZIONE', '#294c3c', '#c6dfcb')
for y, when, service, duration, key in [(191, '09:00', 'Manicure', '45 min + 10 di buffer', 'calendar'), (292, '10:30', 'Trattamento viso', '60 min + 10 di buffer', 'team')]:
    b += rect(831, y, 365, 86, CREAM, 14)
    b += text(848, y + 30, when, 15, GREEN, 650)
    b += text(924, y + 30, service, 16, INK, 650)
    b += text(924, y + 56, duration, 12, MUTED)
    b += icon(key, 852, y + 43, GREEN, 18)
b += icon('sync', 838, 410, '#b9d8bf', 24)
b += text(874, 429, 'Salvato nel DB ≠ sincronizzato su Google', 12, '#c5dbc8')
save('hero.svg', 'synk — Meno incastri. Più tempo per le persone.', 'Gestione locale degli appuntamenti per saloni, con dashboard, team e integrazioni. RC6 solo collaudo, licenza proprietaria: uso privato non commerciale gratuito, altri usi su accordo commerciale. La parte destra è un’illustrazione.', 1280, 560, b)

# Locally hosted technology badges: factual, not fake live CI badges.
b = ''
for index, (label, value, key) in enumerate([
    ('NODE.JS', '22 / 24', 'code'), ('PHP', '8.3', 'code'), ('POSTGRESQL', '16', 'database'),
    ('DEPLOY', 'Docker + WSL2', 'box'), ('AI LOCALE', 'facoltativa', 'chat'), ('STATO', 'release candidate', 'shield'),
]):
    x = index * 214
    b += rect(x, 10, 202, 84, '#f5f7f1', 13, BORDER)
    b += icon(key, x + 17, 35, GREEN, 24)
    b += text(x + 54, 40, label, 10, MUTED, 650, 'letter-spacing=".8"')
    b += text(x + 54, 66, value, 15, INK, 600)
save('stack.svg', 'Lo stack di synk', 'Node.js 22 e 24, PHP 8.3, PostgreSQL 16, Docker con WSL2 per Windows, AI locale opzionale. Versione release candidate.', 1280, 106, b)

# Capability cards.
b = rect(0, 0, 1280, 480, CREAM, 22)
b += text(44, 55, 'Una console. Quattro punti fermi.', 29, INK, 650)
features = [
    ('calendar', 'Agenda con contesto', ['Servizi ordinati, durate per operatrice,', 'buffer, orari, chiusure e assenze.']),
    ('sync', 'Stati che non ingannano', ['Database e Google non sono la stessa cosa.', 'In coda, sincronizzato e da verificare restano distinti.']),
    ('chat', 'Il team resta al comando', ['Conversazioni e presa in carico manuale.', 'AI locale opzionale, disattivata per default.']),
    ('shield', 'Manutenzione esplicita', ['Aggiornamenti con checksum e manifest.', 'Dopo un restore, riconciliazione umana prima di ripartire.']),
]
for i, (key, heading, desc) in enumerate(features):
    x = 34 + (i % 2) * 612
    y = 82 + (i // 2) * 190
    b += rect(x, y, 588, 172, WHITE, 16, BORDER)
    b += rect(x + 20, y + 22, 43, 43, '#eaf2e6', 12)
    b += icon(key, x + 29, y + 31, GREEN, 25)
    b += text(x + 82, y + 50, heading, 21, INK, 650)
    b += lines(x + 24, y + 99, desc, 15, MUTED, 400, 25)
save('features.svg', 'Le capacità principali di synk', 'Agenda normalizzata, stati Calendar espliciti, presa in carico delle chat e manutenzione con riconciliazione. Queste capacità non sostituiscono il collaudo dei provider reali.', 1280, 480, b)

# Architecture: the diagram explicitly separates the local system and external providers.
b = rect(0, 0, 1280, 740, '#f7f8f3', 22)
b += text(40, 52, 'Locale dove serve. Esplicito quando esce.', 29, INK, 650)
b += text(42, 83, 'PostgreSQL è la fonte dei dati; Google e WhatsApp restano servizi esterni.', 16, MUTED)
b += rect(32, 114, 902, 578, '#edf3e9', 22, '#c9d8c7')
b += text(58, 147, 'PC DEL SALONE / DOCKER · CONTAINER LINUX', 11, GREEN, 650, 'letter-spacing="1"')
b += rect(58, 184, 250, 105, WHITE, 15, BORDER)
b += icon('screen', 76, 204, GREEN, 29)
b += text(119, 215, 'Browser', 21, INK, 650)
b += text(119, 245, 'Accesso alla dashboard', 13, MUTED)
b += rect(365, 184, 282, 105, WHITE, 15, BORDER)
b += icon('shield', 385, 203, GREEN, 28)
b += text(430, 215, 'PHP 8.3', 21, INK, 650)
b += lines(430, 244, ['Login, sessione e CSRF', 'Editor e proxy con allowlist'], 13, MUTED, 400, 20)
b += rect(365, 352, 282, 119, WHITE, 15, BORDER)
b += icon('database', 385, 373, GREEN, 28)
b += text(430, 386, 'PostgreSQL 16', 21, INK, 650)
b += lines(430, 415, ['Appuntamenti e catalogo', 'Outbox nella stessa transazione'], 13, MUTED, 400, 21)
b += rect(365, 535, 282, 119, WHITE, 15, BORDER)
b += icon('code', 385, 557, GREEN, 28)
b += text(430, 570, 'Node.js + bot', 20, INK, 650)
b += lines(430, 600, ['whatsapp-web.js · LocalAuth', 'Calendar, worker e API interne'], 13, MUTED, 400, 21)
b += rect(58, 373, 250, 126, WHITE, 15, BORDER)
b += icon('lock', 78, 395, GREEN, 27)
b += text(121, 408, 'File riservati', 20, INK, 650)
b += lines(80, 445, ['Config, sessioni e credenziali', 'fuori da Git e dagli ZIP.'], 13, MUTED, 400, 22)
b += rect(58, 545, 250, 109, WHITE, 15, BORDER)
b += icon('chat', 78, 565, GREEN, 27)
b += text(121, 578, 'Ollama', 20, INK, 650)
b += text(80, 613, 'Locale · opzionale · default OFF', 13, MUTED)
# External boundary.
b += rect(968, 114, 280, 578, '#f8f1e4', 22, '#e9d9b9')
b += text(990, 147, 'PROVIDER ESTERNI', 11, AMBER, 650, 'letter-spacing="1"')
for y, title, desc in [(208, 'Google Calendar', ['Verifica disponibilità', 'Eventi e sincronizzazione']), (377, 'WhatsApp', ['WhatsApp Web (non ufficiale)', 'Conversazioni e sessione']), (546, 'SMTP', ['Solo su opt-in', 'Avvisi tecnici configurati'])]:
    b += rect(989, y, 237, 114, WHITE, 14, '#eadfc9')
    b += icon('cloud', 1007, y + 20, AMBER, 25)
    b += text(1045, y + 39, title, 18, INK, 650)
    b += lines(1009, y + 70, desc, 12, MUTED, 400, 20)
# Local and external paths (no implication of distributed ACID or official Meta integration).
for d in ['M308 233H358', 'M506 289V345', 'M506 471V528', 'M647 582H723V270H982', 'M723 446H982', 'M647 620H982', 'M308 591H358']:
    b += f'<path d="{d}" fill="none" stroke="#749285" stroke-width="2" marker-end="url(#arrow)"/>'
b += '<path d="M647 235H851V554H654" fill="none" stroke="#749285" stroke-width="2" stroke-dasharray="5 5" marker-end="url(#arrow)"/>'
b += text(664, 223, 'proxy / gate Calendar', 11, MUTED)
b += text(756, 691, 'schema semplificato', 11, MUTED)
b += text(42, 724, 'La collocazione locale del database non impedisce l’invio di dati necessario alle integrazioni esterne.', 13, MUTED)
save('architecture.svg', 'Architettura di synk e confine dei dati', 'Sul PC del salone: browser, PHP, PostgreSQL, Node/whatsapp-web.js, file riservati e Ollama opzionale. PHP accede al database e al gate Node; il worker usa l’outbox. Google Calendar, WhatsApp e SMTP sono esterni. Il disegno è semplificato e non rappresenta una transazione distribuita.', 1280, 740, b)

# Booking flow, including the important negative guarantee.
b = rect(0, 0, 1280, 334, DARK, 22)
b += text(40, 51, 'Una prenotazione non è solo un pulsante «Salva».', 27, CREAM, 600)
steps = [
    ('01', 'Scegli', ['Cliente, operatrice, servizi.', 'Durate e buffer lato server.']),
    ('02', 'Verifica', ['Orari, vincoli e Calendar.', 'Provider non disponibile? Stop.']),
    ('03', 'Registra', ['Appuntamento + outbox', 'nella transazione PostgreSQL.']),
    ('04', 'Sincronizza', ['Il worker aggiorna Google.', 'Gli esiti restano visibili.']),
]
for i, (number, title, desc) in enumerate(steps):
    x = 40 + i * 310
    b += rect(x, 86, 270, 163, '#1b3d31', 15, '#3b5a47')
    b += text(x + 20, 119, number, 13, '#9fc5a8', 650)
    b += text(x + 20, 154, title, 24, CREAM, 600)
    b += lines(x + 20, 190, desc, 13, '#bdd0bf', 400, 23)
    if i < 3:
        b += f'<path d="M{x + 278} 166h21" stroke="#749285" fill="none" stroke-width="2" marker-end="url(#arrow)"/>'
b += text(40, 290, 'IN CODA ≠ SINCRONIZZATO', 12, '#e8d2a1', 650, 'letter-spacing="1"')
b += text(338, 290, 'La transazione locale non è una transazione ACID con Google: può servire riconciliazione.', 14, '#bdd0bf')
save('booking-flow.svg', 'Il flusso di una prenotazione', 'Scelta dei servizi, verifiche fail-closed, transazione locale con outbox e sincronizzazione asincrona. Un salvataggio in coda non è ancora un successo su Google.', 1280, 334, b)

# Honest status strip. It is explicitly a dated snapshot, not a live badge.
b = rect(0, 0, 1280, 328, CREAM, 22)
b += text(40, 51, 'Verifiche verdi. Nessun via libera automatico.', 29, INK, 650)
b += text(42, 83, '8 novembre 2026 · milestone a7deb3d · audit del lockfile migrato · nessun badge live', 14, MUTED)
status = [
    ('check', 'TEST NODE', '242 test Node', 'CI a7deb3d: 6/6 · controlla il tuo ref', GREEN, '#e6efe3'),
    ('lock', 'DIRITTI D’USO', 'Proprietari', 'Nessuna attivazione tecnica richiesta', AMBER, '#f7ead3'),
    ('shield', 'DIPENDENZE', '11 rilievi elevati', '19 totali · 0 critici nell’audit', AMBER, '#f7ead3'),
    ('calendar', 'USO REALE', 'Collaudo richiesto', 'Provider, recovery e PC del salone', AMBER, '#f7ead3'),
]
for i, (key, label, value, note, color, fill) in enumerate(status):
    x = 30 + i * 313
    b += rect(x, 110, 290, 172, WHITE, 15, BORDER)
    b += rect(x + 17, 126, 35, 35, fill, 10)
    b += icon(key, x + 24, 133, color, 21)
    b += text(x + 64, 149, label, 10, MUTED, 650, 'letter-spacing=".8"')
    b += text(x + 19, 198, value, 21, color, 650)
    b += text(x + 19, 238, note, 11, MUTED)
save('readiness.svg', 'Stato reale della release al 2026-11-08', 'CI del milestone senza attivazione a7deb3d: 6 job verdi, 242 test Node. Bootstrap senza licenza, doctor Compose effettivo isolato e restore PostgreSQL 16 su dati CI sintetici, non sul PC destinatario. Il modello scelto è proprietario/source-available: uso privato non commerciale gratuito, altri usi su accordo commerciale. Non è open source. OpenWA rimosso; nuovo provider whatsapp-web.js Apache-2.0. Test Node locali: 242, zero skip. Audit: 19 rilievi, 11 elevati, zero critici. La CI del milestone non sostituisce quella dei commit successivi. Restano i collaudi reali. Questi numeri sono uno snapshot, non un controllo live.', 1280, 328, b)

print(f'Generated 6 self-contained SVG assets in {OUT}')
