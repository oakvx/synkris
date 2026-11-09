# Primo rilascio synk e pubblicazioni automatiche

Stato al **9 novembre 2026**. Il progetto è ancora
`1.2.0-rc.6`, **solo collaudo**. La CI non equivale a un test su
Windows/Docker Desktop con i provider reali.

## Schema di pubblicazione

Il workflow
[Prerelease and Weekly Release](../.github/workflows/prerelease.yml)
si occupa automaticamente di:

| Evento | Cosa genera | Visibilità |
| --- | --- | --- |
| Ogni push/merge su `master` | Tag `v1.2.0-rc.6-commit.<SHA40>`, ZIP + checksum + manifest | **Prerelease pubblica** |
| Ogni lunedì alle **06:17 UTC** | Tag `v1.2.0-rc.6-weekly.AAAAwSS` dall'ultimo commit di `master` | **GitHub Release pubblica**, indicata come RC di collaudo, non "Latest" |
| Avvio manuale `artifacts-only` | ZIP, checksum e manifest come artifact della CI | Senza pubblicazione |
| Avvio manuale `draft-rc` | Bozza del tag canonico `v1.2.0-rc.6` | **Bozza non pubblica** |

La pubblicazione automatica avviene **solo dopo** che sono riusciti tutti
i job Node.js 22/24, PHP/PostgreSQL, Windows PowerShell, Docker e i controlli
dell'archivio/manifest/SHA256. Gli audit bloccano i rilievi critici,
non tutte le vulnerabilità moderate/elevate. Per la produzione occorre
una valutazione di sicurezza separata.

Il repository e gli asset delle pubblicazioni sono **pubblici**. La
release settimanale viene costruita anche **senza nuovi commit**. I tag
non vengono spostati; un secondo tentativo per lo stesso tag è accettato
solo se rimane coerente con commit, stato e allegati precedenti.

La pubblicazione non installa il software sui PC dei saloni, non emette
attivazioni e non fa promozioni automatiche a una versione stabile.

## Che cosa contiene il download

- `synk-1.2.0-rc.6.zip` — contenuto piatto, con
  `INSTALLA_SYNK.bat` e `AVVIA_SYNK.bat`, dashboard,
  bot, Docker/Compose, guide, licenza.
- `synk-1.2.0-rc.6.zip.sha256` — controllo dell'integrità.
- `RELEASE-MANIFEST.json` — sorgente esatta e hash dei file.

Non sono inclusi licenze cliente, QR, sessioni WhatsApp,
`secrets/`, `runtime/`, database, password, Google service account,
Docker Desktop/WSL2 o un EXE standalone.

## Primo collaudo

1. Aprire [GitHub Releases](https://github.com/oakvx/synkris/releases)
   e scegliere una prerelease riferita al commit desiderato oppure
   la release settimanale.
2. Confrontare il checksum dell'archivio con il file SHA256 della stessa
   pubblicazione e verificare che il manifest riporti il commit corretto.
3. Estrarre tutto in una cartella Windows locale dedicata e leggere
   `PRIMO_AVVIO.txt`.
4. Avviare `INSTALLA_SYNK.bat` sul PC di **collaudo** con Docker Desktop/
   WSL2, licenza di test, account WhatsApp dedicato e calendari di prova.
5. Usare `AVVIA_SYNK.bat` per gli avvii successivi e completare
   [COLLAUDO.md](../COLLAUDO.md).
6. Non utilizzare dati personali reali prima del collaudo completo e
   dell'accordo commerciale/licenza appropriati.

La procedura per aggiornare un'installazione precedente può richiedere una
migrazione assistita: le vecchie allowlist non riconoscono tutti i nuovi
launcher. **Non eliminare volumi, cartelle, segreti o sessioni per forzare
l'aggiornamento.** Consultare
[RELEASE.md](../RELEASE.md) e
[WHATSAPP_MIGRATION.md](WHATSAPP_MIGRATION.md).

## Limiti ancora aperti

- Associazione WhatsApp Web e QR reali, riconnessione e revoca.
- Google Calendar: conflitti, idempotenza, sincronizzazione e disconnessioni.
- Windows reale: avvio Docker Desktop, COM, file e policy locali.
- Sandbox Chromium, backup/restore PostgreSQL, recupero dopo errori.
- Revisione delle vulnerabilità e licenze dei componenti di terzi.
- Licenza firmata/HWID, condizioni commerciali e protezione dei dati.

L'audit dell'8 novembre 2026 registrava 11 vulnerabilità elevate, 8
moderate e nessuna critica. È una fotografia storica, **non**
una certificazione della versione corrente. Controllare ogni CI.

Per i dettagli:
[RELEASE.md](../RELEASE.md),
[COLLAUDO.md](../COLLAUDO.md),
[SECURITY.md](../SECURITY.md).
